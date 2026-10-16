'use strict';
const {tenantUrl,urlFor,SAFE} = require('./core');
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal?.aborted) return reject(new Error('Cancelled'));
  const abort=()=>{clearTimeout(t);reject(new Error('Cancelled'));};
  const t=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  signal?.addEventListener('abort',abort,{once:true});
});
class ApiError extends Error {
  constructor(status,requestId,endpoint) {
    const hint={400:'Check request values against the operation schema.',401:'Credentials expired or are invalid. Update environment credentials.',403:'Check token scopes, user role, and tenant feature entitlement.',404:'Check resource ID and API version availability.',409:'The resource changed or already exists.',429:'Tenant rate limit reached. Retry later.'}[status] || 'Inspect the operation documentation and tenant status.';
    super(`SailPoint HTTP ${status}${endpoint?' ('+endpoint+')':''}. ${hint}${requestId?' Request ID: '+requestId:''}`);
    this.status=status; this.requestId=requestId;
  }
}
class Client {
  constructor(credentials,options={}) { this.credentials=credentials;this.fetch=options.fetch||globalThis.fetch;this.sleep=options.sleep||sleep;this.tokens=new Map();this.inflight=new Map();this.audit=options.audit||(()=>{}); }
  clear(id) {this.tokens.delete(id);}
  async token(env,signal) {
    const cached=this.tokens.get(env.id);
    if(cached && cached.expires>Date.now()+30000) return cached.token;
    if(this.inflight.has(env.id)) return this.inflight.get(env.id);
    const pending=this.obtainToken(env,signal);
    this.inflight.set(env.id,pending);
    try{return await pending;}finally{this.inflight.delete(env.id);}
  }
  async obtainToken(env,signal) {
    const secret=await this.credentials(env.id);
    if(!secret) throw new Error('No credentials stored for this environment');
    if(secret.kind==='token') return secret.accessToken;
    const body=new URLSearchParams({grant_type:'client_credentials',client_id:secret.clientId,client_secret:secret.clientSecret});
    const res=await this.fetch(tenantUrl(env.baseUrl)+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])])});
    this.audit({environment:env.name,method:'POST',path:'/oauth/token',status:res.status});
    if(!res.ok) throw new ApiError(res.status,undefined,'POST /oauth/token');
    const data=JSON.parse((await readBytes(res,2*1024*1024)).toString('utf8'));
    if(typeof data.access_token!=='string') throw new Error('OAuth response did not contain an access token');
    this.tokens.set(env.id,{token:data.access_token,expires:Date.now()+Number(data.expires_in||300)*1000});
    return data.access_token;
  }
  async request(env,options) {
    const method=options.method||'GET';
    if(env.readOnly && !SAFE.has(method) && !options.nonMutatingJob) throw new Error(`${env.name} is read-only. Enable writes in environment settings first.`);
    const url=urlFor(env.baseUrl,options.version||'v2026',options.path,options.pathParams,options.query);
    const headers={Accept:'application/json',...(options.headers||{})};
    for(const h of Object.keys(headers)) if(/^(authorization|host|cookie|proxy-authorization|connection|content-length|transfer-encoding)$/i.test(h)) throw new Error(`Header ${h} cannot be overridden`);
    const start=Date.now();
    for(let attempt=0;attempt<4;attempt++) {
      const token=await this.token(env,options.signal);
      let res;
      try {
        res=await this.fetch(url,{method,headers:{...headers,Authorization:`Bearer ${token}`},body:options.body,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(60000),...(options.signal?[options.signal]:[])])});
      } catch(error) {
        this.audit({environment:env.name,method,path:options.path,status:'NETWORK_ERROR',durationMs:Date.now()-start});
        throw new Error(`Request failed or was cancelled. ${SAFE.has(method)?'You can retry.':'The server may have accepted this write; check its state before retrying.'}`);
      }
      const requestId=res.headers.get('x-request-id')||res.headers.get('x-correlation-id');
      this.audit({environment:env.name,method,path:options.path,status:res.status,durationMs:Date.now()-start,requestId});
      // Never replay writes, including job submissions; acceptance may be ambiguous.
      if(SAFE.has(method) && attempt<3 && (res.status===429 || res.status===503)) {
        const retry=res.headers.get('retry-after');
        const delay=retry ? (/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())) : 500*2**attempt;
        if(!Number.isFinite(delay) || delay>30000) throw new ApiError(res.status,requestId,`${method} /${options.version||'v2026'}${options.path}`);
        await res.body?.cancel(); await this.sleep(Math.max(delay,100),options.signal);continue;
      }
      if(!res.ok) {await res.body?.cancel();if(res.status===401)this.clear(env.id);throw new ApiError(res.status,requestId,`${method} /${options.version||'v2026'}${options.path}`);}
      const bytes=await readBytes(res,Math.min(100*1024*1024,options.maxResponseBytes||100*1024*1024));
      const contentType=res.headers.get('content-type')||'';
      let data=bytes;
      if(options.rawText)data=bytes.toString('utf8');
      else if(contentType.includes('json') && bytes.length) {try{data=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Server returned malformed JSON');}}
      else if(contentType.startsWith('text/'))data=bytes.toString('utf8');
      else if(!bytes.length)data=null;
      return {status:res.status,headers:Object.fromEntries([...res.headers].filter(([k])=>!/(cookie|authorization|token)/i.test(k))),data,bytes};
    }
  }
}
async function readBytes(res,max) {
  if(Number(res.headers.get('content-length'))>max) {await res.body?.cancel();throw new Error('Response exceeds 100 MB limit; narrow the request');}
  if(!res.body)return Buffer.alloc(0);
  const reader=res.body.getReader(),chunks=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new Error('Response exceeds size limit');}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
async function pollJob(client,env,version,kind,id,signal,report=()=>{},timeoutMs=600000) {
  if(typeof id!=='string'||!id)throw new Error('Job response did not contain a jobId');
  const started=Date.now();
  while(Date.now()-started<timeoutMs) {
    if(signal?.aborted)throw new Error(`Stopped waiting. Server ${kind} job ${id} may still be running; use Resume Job.`);
    const result=await client.request(env,{version,path:`/sp-config/${kind}/{id}`,pathParams:{id},signal});
    const status=result.data?.status;
    report(`${kind} ${id}: ${status}`);
    if(status==='COMPLETE')return result.data;
    if(status==='FAILED'||status==='CANCELLED')throw new Error(`SP-Config ${kind} job ${id} ended with ${status}; use Resume Job to inspect details.`);
    if(!['NOT_STARTED','IN_PROGRESS'].includes(status))throw new Error(`Unrecognized job state: ${status}`);
    await client.sleep(1500,signal);
  }
  throw new Error(`Stopped waiting after 10 minutes. Server job ${id} may still be running; use Resume Job.`);
}
function importForm(bundle) {
  const form=new FormData();
  form.append('data',new Blob([JSON.stringify(bundle)],{type:'application/json'}),'import.json');
  form.append('options',JSON.stringify({excludeBackup:false}));
  return form;
}
module.exports={Client,ApiError,pollJob,importForm,readBytes,sleep};
