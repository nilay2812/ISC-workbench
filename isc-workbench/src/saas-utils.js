'use strict';
const {redact}=require('./core');
const COMMANDS=['std:test-connection','std:account:list','std:account:read','std:account:discover-schema','std:entitlement:list','std:entitlement:read','std:spec:read','std:config-options:read','std:source-data:discover','std:source-data:read','std:account:create','std:account:update','std:account:delete','std:account:enable','std:account:disable','std:account:unlock','std:change-password','std:authenticate','std:agent:list','std:machine-identity:list','std:resource:list'];
const secretKey=/password|passwd|secret|token|api.?key|authorization|credential|private.?key/i;
function secretValues(object,result=[]){if(object&&typeof object==='object')for(const [key,value]of Object.entries(object)){if(secretKey.test(key)&&typeof value==='string'&&value.length)result.push(value);else if(value&&typeof value==='object')secretValues(value,result);}return result;}
function safeText(value,secrets=[]){
  const scrub=o=>Array.isArray(o)?o.map(scrub):o&&typeof o==='object'?Object.fromEntries(Object.entries(o).map(([k,v])=>[k,secretKey.test(k)?'[REDACTED]':scrub(v)])):o;
  let text=typeof value==='string'?value:JSON.stringify(scrub(redact(value)));
  for(const secret of [...new Set(secrets)].sort((a,b)=>b.length-a.length))if(secret)text=text.split(secret).join('[REDACTED]');
  return String(text??'').replace(/Bearer\s+[^\s"',}]+/gi,'Bearer [REDACTED]').replace(/((?:password|passwd|client_secret|clientSecret|access_token|accessToken|token|apiKey|api_key|secret)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1[REDACTED]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').slice(0,100000);
}
function formatLog(log,secrets=[]){
  let value=log.message;try{if(typeof value==='string')value=JSON.parse(value);}catch{}
  const stamp=Number.isFinite(Date.parse(log.timestamp))?new Date(log.timestamp).toISOString():'unknown time';
  return safeText(`${stamp} ${String(log.level||'INFO').toUpperCase()} [${log.event||'connector'}] ${safeText(value,secrets)}`,secrets);
}
function parseFrames(text){
  if(typeof text!=='string')return [text];
  try{return [JSON.parse(text)];}catch{}
  return text.split(/\r?\n/).filter(line=>line.trim()).map(line=>{try{return JSON.parse(line.replace(/^data:\s*/,''));}catch{return line;}});
}
function failedFrame(value){if(!value||typeof value!=='object')return false;return Object.entries(value).some(([k,v])=>((k==='error'||k==='errors')&&(Array.isArray(v)?v.length>0:!!v))||(/^(status|state|type)$/i.test(k)&&typeof v==='string'&&/^(error|failed|failure)$/i.test(v))||(k==='success'&&v===false)||(v&&typeof v==='object'&&failedFrame(v)));}
function parseEnv(text){
  const result=Object.create(null);
  for(const line of text.split(/\r?\n/)){const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(!match)continue;let value=match[2].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);else value=value.replace(/\s+#.*$/,'');result[match[1]]=value;}
  return result;
}
function localUrl(port){if(!/^\d+$/.test(String(port))||Number(port)<1024||Number(port)>65535)throw new Error('Choose a local port between 1024 and 65535.');return `http://127.0.0.1:${Number(port)}/`;}
module.exports={COMMANDS,safeText,secretValues,formatLog,parseFrames,failedFrame,parseEnv,localUrl};
