'use strict';
const vscode=require('vscode');
const crypto=require('node:crypto');
const {resolve,importIssues}=require('./core');
const {shape}=require('./creation');
const {importForm}=require('./client');
class Actions {
 constructor(app){this.app=app;this.busy=new Set();}
 async notify(title,result){
  const data=result?.data??result;const failures=[];let pending=false;
  const walk=(value)=>{if(!value||typeof value!=='object')return;for(const [key,v]of Object.entries(value)){if((/^(errors|errorMessages)$/i.test(key)&&Array.isArray(v)&&v.length)||(/^error$/i.test(key)&&v)||(/^(success|successful)$/i.test(key)&&v===false)||(/^(status|state|result)$/i.test(key)&&typeof v==='string'&&/^(failed|failure|error|cancelled)$/i.test(v)))failures.push(key);if(/^(status|state)$/i.test(key)&&typeof v==='string'&&/^(pending|running|in_progress|queued|started)$/i.test(v))pending=true;if(v&&typeof v==='object')walk(v);}};walk(data);
  if(failures.length){await vscode.window.showErrorMessage(`${title} failed: ISC reported an unsuccessful result. Check the source configuration and tenant task history for details.`);return false;}
  const job=data?.taskId||data?.jobId||data?.task?.id;
  void vscode.window.showInformationMessage(`${title}: ${job||pending||result?.status===202?'submitted; processing may still be running. Check tenant task history.':'completed.'}`);return true;
 }
 configType(node){
  const route=node.route||node.resource?.path.replace(/\/\{[^}]+\}$/,'');
  return {'/sources':'SOURCE','/transforms':'TRANSFORM','/roles':'ROLE','/access-profiles':'ACCESS_PROFILE','/connector-rules':'CONNECTOR_RULE','/workflows':'WORKFLOW','/identity-profiles':'IDENTITY_PROFILE','/form-definitions':'FORM_DEFINITION','/workgroups':'GOVERNANCE_GROUP'}[route];
 }
 async exportBundle(node,signal,report){
  const app=this.app,env=app.env(node.env.id),type=this.configType(node);if(!type)throw new Error(`${node.label} has no supported SP-Config export mapping.`);
  const options={includeTypes:[type]};if(node.resource){if(!node.apiId)throw new Error(`No API ID available for ${node.label}.`);options.objectOptions={[type]:{includedIds:[node.apiId]}};}
  const exported=await app.promotions.export(env,'beta',options,signal,report);
  if(!Array.isArray(exported.data?.objects)||exported.data.objects.some(o=>!o.self||!o.object))throw new Error('SP-Config returned an invalid export envelope. Nothing was saved.');
  if(node.resource&&(exported.data.objects.length!==1||exported.data.objects[0].self.id!==node.apiId||exported.data.objects[0].self.type!==type))throw new Error(`SP-Config did not export exactly ${node.label}. Nothing was saved.`);
  return exported;
 }
 async export(node){
  const app=this.app;app.trust();const config=!!this.configType(node);
  const uri=await vscode.window.showSaveDialog({saveLabel:config?`Export ${node.label} as SP-Config`:`Export ${node.label} as JSON`,filters:{JSON:['json']}});if(!uri)return;
  let data;if(config)data=(await app.promotions.progress(`Exporting ${node.label}`,async(signal,report)=>this.exportBundle(node,signal,report))).data;
  else {const env=app.env(node.env.id);data=node.resource?(await app.readResource(env,node.resource)).data:await app.listObjects(env,node.route,node.params);}
  await vscode.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify(data,null,2)+'\n'));void vscode.window.showInformationMessage(`Exported ${node.label}${config?' as SP-Config':' as API JSON (not SP-Config)'}.`);
 }
 async remove(node){
  const app=this.app;app.trust();const env=app.env(node.env.id);if(env.readOnly)throw new Error('Unlock the environment before deleting a resource.');
  const {version,path,params}=node.resource,op=app.findOp(version,'DELETE',path);if(!op)throw new Error('This resource does not support direct deletion.');
  const typed=await vscode.window.showInputBox({title:`Delete ${node.label} from ${env.name}`,prompt:'This changes the tenant. Type the exact resource name to delete it.'});if(typed!==node.label)return;
  const draft=app.catalog.draft(op.key,env.id);if(app.catalog.operation(op.key).request?.required)throw new Error('This deletion requires additional inputs. Use Resource API Actions.');
  const result=await app.client.request(app.env(env.id),{method:'DELETE',version,path,pathParams:params,headers:draft.headers,query:draft.query});await this.notify(`Delete ${node.label}`,result);app.envTree.refresh();
 }
 async enabled(node,enabled){
  const app=this.app;app.trust();const env=app.env(node.env.id);if(env.readOnly)throw new Error('Environment is read-only.');
  if(await vscode.window.showWarningMessage(`${enabled?'Enable':'Disable'} ${node.label} in ${env.name}?`,{modal:true},'Continue')!=='Continue')return;
  const current=(await app.readResource(env,node.resource)).data;
  await app.saveResource({environmentId:env.id,...node.resource,original:current,remote:current},JSON.stringify({...current,enabled}));void vscode.window.showInformationMessage(`${node.label} ${enabled?'enabled':'disabled'}.`);
 }
 async copySourceTargetName(node){
  const app=this.app;app.trust();if(!node?.resource||node.resource.path!=='/sources/{id}')throw new Error('Select a source.');
  const env=app.env(node.env.id),source=(await app.readResource(env,node.resource)).data;
  const valid=value=>typeof value==='string'&&/\[source-[^\]\r\n]+\]$/.test(value);
  let name=valid(source.name)?source.name:undefined;
  if(!name){
   const result=await app.client.request(env,{version:node.resource.version,path:'/task-status',query:{filters:'sourceId eq '+JSON.stringify(node.apiId)+' and type eq "CLOUD_ACCOUNT_AGGREGATION"',sorters:'-created',limit:100}});
   name=(Array.isArray(result.data)?result.data:[]).map(task=>task.target?.name).find(valid);
  }
  if(!name)throw new Error('No source target name was returned in the source or its recent aggregation task history. Run an account aggregation using the existing source action, then retry after ISC records the task. No name was guessed and no aggregation was started.');
  await vscode.env.clipboard.writeText(name);void vscode.window.showInformationMessage(`Copied source target name: ${name}`);return name;
 }
 async clone(node){
  const app=this.app;app.trust();const env=app.env(node.env.id);if(env.readOnly)throw new Error('Unlock the environment before cloning.');
  const key=env.id+node.apiId;if(this.busy.has(key))throw new Error('A clone of this resource is already running.');
  const name=await vscode.window.showInputBox({title:`Clone ${node.label} in ${env.name}`,value:node.label+' Copy',validateInput:v=>!v.trim()||v.trim()===node.label?'Enter a different name':null});if(!name?.trim())return;
  if(this.busy.has(key))throw new Error('A clone of this resource is already running.');
  this.busy.add(key);try{
   if(node.resource.path==='/sources/{id}')return await this.cloneSource(node,name.trim());
   const route=node.resource.path.replace(/\/\{[^}]+\}$/,''),meta=app.findOp(node.resource.version,'POST',route);if(!meta)throw new Error('No supported creation endpoint for cloning this resource.');
   const op=app.catalog.operation(meta.key),media=Object.keys(op.request?.content||{}).find(k=>k.includes('json'));if(!media)throw new Error('This resource cannot be cloned as JSON.');
   const original=(await app.readResource(env,node.resource)).data,schema=shape(op.spec,op.request.content[media].schema),body={};
   for(const [k,v]of Object.entries(original))if(schema.properties?.[k]&&!resolve(op.spec,schema.properties[k])?.readOnly&&!['id','created','modified','accessModelMetadata'].includes(k))body[k]=v;
   body.name=name.trim();if(Object.hasOwn(body,'enabled'))body.enabled=false;
   const entry={environmentId:env.id,draftId:crypto.randomUUID(),operation:meta.key,initialText:JSON.stringify(body),createState:'draft',path:route,version:op.version,params:{}};
   await app.creation.submit(entry,JSON.stringify(body));void vscode.window.showInformationMessage(`Cloned ${node.label} as ${name.trim()}${Object.hasOwn(body,'enabled')?' (disabled)':''}.`);
  }finally{this.busy.delete(key);}
 }
 async cloneSource(node,name){
  const app=this.app,env=app.env(node.env.id),version='beta';
  if(await vscode.window.showWarningMessage(`Clone SOURCE configuration as ${name} in ${env.name}? This copies the SP-Config source object. External password policies, sync groups, connector files and machine subtypes are not copied.`,{modal:true},'Clone')!=='Clone')return;
  if((await app.listObjects({...env,version},'/sources')).some(o=>o.name===name||o.displayName===name))throw new Error('A source with that name already exists. Choose a new name to avoid updating it.');
  await app.promotions.progress(`Cloning ${node.label}`,async(signal,report)=>{
   const exported=await this.exportBundle(node,signal,report);
   const bundle=structuredClone(exported.data);if(bundle.objects?.length!==1||bundle.objects[0].self?.id!==node.apiId)throw new Error('Export did not return exactly the selected source. Clone stopped.');
   const object=bundle.objects[0];if(object.signature||object.object?.signature)throw new Error('Signed source configurations cannot be renamed for cloning.');
   const id=crypto.randomUUID().replaceAll('-','');object.self={...object.self,id,name};object.object={...object.object,id,name};if(object.object.connectorAttributes)object.object.connectorAttributes.cloudDisplayName=name;
   if(bundle.options?.objectOptions?.SOURCE)bundle.options.objectOptions.SOURCE={includedIds:[id]};
   const options={headers:{},body:importForm(bundle)};
   let preview;try{preview=await app.promotions.job(app.env(env.id),version,'import',{...options,query:{preview:true}},signal,report);}catch(e){throw new Error(`Clone preview for ${node.label} failed. No apply request was sent. ${e.message}`);}if(preview.status!=='COMPLETE'||importIssues(preview.data).errors.length)throw new Error('Source clone preview failed. Nothing was imported. Check source dependencies and permissions.');
   let result;try{result=await app.promotions.job(app.env(env.id),version,'import',{body:importForm(bundle)},signal,report);}catch(e){throw new Error(`Clone import for ${name} could not be confirmed. Check the tenant before retrying. ${e.message}`);}
   if(result.status!=='COMPLETE'||importIssues(result.data).errors.length)throw new Error('Source clone import reported errors and may be partial. Inspect the tenant before retrying.');
   app.envTree.refresh();void vscode.window.showInformationMessage(`Cloned SOURCE configuration as ${name}. Verify connector credentials and ancillary settings before use.`);
  });
 }
}
module.exports={Actions};
