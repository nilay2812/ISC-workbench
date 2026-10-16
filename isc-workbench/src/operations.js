'use strict';
const vscode=require('vscode');
const {hash}=require('./core');
const {safeText,secretValues}=require('./saas-utils');
const GROUPS=[['Aggregation Jobs','jobs','/task-status',{filters:'type eq "CLOUD_ACCOUNT_AGGREGATION"',sorters:'-created'}],['Certifications','campaigns','/campaigns',{sorters:'name'}],['Provisioning Activities','activities','/account-activities',{sorters:'-created'}],['Workflow Runs','workflows','/workflows',{}]];
function readable(value,depth=0,secrets=[]){
 if(depth>12)return '[Further nested details omitted]';
 if(value===null||typeof value!=='object')return safeText(String(value??'—'),secrets);
 return Object.entries(value).map(([key,v])=>`${'  '.repeat(depth)}${key.replace(/([a-z])([A-Z])/g,'$1 $2')}: ${/password|passwd|secret|token|api.?key|authorization|credential|private.?key/i.test(key)?'[REDACTED]':v&&typeof v==='object'?'\n'+readable(v,depth+1,secrets):safeText(String(v??'—'),secrets)}`).join('\n');
}
class Operations{
 constructor(app){this.app=app;this.changed=new vscode.EventEmitter();this.onDidChangeTreeData=this.changed.event;this.cache=new Map();this.roots=new Map();this.monitors=new Map();this.channels=new Map();this.timer=(fn,ms)=>setTimeout(fn,ms);this.clearTimer=id=>clearTimeout(id);
  app.context.subscriptions.push(this);
  for(const [name,fn]of Object.entries({opsRefresh:n=>this.refresh(n),opsDetails:n=>this.details(n),opsFilter:n=>this.filter(n)}))app.command(name,fn);
 }
 item(label,state,props={}){return Object.assign(new vscode.TreeItem(String(label),state),props);}
 getTreeItem(n){return n;}
 getParent(){return undefined;}

 group(env,kind,route,query={},label){return this.item(label||kind,1,{env,kind,route,query,offset:0,contextValue:'iscOpsFolder',iconPath:new vscode.ThemeIcon('folder')});}
 refresh(node){this.cache.clear();if(this.scope&&!this.app.envs().some(e=>e.id===this.scope.env.id))this.scope=undefined;for(const [key,s]of this.monitors)if(!this.app.envs().some(e=>e.id===s.env.id))this.stopKey(key);this.changed.fire();this.app.envTree.changed.fire(node);}
 async get(env,route,params={},query={},signal){this.app.trust();env=this.app.env(env.id);if(!this.app.findOp(env.version,'GET',route))throw new Error(`This operation is unavailable in ${env.version}.`);return this.app.client.request(env,{version:env.version,method:'GET',path:route,pathParams:params,query,signal,maxResponseBytes:5*1024*1024});}
 async getChildren(n){
  if(!n)return this.scope?[this.scope]:this.app.envs().sort((a,b)=>this.app.compareLabels(a.name,b.name)).map(env=>{if(!this.roots.has(env.id))this.roots.set(env.id,this.item(env.name,1,{env,kind:'environment',id:'operations:'+env.id,iconPath:new vscode.ThemeIcon('organization')}));return Object.assign(this.roots.get(env.id),{env,label:env.name});});
  if(n.kind==='environment')return GROUPS.map(([name,kind,route,q])=>this.group(n.env,kind,route,q,name));
  if(n.kind==='campaign')return [this.item('Campaign Details',0,{env:n.env,route:'/campaigns/{id}',params:{id:n.object.id},command:{command:'iscWorkbench.opsDetails',title:'Campaign details',arguments:[{...n,route:'/campaigns/{id}',params:{id:n.object.id}}]}}),this.item('Report Status',0,{command:{command:'iscWorkbench.opsDetails',title:'Report status',arguments:[{...n,label:'Campaign Reports',route:'/campaigns/{id}/reports',params:{id:n.object.id}}]}})];
  if(n.kind==='workflow')return [this.group(n.env,'executions','/workflows/{id}/executions',{},'All Executions'),this.group(n.env,'executions','/workflows/{id}/executions',{filters:'status eq "Failed"'},'Failed Executions')].map(row=>Object.assign(row,{params:{id:n.object.id}}));
  if(n.contextValue!=='iscOpsFolder')return [];
  const key=JSON.stringify([n.env.id,n.env.version,n.route,n.params,n.query,n.offset]);if(this.cache.has(key))return this.cache.get(key);
  try{
   const response=await this.get(n.env,n.route,n.params,{...n.query,limit:50,offset:n.offset});if(!Array.isArray(response.data))throw new Error('The service returned an unexpected list format.');
   const rows=response.data,signature=hash(rows);if(rows.length&&n.seen?.includes(signature))throw new Error('The service repeated a page. Refresh or narrow the filter.');
   const items=rows.map(o=>this.row(n,o));if(!rows.length)items.push(this.item('No results for this page/filter',0));
   if(rows.length){if(n.offset+rows.length>=10000)items.push(this.item('10,000-row limit reached. Narrow the filter.',0));else items.push(this.group(n.env,n.kind,n.route,n.query,'Next Page…'));const next=items.at(-1);if(next.contextValue==='iscOpsFolder')Object.assign(next,{params:n.params,offset:n.offset+rows.length,seen:[...(n.seen||[]),signature]});}
   this.cache.set(key,items);return items;
  }catch(e){return [this.item(e.status===403?'Access denied. Check the PAT owner’s permissions.':e.status===404?'Endpoint or item unavailable in this tenant.':e.message,0,{iconPath:new vscode.ThemeIcon('warning')})];}
 }
 row(parent,o){
  const kind={jobs:'job',activities:'activity',workflows:'workflow',executions:'execution',campaigns:'campaign'}[parent.kind];
  const label=kind==='execution'?`${o.startTime||'Execution'} — ${o.status||'Unknown'}`:o.name||o.type||o.id||'Item';
  const progress=kind==='campaign'&&o.totalCertifications!=null?`${o.completedCertifications??0}/${o.totalCertifications} complete`:'';
  const description=[o.completionStatus||o.executionStatus||o.status,progress,kind==='campaign'&&o.deadline?'due '+o.deadline.slice(0,10):undefined].filter(Boolean).join(' · ');
  const node=this.item(label,['campaign','workflow'].includes(kind)?1:0,{env:parent.env,kind,object:o,description,contextValue:'iscOps'+kind,iconPath:new vscode.ThemeIcon(o.errors?.length||/failed|error/i.test(description)?'warning':'list-tree'),tooltip:`ID: ${o.id||'not returned'}\n${description}`});
  if(o.id&&!['campaign','workflow'].includes(kind))node.command={command:kind==='job'?'iscWorkbench.opsMonitor':'iscWorkbench.opsDetails',title:'Open details',arguments:[node]};return node;
 }
 output(env){const key=env.id;if(!this.channels.has(key))this.channels.set(key,vscode.window.createOutputChannel(`ISC Operations — ${env.name}`));const c=this.channels.get(key);c.show(true);return c;}
 async details(n){if(!n?.env)throw new Error('Select an Operations item.');const routes={activity:'/account-activities/{id}',execution:'/workflow-executions/{id}/history-v2',job:'/task-status/{id}'};const route=n.route||routes[n.kind];const result=await this.get(n.env,route,n.params||{id:n.object.id});const secrets=secretValues(await this.app.client.credentials(n.env.id));const channel=this.output(n.env);channel.clear();channel.appendLine(`${n.label||n.kind}\n${new Date().toISOString()}\n`);const text=readable(result.data,0,secrets);channel.appendLine(text.slice(0,100000)+(text.length>100000?'\n[Display truncated at 100,000 characters]':''));}
 async filter(n){if(!n?.route)return;const value=await vscode.window.showInputBox({title:`Filter ${n.label}`,prompt:n.kind==='activities'?'API filter: type or created/modified date. Status filtering is not supported by this endpoint.':'ISC API filter expression; empty clears it.',value:n.query?.filters||''});if(value===undefined)return;n.query={...n.query};if(value.trim())n.query.filters=value.trim();else delete n.query.filters;n.offset=0;n.seen=[];this.refresh(n);}
 async monitor(n){if(!n?.object?.id)throw new Error('Select an aggregation job.');this.app.trust();const env=this.app.env(n.env.id),key=env.id+':'+n.object.id;if(this.monitors.has(key)){this.output(env);return;}
  const state={env,controller:new AbortController(),channel:this.output(env),id:n.object.id};this.monitors.set(key,state);state.channel.appendLine(`Monitoring ${n.label} (${state.id}). Counts cover new, changed and deleted accounts, not the full source inventory.`);
  let polls=0;const finish=()=>{if(this.monitors.get(key)===state)this.stopKey(key);};
  const poll=async()=>{try{const {data}=await this.get(env,'/account-aggregations/{id}/status',{id:state.id},{},state.controller.signal);if(state.controller.signal.aborted)return;if(!data||typeof data.status!=='string')throw new Error('Aggregation service returned no status.');const text=`${data.status} · accounts ${data.processedAccounts??'—'}/${data.totalAccounts??'—'} · deleted ${data.deletedAccounts??'—'}/${data.totalAccountsMarkedForDeletion??'—'} · identities ${data.processedIdentities??'—'}/${data.totalIdentities??'—'}`;state.channel.appendLine(`${new Date().toISOString()} — ${text}`);n.description=text;this.changed.fire(n);
   if(['COMPLETED','CANCELLED','TERMINATED','NOT_FOUND'].includes(data.status)){finish();await vscode.window.showInformationMessage(`Aggregation ${data.status}. Completion does not guarantee an error-free run; inspect task details.`);}else if(++polls>=1200){finish();await vscode.window.showInformationMessage('Stopped monitoring after 1,200 checks. The aggregation continues in ISC.');}else state.timer=this.timer(()=>{void poll();},3000);
  }catch(e){if(!state.controller.signal.aborted)await vscode.window.showErrorMessage(`Aggregation monitoring stopped: ${e.message}`);finish();}};await poll();
 }
 stop(n){if(n?.object?.id)this.stopKey(n.env.id+':'+n.object.id);}
 stopKey(key){const s=this.monitors.get(key);if(!s)return;s.controller.abort();if(s.timer)this.clearTimer(s.timer);this.monitors.delete(key);}
 dispose(){for(const key of [...this.monitors.keys()])this.stopKey(key);for(const c of this.channels.values())c.dispose();this.cache.clear();this.changed.dispose();}
}
module.exports={Operations,readable};
