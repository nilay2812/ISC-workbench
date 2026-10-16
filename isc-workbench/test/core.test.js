'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Catalog,resolve,validate,tenantUrl,urlFor,serializeQuery,redact,comparison,applyMappings,importIssues}=require('../src/core');
const {Client,ApiError,pollJob,importForm}=require('../src/client');
const catalog=new Catalog(path.join(__dirname,'../resources'));
const env={id:'a',name:'Sandbox',baseUrl:'https://sandbox.api.identitynow.com',readOnly:false};
const reply=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const bundle=objects=>({version:1,objects:objects.map(([name,id,value])=>({version:1,self:{type:'TRANSFORM',name,id},object:{name,attributes:{value}}}))});

test('every official operation resolves and generates an editable draft',()=>{
  assert.equal(catalog.index.operations.length,3315);
  assert.equal(catalog.index.versions.v2026.operations,864);
  const keys=new Set();for(const meta of catalog.index.operations){assert(!keys.has(meta.key));keys.add(meta.key);const op=catalog.operation(meta.key);assert(op.definition.responses);const draft=catalog.draft(meta.key,env.id);assert.equal(draft.operation,meta.key);assert.doesNotThrow(()=>JSON.stringify(draft));}
});
test('all bundled schema references resolve across all versions',()=>{
  for(const v of Object.keys(catalog.index.versions)){const spec=catalog.spec(v);let count=0;const walk=o=>{if(!o||typeof o!=='object')return;if(o.$ref){assert(resolve(spec,o));count++;}for(const val of Object.values(o))walk(val);};walk(spec);assert(count>100);}
});
test('tenant origin restrictions and URL traversal defense',()=>{
  assert.equal(tenantUrl(env.baseUrl),env.baseUrl);
  for(const s of ['http://x.api.identitynow.com','https://evil.test','https://x.api.identitynow.com/v3','https://u:p@x.api.identitynow.com','https://x.api.identitynow.com:444','https://x.api.identitynow.com?q=x'])assert.throws(()=>tenantUrl(s));
  assert.throws(()=>urlFor(env.baseUrl,'v2026','/sources/{id}',{id:'..'}));
  assert.throws(()=>urlFor(env.baseUrl,'v2026','/../oauth/token'));
  const url=urlFor(env.baseUrl,'v2026','/sources/{id}',{id:'x/y?z'}, {filters:'name eq "HR"',count:true});
  assert.equal(url.origin,env.baseUrl);assert(url.pathname.includes('x%2Fy%3Fz'));assert.equal(url.searchParams.get('filters'),'name eq "HR"');
});
test('query arrays follow OpenAPI explode semantics',()=>{
  assert.deepEqual(serializeQuery([{in:'query',name:'ids',explode:false}],{ids:['a','b']}),{ids:'a,b'});
  const url=urlFor(env.baseUrl,'v2026','/search',{},serializeQuery([],{ids:['a','b']}));assert.deepEqual(url.searchParams.getAll('ids'),['a','b']);
});
test('validation handles required, nested refs, nullable, and alternatives',()=>{
  const spec={$defs:{item:{type:'object',required:['name'],properties:{name:{type:'string'},role:{enum:['admin','user']}}}}};
  assert.equal(validate(spec,{$ref:'#/$defs/item'},{name:'Nilay',role:'user'}).length,0);
  assert(validate(spec,{$ref:'#/$defs/item'},{role:'bad'}).length>=2);
  assert.deepEqual(validate(spec,{type:'string',nullable:true},null),[]);
  assert.equal(validate(spec,{oneOf:[{type:'string'},{type:'number'}]},5).length,0);
});
test('response redaction recursively removes secret values',()=>assert.deepEqual(redact({clientSecret:'secret',nested:[{password:'abc',name:'OK'}]}),{clientSecret:'[REDACTED]',nested:[{password:'[REDACTED]',name:'OK'}]}));
test('mapping is explicit, old-value checked and signed objects are immutable',()=>{
  const b=bundle([['A','1','dev']]);const mapping={pointer:'/objects/0/object/attributes/value',from:'dev',to:'prod'};
  assert.equal(applyMappings(b,[mapping]).objects[0].object.attributes.value,'prod');assert.equal(b.objects[0].object.attributes.value,'dev');
  assert.throws(()=>applyMappings(b,[{...mapping,from:'other'}]));
  assert.throws(()=>applyMappings(b,[mapping],[{objectType:'TRANSFORM',signatureRequired:true}]));
  assert.throws(()=>applyMappings(b,[{pointer:'/objects/0/object/__proto__/x',from:null,to:1}]));
  assert.throws(()=>applyMappings(b,[mapping,mapping]));
});
test('comparison detects new/changed objects and rejects duplicate target names',()=>{
  const src=bundle([['A','1','a'],['B','2','b']]);const target=bundle([['A','3','new']]);
  assert.deepEqual(comparison(src,target).map(x=>x.action),['REVIEW_UPDATE','CREATE']);
  assert.throws(()=>comparison(src,bundle([['A','1','a'],['A','2','b']])));
});
test('import errors are checked even when the job completed',()=>{
  assert.equal(importIssues({results:{TRANSFORM:{errors:[{text:'bad ref'}],warnings:[]}}}).errors.length,1);
  assert.throws(()=>importIssues({}));assert.throws(()=>importIssues({results:{TRANSFORM:{}}}));
});
test('OAuth tokens are cached and concurrent requests share the exchange',async()=>{
  let tokens=0,requests=0;const client=new Client(async()=>({kind:'pat',clientId:'client',clientSecret:'secret'}),{fetch:async(url,opts)=>{
    if(String(url).endsWith('/oauth/token')){tokens++;assert.equal(opts.redirect,'error');assert.equal(opts.body.get('grant_type'),'client_credentials');return reply({access_token:'access',expires_in:3600});}
    requests++;assert.equal(opts.headers.Authorization,'Bearer access');return reply([]);
  }});
  await Promise.all([client.request(env,{path:'/sources'}),client.request(env,{path:'/transforms'})]);assert.equal(tokens,1);assert.equal(requests,2);
});
test('read-only environment blocks writes before credentials or network access',async()=>{
  const client=new Client(()=>{throw new Error('Should not access secrets');});await assert.rejects(()=>client.request({...env,readOnly:true},{method:'POST',path:'/sources'}),/read-only/);
});
test('request cannot override credential and routing headers',async()=>{
  const c=new Client(async()=>({kind:'token',accessToken:'x'}));
  for(const header of ['Authorization','Host','Content-Length','Proxy-Authorization'])await assert.rejects(()=>c.request(env,{path:'/sources',headers:{[header]:'malicious'}}),/cannot be overridden/);
});
test('GET retries a rate limit but POST never retries',async()=>{
  let calls=0;const options={fetch:async()=>{calls++;return calls===1?reply({},429,{'retry-after':'0'}):reply([]);},sleep:async()=>{}};
  const c=new Client(async()=>({kind:'token',accessToken:'x'}),options);
  await c.request(env,{path:'/sources'});assert.equal(calls,2);
  calls=0;await assert.rejects(()=>c.request(env,{method:'POST',path:'/sources',body:'{}'}),ApiError);assert.equal(calls,1);
});
test('error messages and logs exclude credentials and response bodies',async()=>{
  const audit=[];const c=new Client(async()=>({kind:'token',accessToken:'TOPSECRET'}),{fetch:async()=>reply({clientSecret:'TOPSECRET'},403),audit:x=>audit.push(x)});
  await assert.rejects(()=>c.request(env,{path:'/sources'}),e=>!e.message.includes('TOPSECRET')&&e.status===403);assert(!JSON.stringify(audit).includes('TOPSECRET'));
});
test('network failure on write does not replay and explains uncertain acceptance',async()=>{
  let calls=0;const c=new Client(async()=>({kind:'token',accessToken:'x'}),{fetch:async()=>{calls++;throw new Error('socket closed');}});
  await assert.rejects(()=>c.request(env,{path:'/sources',method:'POST'}),/may have accepted/);assert.equal(calls,1);
});
test('polling recognizes completion, failure, and cancellation',async()=>{
  const states=['NOT_STARTED','IN_PROGRESS','COMPLETE'];const c={request:async()=>({data:{status:states.shift()}}),sleep:async()=>{}};
  assert.equal((await pollJob(c,env,'v2026','export','job')).status,'COMPLETE');
  await assert.rejects(()=>pollJob({...c,request:async()=>({data:{status:'FAILED'}})},env,'v2026','import','job'),/FAILED/);
  const ctrl=new AbortController();ctrl.abort();await assert.rejects(()=>pollJob(c,env,'v2026','export','job',ctrl.signal),/may still be running/);
});
test('import multipart preserves original envelope and always requests backup',async()=>{
  const b=bundle([['A','1','value']]),form=importForm(b);
  assert.deepEqual(JSON.parse(await form.get('data').text()),b);
  assert.deepEqual(JSON.parse(form.get('options')),{excludeBackup:false});
});
test('non-JSON downloads retain exact bytes',async()=>{
  const bytes=Buffer.from([0,1,255,128]);const c=new Client(async()=>({kind:'token',accessToken:'x'}),{fetch:async()=>new Response(bytes,{headers:{'content-type':'application/octet-stream'}})});
  assert.deepEqual((await c.request(env,{path:'/reports'})).data,bytes);
});

test('website hosts are rejected before credentials are sent',()=>{
  assert.throws(()=>tenantUrl('https://example.identitynow.com/'),/tenant website/);
  assert.equal(tenantUrl('https://example.api.identitynow.com/'),'https://example.api.identitynow.com');
});
test('OAuth errors are logged without secrets and identify the failed endpoint',async()=>{
  const audit=[];const c=new Client(async()=>({kind:'pat',clientId:'id',clientSecret:'NEVERLOG'}),{fetch:async()=>reply({},404),audit:e=>audit.push(e)});
  await assert.rejects(()=>c.token(env),/POST \/oauth\/token/);assert.equal(audit[0].path,'/oauth/token');assert(!JSON.stringify(audit).includes('NEVERLOG'));
});

test('SP-Config multipart options is a text field, data is a JSON file',async()=>{
 const form=importForm({version:1,objects:[]});const request=new Request('https://example.com',{method:'POST',body:form});const wire=await request.text();assert.match(wire,/name="data"; filename="import.json"/);assert.match(wire,/name="options"\r\n\r\n/);assert(!wire.includes('name="options"; filename='));assert(wire.includes('"excludeBackup":false'));
});
