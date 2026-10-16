'use strict';
const vscode=require('vscode');
const crypto=require('node:crypto');
const {resolve,sample,validate}=require('./core');
const transforms=require('../resources/upstream/transforms.json');
const rules=require('../resources/upstream/connector-rules.json');
const role=require('../resources/upstream/role.json');
const accessProfile=require('../resources/upstream/access-profile.json');
function shape(spec,schema){schema=resolve(spec,schema)||{};const parts=(schema.allOf||[]).map(s=>shape(spec,s));return {...schema,properties:Object.assign({},...parts.map(p=>p.properties),schema.properties),required:[...new Set([...parts.flatMap(p=>p.required||[]),...(schema.required||[])])]};}
class Cancelled extends Error{}
class Creation {
  constructor(app){this.app=app;this.busy=new Set();this.owners=new Map();}
  async pick(rows,title){const v=await vscode.window.showQuickPick(rows,{title,matchOnDescription:true});if(!v)throw new Cancelled();return v;}
  async input(title,value=''){const v=await vscode.window.showInputBox({title,value,ignoreFocusOut:true,validateInput:t=>t.trim()?null:'Required'});if(v===undefined)throw new Cancelled();return v.trim();}
  async owner(env){
    const auth=await this.app.client.credentials(env.id),key=env.id+':'+(auth?.clientId||'bearer');
    if(this.owners.has(key))return this.owners.get(key);
    if(auth?.kind==='pat'&&this.app.findOp(env.version,'GET','/personal-access-tokens')){
      try{const owner=(await this.app.listObjects(env,'/personal-access-tokens')).find(t=>t.id===auth.clientId)?.owner;if(owner?.id){const ref={type:'IDENTITY',id:owner.id,...(owner.name?{name:owner.name}:{})};this.owners.set(key,ref);return ref;}}catch(e){if(![403,404].includes(e.status))throw e;}
    }
    throw new Error('The authenticated PAT owner could not be resolved. Creation was stopped; check permission to read your personal access token metadata.');
  }
  async create(node){
    const app=this.app;app.trust();
    if(!node?.route){const env=await app.pickEnv('Create resource in environment');if(!env)return;const rows=await app.envTree.getChildren({env,contextValue:'iscEnvironmentWritable'});node=(await this.pick(rows.filter(r=>app.findOp(env.version,'POST',r.route)).map(r=>({label:r.label,node:r})),'Resource type')).node;}
    const env=app.env(node.env.id);if(env.readOnly)throw new Error('Unlock the environment before creating a resource.');
    const meta=app.findOp(env.version,'POST',node.route);if(!meta)throw new Error('No documented creation endpoint for this collection.');
    const op=app.catalog.operation(meta.key),media=Object.keys(op.request?.content||{}).find(t=>t.includes('json'));
    if(!media)throw new Error('This creation requires a file upload. Use Search All APIs.');
    const key=env.id+node.route;if(this.busy.has(key))throw new Error('A creation wizard is already open.');this.busy.add(key);
    try{
      const schema=shape(op.spec,op.request.content[media].schema),name=await this.input(`New ${node.label||'resource'} — name`);
      let body,text;
      if(node.route==='/transforms'){
        const chosen=await this.pick(Object.entries(transforms).map(([label,t])=>({label,description:t.description,template:t.newtemplate})).sort((a,b)=>app.compareLabels(a.label,b.label)),'Transform type');
        // Templates deliberately retain upstream editable placeholders. Escape only the inserted JSON string.
        text=chosen.template.replaceAll('{TRANSFORM_NAME}',JSON.stringify(name).slice(1,-1));
      }else if(node.route==='/connector-rules'){
        const chosen=await this.pick(rules.map(r=>({label:r.type,description:r.description,template:r})).sort((a,b)=>app.compareLabels(a.label,b.label)),'Connector rule type');body=structuredClone(chosen.template);body.name=name;
      }else if(node.route==='/sources'){
        let cached=app.context.globalState.get('isc.connectors.'+env.id,[]);
        if(!cached.length){await this.refreshConnectorTypes({env});cached=app.context.globalState.get('isc.connectors.'+env.id,[]);}
        if(!cached.length)throw new Error('No connector types are available to this tenant. Check connector-read access.');
        const connector=await this.pick(cached.map(c=>({label:c.type||c.name||c.scriptName,description:c.scriptName,scriptName:c.scriptName})).sort((a,b)=>app.compareLabels(a.label,b.label)),'Source connector type');
        body={name,description:'',connector:connector.scriptName,owner:await this.owner(env)};
      }else if(node.route==='/roles'||node.route==='/access-profiles'){
        body=structuredClone(node.route==='/roles'?role:accessProfile);Object.assign(body,{name,description:'',owner:{type:'IDENTITY',id:''},additionalOwners:[]});if(node.route==='/access-profiles')body.source={type:'SOURCE',id:''};
      }else if(node.route.endsWith('/schemas'))body={name,nativeObjectType:'',identityAttribute:'',displayAttribute:'',hierarchyAttribute:null,includePermissions:false,features:[],configuration:{},attributes:[]};
      else if(node.route.endsWith('/provisioning-policies')){
        const enumValues=resolve(op.spec,schema.properties.usageType)?.enum||['CREATE'];
        const usage=await this.pick(enumValues.map(value=>({label:value,value})),'Provisioning policy usage');body={name,description:null,usageType:usage.value,fields:[]};
      }else{body=sample(op.spec,op.request.content[media].schema)||{};body.name=name;const clearIds=o=>{if(o&&typeof o==='object')for(const k of Object.keys(o)){if(k==='id')o[k]='';else clearIds(o[k]);}};clearIds(body);}
      if(text){try{body=JSON.parse(text);}catch{body=JSON.parse(await this.input('Complete transform JSON',text));}}
      if(body?.owner&&!body.owner.id)body.owner=await this.owner(env);
      if(node.route==='/access-profiles'){
        const sources=await app.listObjects(env,'/sources');const selected=await this.pick(sources.map(o=>({label:o.name,id:o.id})),'Access profile source');body.source={type:'SOURCE',id:selected.id};
      }
      const complete=async(value,definition,at='')=>{
        const def=shape(op.spec,definition);if(!value||typeof value!=='object')return;
        for(const key of def.required||[]){const field=shape(op.spec,def.properties?.[key]),label=at+key;
          if(field.enum?.length&&(!value[key]||String(value[key]).startsWith('<<')))value[key]=(await this.pick(field.enum.map(v=>({label:String(v),value:v})),label)).value;
          else if(field.type==='string'&&(!value[key]||String(value[key]).startsWith('<<')))value[key]=await this.input(label);
          else if(value[key]&&typeof value[key]==='object')await complete(value[key],def.properties?.[key],label+'.');
        }
      };await complete(body,op.request.content[media].schema);
      const entry={environmentId:env.id,draftId:crypto.randomUUID(),operation:meta.key,initialText:JSON.stringify(body),createState:'draft',path:op.path,version:op.version,params:node.params||{}};
      await this.submit(entry,JSON.stringify(body));
      if(entry.createState==='created'&&!entry.uncertain)await app.openResource({env,resource:{path:entry.path,version:entry.version,params:entry.params},label:name});
      void vscode.window.showInformationMessage(`Created ${name}.`);
    }catch(e){if(!(e instanceof Cancelled))throw e;}finally{this.busy.delete(key);}
  }
  async submit(entry,text){
    const app=this.app,env=app.env(entry.environmentId);app.trust();if(env.readOnly)throw new Error('Environment is read-only');
    if(entry.createState==='submitted'||entry.createState==='unknown')throw new Error('A previous creation may have been accepted. Use Find Source or refresh the resource list before creating again. This draft will not resubmit automatically.');
    const op=app.catalog.operation(entry.operation),draft=app.catalog.draft(entry.operation,env.id);let body;
    try{body=JSON.parse(text);}catch{throw new Error('Complete the template with valid JSON before saving. No resource was created.');}
    if(body.owner && !body.owner.id)body.owner=await this.owner(env);
    // Never send sample/placeholder references as if they were real tenant IDs.
    const refs=(value,at='')=>{if(!value||typeof value!=='object')return;for(const [k,v]of Object.entries(value)){if(k==='id'&&(v===''||typeof v==='string'&&/^(<<|REPLACE)/.test(v)))throw new Error(`Set a real resource ID at ${at}/id before saving.`);refs(v,at+'/'+k);}};refs(body);
    const media=Object.keys(op.request.content).find(t=>t.includes('json'));
    const errors=validate(op.spec,op.request.content[media].schema,body);if(errors.length)throw new Error(errors.slice(0,6).join('; '));
    entry.createState='submitted';await app.files.recordDraft(entry);
    let result;
    try{result=await app.client.request(app.env(env.id),{method:'POST',version:op.version,path:op.path,pathParams:entry.params,query:draft.query,headers:{...draft.headers,'Content-Type':media},body:JSON.stringify(body)});}
    catch(error){entry.createState=error.status&&error.status<500?'draft':'unknown';await app.files.recordDraft(entry);throw error;}
    app.envTree.refresh();
    const detail=app.catalog.index.operations.find(o=>o.version===op.version&&o.method==='GET'&&o.path.startsWith(op.path+'/')&&/^\{[^}]+\}$/.test(o.path.slice(op.path.length+1)));
    const object=result.data?.data?.id?result.data.data:result.data;
    const parameter=detail&&[...detail.path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]).find(p=>!Object.hasOwn(entry.params,p));
    const id=parameter==='usageType'?object?.usageType||body.usageType:object?.id;
    if(!detail||id===undefined||id===null){entry.createState='unknown';await app.files.recordDraft(entry);throw new Error('Creation accepted, but no addressable ID was returned. Refresh the collection; this draft will not create another resource.');}
    Object.assign(entry,{path:detail.path,version:op.version,params:{...entry.params,[parameter]:id},createState:'created',original:JSON.parse(text)});
    await app.files.recordDraft(entry); // Store ID before read-back, so a failed read cannot trigger another POST.
    try{entry.remote=(await app.readResource(env,entry)).data;}
    catch{entry.uncertain=true;void vscode.window.showWarningMessage(`Created resource ${id}. Read-back failed; close and reopen this document before further editing.`);}
  }
  async refreshConnectorTypes(node){const env=node?.env?this.app.env(node.env.id):await this.app.pickEnv();if(!env)return;this.app.trust();const list=await this.app.listObjects(env,'/connectors');const rows=list.filter(c=>c.scriptName).map(({scriptName,name,type})=>({scriptName,name,type}));await this.app.context.globalState.update('isc.connectors.'+env.id,rows);void vscode.window.showInformationMessage(`Cached ${rows.length} connector types for instant source creation prompts.`);}
}
module.exports={Creation,shape};
