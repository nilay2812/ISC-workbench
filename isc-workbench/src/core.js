'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const METHODS = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE']);
const SAFE = new Set(['GET','HEAD','OPTIONS']);
function resolve(spec, value) {
  const seen = new Set();
  while (value && value.$ref) {
    if (seen.has(value.$ref)) throw new Error('Circular reference outside a schema');
    seen.add(value.$ref);
    if (!value.$ref.startsWith('#/')) throw new Error('Only bundled local schema references are supported');
    value = value.$ref.slice(2).split('/').reduce((o,k) => o?.[k.replace(/~1/g,'/').replace(/~0/g,'~')], spec);
    if (!value) throw new Error('Unresolved schema reference');
  }
  return value;
}
function sample(spec, schema, depth = 0, seen = new Set()) {
  if (!schema || depth > 7) return null;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return null;
    seen = new Set(seen).add(schema.$ref);
  }
  schema = resolve(spec, schema);
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map(s => sample(spec,s,depth+1,seen)));
  if (schema.oneOf || schema.anyOf) return sample(spec,(schema.oneOf || schema.anyOf)[0],depth+1,seen);
  if (schema.type === 'array') return [];
  if (schema.type === 'object' || schema.properties) {
    const obj = {};
    for (const [k,s] of Object.entries(schema.properties || {})) {
      if (resolve(spec,s)?.readOnly) continue;
      if ((schema.required || []).includes(k)) obj[k] = sample(spec,s,depth+1,seen);
    }
    return obj;
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 0;
  return '';
}
// OpenAPI-aware basic validation. Server remains authoritative for cross-field/business rules.
function validate(spec, schema, value, at = '$', depth = 0) {
  if (!schema || depth > 60) return [];
  schema = resolve(spec,schema);
  if (value === null && schema.nullable) return [];
  const errors = [];
  for (const part of schema.allOf || []) errors.push(...validate(spec,part,value,at,depth+1));
  if (schema.oneOf || schema.anyOf) {
    const passes = (schema.oneOf || schema.anyOf).filter(s=>!validate(spec,s,value,at,depth+1).length).length;
    // Several official transform attribute variants overlap without a discriminator.
    // Check that a branch accepts the shape; leave exclusive/business validation to ISC.
    if (!passes) errors.push(`${at}: does not match any schema alternative`);
  }
  if (schema.enum && !schema.enum.some(x=>JSON.stringify(x)===JSON.stringify(value))) errors.push(`${at}: invalid enum value`);
  const type = schema.type;
  const valid = !type || (type==='object'?value!==null && typeof value==='object' && !Array.isArray(value):type==='array'?Array.isArray(value):type==='integer'?Number.isInteger(value):typeof value===type);
  if (!valid) return [...errors, `${at}: expected ${type}`];
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: too long`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length<schema.minItems) errors.push(`${at}: too few items`);
    value.forEach((v,i)=>errors.push(...validate(spec,schema.items,v,`${at}[${i}]`,depth+1)));
  } else if (value && typeof value==='object') {
    for (const key of schema.required || []) if (!(key in value) && !resolve(spec,schema.properties?.[key])?.readOnly) errors.push(`${at}.${key}: required`);
    for (const [key,v] of Object.entries(value)) {
      const s = schema.properties?.[key];
      if (s) errors.push(...validate(spec,s,v,`${at}.${key}`,depth+1));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unknown property`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validate(spec,schema.additionalProperties,v,`${at}.${key}`,depth+1));
    }
  }
  return errors;
}
class Catalog {
  constructor(directory) { this.directory=directory; this.index=JSON.parse(fs.readFileSync(path.join(directory,'catalog.json'),'utf8')); this.cache=new Map(); }
  spec(version) {
    if (!this.index.versions[version]) throw new Error('Unknown API version');
    if (!this.cache.has(version)) this.cache.set(version,JSON.parse(fs.readFileSync(path.join(this.directory,version+'.json'),'utf8')));
    return this.cache.get(version);
  }
  operation(key) {
    const meta=this.index.operations.find(x=>x.key===key);
    if (!meta) throw new Error('Operation is not in the bundled official specifications');
    const spec=this.spec(meta.version), item=resolve(spec,spec.paths[meta.path]);
    const op=resolve(spec,item[meta.method.toLowerCase()]);
    const parameters=new Map();
    for (const p of [...(item.parameters||[]),...(op.parameters||[])]) { const r=resolve(spec,p); parameters.set(`${r.in}:${r.name}`,r); }
    return {...meta, spec, definition:op, parameters:[...parameters.values()], request:resolve(spec,op.requestBody)};
  }
  draft(key,environmentId) {
    const op=this.operation(key), draft={kind:'isc-request',environmentId,operation:key,path:{},query:{},headers:{}};
    for(const p of op.parameters) if(p.required) {
      const group=p.in==='path'?draft.path:p.in==='query'?draft.query:p.in==='header'?draft.headers:null;
      if(group) group[p.name]=p.example ?? sample(op.spec,p.schema);
    }
    if(op.request) {
      const content=op.request.content || {};
      draft.contentType=Object.keys(content).find(k=>k==='application/json') || Object.keys(content)[0];
      const media=content[draft.contentType];
      draft.body=sample(op.spec,media?.schema) ?? {};
      if(draft.contentType==='multipart/form-data') {
        const schema=resolve(op.spec,media?.schema);
        for (const [k,v] of Object.entries(schema?.properties || {})) if(resolve(op.spec,v)?.format==='binary') draft.body[k]={$file:'SELECT_LOCAL_FILE'};
      }
    }
    return draft;
  }
}
function tenantUrl(input) {
  const url=new URL(input);
  if(url.protocol!=='https:' || url.username || url.password || url.port || url.pathname!=='/' || url.search || url.hash) throw new Error('Enter an HTTPS tenant API origin without a path, port, credentials, or query');
  if(!/^[a-z0-9][a-z0-9.-]*\.(identitynow\.com|identitynow-demo\.com|sailpoint\.com)$/.test(url.hostname)) throw new Error('Use your SailPoint tenant API host, for example https://tenant.api.identitynow.com');
  if(/\.identitynow(?:-demo)?\.com$/.test(url.hostname)&&!url.hostname.includes('.api.'))throw new Error('This is a tenant website address. Enter the API host, for example https://tenant.api.identitynow.com');
  return url.origin;
}
function urlFor(base, version, route, params={}, query={}) {
  base=tenantUrl(base);
  if(!/^(v\d{1,4}|beta)$/.test(version) || !route.startsWith('/') || route.startsWith('//') || /[?#\\]/.test(route)) throw new Error('Invalid relative API path');
  const replaced=route.replace(/\{([^}]+)\}/g,(_,key)=> {
    if(params[key]===undefined || params[key]===null || params[key]==='' || /^\.{1,2}$/.test(String(params[key]))) throw new Error(`Provide path parameter ${key}`);
    return encodeURIComponent(String(params[key]));
  });
  if(replaced.split('/').some(s=>/^\.{1,2}$/.test(s))) throw new Error('Path traversal is not permitted');
  const url=new URL(`${base}/${version}${replaced}`);
  if(!url.pathname.startsWith(`/${version}/`) || url.origin!==base) throw new Error('Request escaped tenant origin');
  for(const [k,v] of Object.entries(query)) if(v!==undefined && v!==null) {
    if(Array.isArray(v)) v.forEach(x=>url.searchParams.append(k,String(x)));
    else if(typeof v==='object') for(const [child,val] of Object.entries(v)) url.searchParams.append(`${k}[${child}]`,String(val));
    else url.searchParams.set(k,String(v));
  }
  return url;
}
function serializeQuery(parameters, query) {
  const out={};
  for(const [key,value] of Object.entries(query||{})) {
    const p=parameters.find(p=>p.in==='query' && p.name===key);
    if(Array.isArray(value) && (p?.explode===false || p?.style==='spaceDelimited' || p?.style==='pipeDelimited')) out[key]=value.join(p.style==='spaceDelimited'?' ':p.style==='pipeDelimited'?'|':',');
    else out[key]=value;
  }
  return out;
}
function redact(value) {
  if(Array.isArray(value)) return value.map(redact);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/password|secret|authorization|access.?token|refresh.?token|private.?key/i.test(k)?'[REDACTED]':redact(v)]));
  return value;
}
const hash = value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function bundleCheck(bundle) {
  if(!bundle || !Array.isArray(bundle.objects) || !bundle.objects.length) throw new Error('Expected a non-empty SP-Config export with an objects array');
  for(const obj of bundle.objects) if(!obj.self?.type || !obj.self?.name || !('object' in obj)) throw new Error('Invalid SP-Config object envelope');
}
function comparison(source,target) {
  bundleCheck(source);
  const key=o=>`${o.self.type} / ${o.self.name}`;
  const targetMap=new Map();
  for(const o of target.objects || []) { const k=key(o); if(targetMap.has(k)) throw new Error(`Ambiguous target name: ${k}`); targetMap.set(k,o); }
  const seen=new Set();
  return source.objects.map(o=> {
    const k=key(o); if(seen.has(k)) throw new Error(`Ambiguous source name: ${k}`); seen.add(k);
    const existing=targetMap.get(k);
    return {object:k,action:!existing?'CREATE':hash(canonical(o.object))===hash(canonical(existing.object))?'UNCHANGED':'REVIEW_UPDATE',sourceId:o.self.id,targetId:existing?.self.id};
  });
}
function applyMappings(bundle,mappings,configs=[]) {
  bundleCheck(bundle);
  if(!Array.isArray(mappings)) throw new Error('Mappings must be an array of explicit JSON Pointer replacements');
  const copy=JSON.parse(JSON.stringify(bundle));
  const used=new Set();
  for(const m of mappings) {
    if(typeof m.pointer!=='string' || !/^\/objects\/\d+\/object\//.test(m.pointer) || used.has(m.pointer) || !Object.hasOwn(m,'from') || !Object.hasOwn(m,'to')) throw new Error('Each mapping needs a unique /objects/N/object/... pointer, from, and to');
    used.add(m.pointer);
    const segments=m.pointer.slice(1).split('/').map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'));
    if(segments.some(s=>['__proto__','prototype','constructor'].includes(s))) throw new Error('Unsafe mapping path');
    const object=copy.objects[Number(segments[1])];
    if(!object) throw new Error('Mapping object does not exist');
    if(configs.some(c=>c.objectType===object.self.type && c.signatureRequired)) throw new Error(`Cannot edit signed type ${object.self.type}`);
    let parent=copy;
    for(const s of segments.slice(0,-1)) { if(!parent || typeof parent!=='object' || !Object.hasOwn(parent,s)) throw new Error('Mapping path does not exist'); parent=parent[s]; }
    const k=segments.at(-1);
    if(!parent || !Object.hasOwn(parent,k) || JSON.stringify(parent[k])!==JSON.stringify(m.from)) throw new Error(`Mapping old value does not match at ${m.pointer}`);
    parent[k]=m.to;
  }
  return copy;
}
function importIssues(result) {
  if(!result || !result.results || typeof result.results!=='object') throw new Error('Import result has no results map; cannot establish success');
  const errors=[],warnings=[];
  for(const [type,r] of Object.entries(result.results)) {
    if(!r || !Array.isArray(r.errors)) throw new Error(`Malformed import results for ${type}`);
    for(const e of r.errors) errors.push({type,...e});
    for(const w of r.warnings || []) warnings.push({type,...w});
  }
  return {errors,warnings};
}
function jsonPatch(before,after,pointer='') {
  if(JSON.stringify(canonical(before))===JSON.stringify(canonical(after)))return [];
  const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  if(!obj(before)||!obj(after))return [{op:'replace',path:pointer,value:after}];
  const ops=[];
  for(const k of new Set([...Object.keys(before),...Object.keys(after)])){
    const p=pointer+'/'+k.replace(/~/g,'~0').replace(/\//g,'~1');
    if(!Object.hasOwn(after,k))ops.push({op:'remove',path:p});
    else if(!Object.hasOwn(before,k))ops.push({op:'add',path:p,value:after[k]});
    else ops.push(...jsonPatch(before[k],after[k],p));
  }
  return ops;
}
module.exports={jsonPatch,Catalog,resolve,sample,validate,tenantUrl,urlFor,serializeQuery,redact,hash,canonical,bundleCheck,comparison,applyMappings,importIssues,METHODS,SAFE};
