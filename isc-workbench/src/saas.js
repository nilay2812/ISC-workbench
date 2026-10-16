'use strict';
const vscode=require('vscode');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {hash}=require('./core');
const {readBytes}=require('./client');
const {COMMANDS,safeText,secretValues,formatLog,parseFrames,failedFrame,parseEnv,localUrl}=require('./saas-utils');
const ROUTES={connector:'/platform-connectors',customizer:'/connector-customizers',instance:'/connector-instances'};
class SaaS {
  constructor(app){
    this.app=app;this.changed=new vscode.EventEmitter();this.onDidChangeTreeData=this.changed.event;this.listCache=new Map();this.streams=new Map();this.channels=new Map();this.history=[];this.busy=new Set();this.timer=(fn,ms)=>setTimeout(fn,ms);this.clearTimer=id=>clearTimeout(id);this.fetch=globalThis.fetch;
    app.context.subscriptions.push(this,vscode.window.registerTreeDataProvider('iscWorkbench.saas',this));
    const commands={saasRefresh:()=>this.refresh(),saasCreateConnector:n=>this.create(n,'connector'),saasCreateCustomizer:n=>this.create(n,'customizer'),saasRename:n=>this.rename(n),saasDelete:n=>this.remove(n),saasUpload:n=>this.upload(n),saasDeploy:n=>this.deploy(n),saasLink:n=>this.link(n),saasUnlink:n=>this.link(n,true),saasLogs:n=>this.logs(n,false),saasTail:n=>this.logs(n,true),saasStopLogs:n=>this.stop(n),saasStopAllLogs:()=>this.stopAll(),saasInspect:n=>this.inspect(n),saasCopyId:n=>vscode.env.clipboard.writeText(String(n.object.id)),saasTest:n=>this.test(n),saasTestLocal:()=>this.test(undefined,true),saasReplay:()=>this.replay(),saasClearHistory:()=>{this.history=[];vscode.window.showInformationMessage('Connector test history cleared.');},saasProjectConnector:()=>this.project('connector'),saasProjectCustomizer:()=>this.project('customizer'),saasBuild:()=>this.build(),saasDebug:()=>this.build(undefined,true)};
    for(const action of ['Rename','Delete','Upload','Deploy'])commands['saas'+action+'Customizer']=commands['saas'+action];
    for(const [name,fn]of Object.entries(commands))app.command(name,fn);
  }
  refresh(){this.listCache.clear();for(const [key,s]of this.streams)if(!this.app.envs().some(e=>e.id===s.env.id))this.stopKey(key);this.changed.fire();}
  getTreeItem(node){return node;}
  item(label,state,props){return Object.assign(new vscode.TreeItem(label,state),props);}
  async getChildren(node){
    if(!node)return this.app.envs().sort((a,b)=>this.app.compareLabels(a.name,b.name)).map(env=>this.item(env.name,1,{env,contextValue:env.readOnly?'iscEnvironmentLocked':'iscEnvironmentWritable',iconPath:new vscode.ThemeIcon(env.readOnly?'lock':'unlock'),description:env.readOnly?'read-only':'writable',id:'saas:'+env.id}));
    if(node.contextValue?.startsWith('iscEnvironment'))return [['Custom Connectors','connector'],['Customizers','customizer'],['SaaS Source Instances','instance']].map(([label,kind])=>this.item(label,1,{env:node.env,kind,contextValue:'saasFolder'+kind,iconPath:new vscode.ThemeIcon('folder'),id:`saas:${node.env.id}:${kind}`}));
    if(!node.contextValue?.startsWith('saasFolder'))return [];
    try{return (await this.list(node.env,node.kind)).map(object=>{const row=this.item(object.alias||object.name||object.id,0,{env:node.env,kind:node.kind,object,contextValue:'saas'+node.kind,description:object.imageVersion?`version ${object.imageVersion}`:object.connectorCustomizerId?'customizer linked':undefined,tooltip:`${object.name||object.alias||''}\nID: ${object.id}`,iconPath:new vscode.ThemeIcon(node.kind==='instance'?'cloud':'plug'),id:`saas:${node.env.id}:${node.kind}:${object.id}`});row.command={command:'iscWorkbench.saasInspect',title:'Show details',arguments:[row]};return row;});}
    catch(e){return [this.item(e.status===403?'SaaS Connectivity access denied (403). Check the PAT owner and tenant feature access.':e.status===404?'SaaS Connectivity endpoint unavailable (404).':e.message,0,{iconPath:new vscode.ThemeIcon('warning')})];}
  }
  async request(env,method,route,{id,body,signal,bytes=false,rawText=false}={}){
    this.app.trust();const current=this.app.env(env.id);
    const logQuery=method==='POST'&&route==='/platform-logs/query';
    if(!['GET','HEAD'].includes(method)&&!logQuery&&current.readOnly)throw new Error(`Unlock ${current.name} before changing or invoking a SaaS connector.`);
    return this.app.client.request(current,{version:'beta',method,path:route,pathParams:id?{id}:{},body:body===undefined?undefined:bytes?body:JSON.stringify(body),headers:body===undefined?{}:{'Content-Type':bytes?'application/zip':'application/json'},signal,nonMutatingJob:logQuery,rawText,maxResponseBytes:5*1024*1024});
  }
  async list(env,kind,fresh=false){this.app.trust();this.app.env(env.id);const key=env.id+':'+kind,cached=this.listCache.get(key);if(!fresh&&cached&&cached.until>Date.now())return cached.promise;const promise=this.loadList(env,kind);const entry={until:Date.now()+30000,promise};this.listCache.set(key,entry);try{return await promise;}catch(e){if(this.listCache.get(key)===entry)this.listCache.delete(key);throw e;}}
  async loadList(env,kind){const result=await this.request(env,'GET',ROUTES[kind]);const rows=Array.isArray(result.data)?result.data:result.data?.items||result.data?.data;if(!Array.isArray(rows))throw new Error('SaaS Connectivity did not return a list.');return rows.filter(o=>o.id).sort((a,b)=>this.app.compareLabels(a.alias||a.name||a.id,b.alias||b.name||b.id));}
  async environment(node){return node?.env?this.app.env(node.env.id):this.app.pickEnv('SaaS Connectivity environment');}
  writable(env){this.app.trust();if(this.app.env(env.id).readOnly)throw new Error(`Unlock ${env.name} first.`);}
  async confirm(message,button='Continue'){return await vscode.window.showWarningMessage(message,{modal:true},button)===button;}
  async create(node,kind){const env=await this.environment(node);if(!env)return;this.writable(env);const name=await vscode.window.showInputBox({title:kind==='connector'?'Create SaaS Connector — alias':'Create Customizer — name',validateInput:v=>v.trim()?null:'Enter a name.'});if(!name?.trim())return;const result=await this.request(env,'POST',ROUTES[kind],{body:{[kind==='connector'?'alias':'name']:name.trim()}});await this.app.actions.notify(`Create ${name.trim()}`,result);this.refresh();}
  async rename(node){this.writable(node.env);const value=await vscode.window.showInputBox({title:`Rename ${node.label}`,value:node.label});if(!value?.trim()||value.trim()===node.label)return;await this.request(node.env,'PUT',ROUTES[node.kind]+'/{id}',{id:node.object.id,body:{[node.kind==='connector'?'alias':'name']:value.trim()}});this.refresh();await vscode.window.showInformationMessage(`Renamed to ${value.trim()}.`);}
  async remove(node){this.writable(node.env);const value=await vscode.window.showInputBox({title:`Delete ${node.label}`,prompt:`Type the exact name to delete it from ${node.env.name}.`});if(value!==node.label)return;await this.request(node.env,'DELETE',ROUTES[node.kind]+'/{id}',{id:node.object.id});this.refresh();await vscode.window.showInformationMessage(`Deleted ${node.label}.`);}
  async readFile(uri,max=5*1024*1024){const stat=await vscode.workspace.fs.stat(uri);if(stat.size>max)throw new Error(`Selected file exceeds ${Math.round(max/1024/1024)} MB.`);return Buffer.from(await vscode.workspace.fs.readFile(uri));}
  async upload(node,uri){this.writable(node.env);if(!uri)uri=(await vscode.window.showOpenDialog({title:`Upload ZIP to ${node.label}`,canSelectMany:false,filters:{ZIP:['zip']}}))?.[0];if(!uri)return;
    const bytes=await this.readFile(uri,50*1024*1024);if(bytes.length<4||bytes[0]!==0x50||bytes[1]!==0x4b)throw new Error('Select a connector/customizer ZIP bundle.');
    if(!await this.confirm(`Upload ${path.basename(uri.fsPath)} to ${node.label} in ${node.env.name}? This creates a new version.`,'Upload'))return;
    const result=await this.request(node.env,'POST',ROUTES[node.kind]+'/{id}/versions',{id:node.object.id,body:bytes,bytes:true});await vscode.window.showInformationMessage(`Uploaded ${node.label}${result.data?.version!==undefined?` version ${result.data.version}`:''}.`);this.refresh();
  }
  async link(node,unlink=false){this.writable(node.env);let instance=node.kind==='instance'?node.object:undefined,customizer=node.kind==='customizer'?node.object:undefined;
    if(!instance)instance=(await vscode.window.showQuickPick((await this.list(node.env,'instance')).map(o=>({label:o.name,object:o})),{title:'Choose SaaS source instance'}))?.object;if(!instance)return;
    if(!unlink&&!customizer)customizer=(await vscode.window.showQuickPick((await this.list(node.env,'customizer')).map(o=>({label:o.name,object:o})),{title:'Choose customizer'}))?.object;if(!unlink&&!customizer)return;
    if(!await this.confirm(`${unlink?'Unlink customizer from':`Link ${customizer.name} to`} ${instance.name} in ${node.env.name}?`))return;
    await this.request(node.env,'PATCH','/connector-instances/{id}',{id:instance.id,body:[unlink?{op:'remove',path:'/connectorCustomizerId'}:{op:'replace',path:'/connectorCustomizerId',value:customizer.id}]});this.refresh();await vscode.window.showInformationMessage(`Customizer ${unlink?'unlinked':'linked'} for ${instance.name}.`);
  }
  output(name){if(!this.channels.has(name)){const channel=vscode.window.createOutputChannel(name);this.channels.set(name,channel);}const channel=this.channels.get(name);channel.show(true);return channel;}
  async inspect(node){this.app.trust();const env=this.app.env(node.env.id);
    if(node.kind==='instance'){
      const response=await this.app.client.request(env,{version:env.version,method:'GET',path:'/sources',query:{filters:'name eq '+JSON.stringify(node.object.name),limit:2}});const sources=Array.isArray(response.data)?response.data:[];const matches=sources.filter(s=>s.id&&s.name===node.object.name);
      if(matches.length!==1){const choice=await vscode.window.showInformationMessage('No unique source match was found. Use Find Source to choose the source to edit.','Find Source');if(choice==='Find Source')await this.app.findSource({env});return;}
      const source=matches[0],meta=this.app.catalog.index.operations.find(o=>o.version===env.version&&o.method==='GET'&&/^\/sources\/\{[^}]+\}$/.test(o.path));if(!meta)throw new Error('The configured API version does not provide source editing.');
      return this.app.openResource({env,label:source.displayName||source.connectorAttributes?.cloudDisplayName||source.name,apiId:source.id,resource:{version:env.version,path:meta.path,params:{[meta.path.match(/\{([^}]+)\}/)[1]]:source.id}}});
    }
    const uri=this.app.files.uri(env,{kind:'saas',saasKind:node.kind,version:'beta',path:ROUTES[node.kind]+'/{id}',params:{id:node.object.id}},node.label);if(this.app.files.entries.has(uri.toString()))await this.app.files.reload(uri,{quiet:true});await this.app.openFile(uri);}
  async readObject(env,kind,id){const object=(await this.list(env,kind,true)).find(o=>o.id===id);if(!object)throw new Error('This SaaS item no longer exists. Refresh the sidebar.');return object;}
  async saveObject(entry,text){
    const env=this.app.env(entry.environmentId);this.writable(env);
    if(entry.uncertain)throw new Error('The previous save outcome is uncertain. Close and reopen this item before saving again.');
    let edited;try{edited=JSON.parse(text);}catch{throw new Error('Enter valid JSON before saving.');}
    if(!edited||typeof edited!=='object'||Array.isArray(edited))throw new Error('The document must contain a JSON object.');
    const kind=entry.saasKind,field={connector:'alias',customizer:'name',instance:'connectorCustomizerId'}[kind];
    for(const key of new Set([...Object.keys(entry.original),...Object.keys(edited)]))if(key!==field&&JSON.stringify(entry.original[key])!==JSON.stringify(edited[key]))throw new Error(`Only ${field} can be edited for this SaaS ${kind}. ${key} is read-only.`);
    if(JSON.stringify(edited[field])===JSON.stringify(entry.original[field]))return;
    if(kind!=='instance'&&(typeof edited[field]!=='string'||!edited[field].trim()))throw new Error(`${field} must be a non-empty string.`);
    if(kind==='instance'&&edited[field]!=null&&typeof edited[field]!=='string')throw new Error('connectorCustomizerId must be a customizer ID or null to unlink.');
    const remote=await this.readObject(env,kind,entry.params.id);if(hash(remote)!==hash(entry.original))throw Object.assign(new Error('This item changed in ISC. Use Compare with Latest ISC or Reload from ISC.'),{code:'ISC_REMOTE_CHANGED'});
    if(kind==='instance'&&edited[field]&&!(await this.list(env,'customizer')).some(o=>o.id===edited[field]))throw new Error('That customizer ID does not exist in this environment. Use Link Customizer to select one.');
    const body=kind==='instance'?[edited[field]?{op:'replace',path:'/connectorCustomizerId',value:edited[field]}:{op:'remove',path:'/connectorCustomizerId'}]:{[field]:edited[field]};
    try{await this.request(env,kind==='instance'?'PATCH':'PUT',ROUTES[kind]+'/{id}',{id:entry.params.id,body});}catch(e){if(!e.status||e.status>=500)entry.uncertain=true;throw e;}
    entry.original=structuredClone(edited);this.refresh();void vscode.window.showInformationMessage(`Saved ${edited.alias||edited.name||kind} to ${env.name}.`);
  }
  streamKey(node){return node.env.id+':'+(node.object?.id||node.apiId||'tenant');}
  async logTarget(node){if(node?.kind==='instance')return node;if(node?.saasInstance)return {env:this.app.env(node.env.id),kind:'instance',object:node.saasInstance,label:node.saasInstance.name};const env=await this.environment(node);if(!env)return;
    if(node?.apiId){const rows=await this.list(env,'instance');const matches=rows.filter(o=>o.id===node.apiId||o.name===node.label);if(matches.length!==1)throw new Error('No unique SaaS source instance found. Select the instance in SaaS Connectivity.');return {env,kind:'instance',object:matches[0],label:matches[0].name};}
    const selected=await vscode.window.showQuickPick((await this.list(env,'instance')).map(o=>({label:o.name,object:o})),{title:'Choose SaaS source logs'});return selected?{env,kind:'instance',object:selected.object,label:selected.label}:undefined;
  }
  async fetchLogs(state){
    const start=state.cursor,end=new Date().toISOString(),tokens=new Set();let nextToken;
    do{const result=await this.request(state.env,'POST','/platform-logs/query',{signal:state.controller.signal,body:{filter:{startTime:start,endTime:end,targetName:state.label,...(state.levels?.length?{logLevels:state.levels}:{})},...(nextToken?{nextToken}:{})}});
      if(!Array.isArray(result.data?.logs))throw new Error('Log response did not contain log entries.');
      for(const log of result.data.logs){if(state.startTime&&!(Date.parse(log.timestamp)>=Date.parse(state.startTime)))continue;const key=hash(log);if(state.seen.has(key))continue;state.seen.add(key);if(state.seen.size>10000)state.seen.delete(state.seen.values().next().value);state.channel.appendLine(formatLog(log,state.secrets));if(Date.parse(log.timestamp)>Date.parse(state.cursor))state.cursor=log.timestamp;if(++state.lines>=5000){state.channel.clear?.();state.channel.appendLine('Older output cleared after 5,000 lines.');state.lines=0;}}
      nextToken=result.data.nextToken;if(nextToken){if(tokens.has(nextToken))throw new Error('Log service repeated its continuation token.');tokens.add(nextToken);if(tokens.size>100)throw new Error('Log window exceeds 100 pages. Choose a shorter time range.');}
    }while(nextToken&&!state.controller.signal.aborted);
    // Keep a small overlap to collect late log events; de-duplicate by complete event.
    state.cursor=new Date(Math.max(Date.parse(state.cursor)-2000,Date.parse(end)-30000,state.startTime?Date.parse(state.startTime):0)).toISOString();
  }
  async logs(node,tail){const clickedAt=new Date().toISOString();node=await this.logTarget(node);if(!node)return;const key=this.streamKey(node);if(this.streams.has(key)){this.streams.get(key).channel.show();await vscode.window.showInformationMessage('Logs are already streaming for this source.');return;}
    const period=tail?{minutes:0}:await vscode.window.showQuickPick([{label:'Last 5 minutes',minutes:5},{label:'Last 15 minutes',minutes:15},{label:'Last hour',minutes:60}],{title:'Log time range'});if(!period)return;
    const levels=tail?{levels:[]}:await vscode.window.showQuickPick([{label:'All levels',levels:[]},{label:'Warnings and errors',levels:['WARN','ERROR']},{label:'Errors only',levels:['ERROR']}],{title:'Log level'});if(!levels)return;
    const credentials=await this.app.client.credentials(node.env.id),state={env:node.env,label:node.label,channel:this.output(`SaaS Logs — ${node.env.name} — ${node.label}`),cursor:new Date(Date.now()-period.minutes*60000).toISOString(),levels:levels.levels,seen:new Set(),lines:0,controller:new AbortController(),secrets:secretValues(credentials)};this.streams.set(key,state);
    if(tail){state.cursor=clickedAt;state.startTime=clickedAt;state.channel.clear();}
    state.channel.appendLine(`Fetching ${node.label} logs${tail?' and following new events':''}…`);
    const finish=()=>{if(this.streams.get(key)===state)this.stopKey(key);};
    const poll=async()=>{try{await this.fetchLogs(state);if(tail&&!state.controller.signal.aborted)state.timer=this.timer(()=>{void poll();},2000);else finish();}catch(e){if(!state.controller.signal.aborted){state.channel.appendLine(safeText(e.message,state.secrets));await vscode.window.showErrorMessage(`Log retrieval stopped for ${state.label}: ${safeText(e.message,state.secrets)}`);}finish();}};
    await poll();
  }
  stopKey(key){const state=this.streams.get(key);if(!state)return;state.controller.abort();if(state.timer)this.clearTimer(state.timer);state.channel.appendLine('Log streaming stopped.');this.streams.delete(key);}
  async stop(node){if(node?.saasInstance){this.stopKey(node.env.id+':'+node.saasInstance.id);return;}if(node?.kind==='instance'){this.stopKey(this.streamKey(node));return;}if(node?.apiId){for(const [key,state]of this.streams)if(state.env.id===node.env.id&&state.label===node.label)this.stopKey(key);return;}const picked=await vscode.window.showQuickPick([...this.streams].map(([key,s])=>({label:`${s.env.name}: ${s.label}`,key})),{title:'Stop log stream'});if(picked)this.stopKey(picked.key);}
  stopAll(){for(const key of [...this.streams.keys()])this.stopKey(key);}
  dispose(){this.stopAll();this.history=[];for(const channel of this.channels.values())channel.dispose();this.changed.dispose();}
  async folder(){const rows=vscode.workspace.workspaceFolders||[];if(rows.length===1)return rows[0].uri;if(rows.length>1)return (await vscode.window.showQuickPick(rows.map(o=>({label:o.name,uri:o.uri})),{title:'Connector project folder'}))?.uri;return (await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,title:'Connector project folder'}))?.[0];}
  async build(folder,debug=false){this.app.trust();folder=folder||await this.folder();if(!folder)return;
    const pkg=JSON.parse((await this.readFile(vscode.Uri.joinPath(folder,'package.json'))).toString('utf8'));
    const keys=Object.keys(pkg.scripts||{});const preferred=debug?'debug':'pack-zip';const script=keys.includes(preferred)?preferred:(await vscode.window.showQuickPick(keys,{title:debug?'Choose debug script':'Choose ZIP build script'}));if(!script)return;
    if(!await this.confirm(`Run npm script "${script}" from ${folder.fsPath}? This executes the project's code.`,'Run'))return;
    const execution=new vscode.ShellExecution('npm',[{value:'run',quoting:vscode.ShellQuoting.Strong},{value:script,quoting:vscode.ShellQuoting.Strong}],{cwd:folder.fsPath});
    const buildId=randomUUID();const task=new vscode.Task({type:'isc-saas-build',buildId},vscode.TaskScope.Workspace,debug?'Debug SaaS Connector':'Build SaaS Connector','SaaS Connectivity',execution);task.presentationOptions={reveal:vscode.TaskRevealKind.Always,panel:vscode.TaskPanelKind.Dedicated};
    if(debug){await vscode.tasks.executeTask(task);return;}
    const succeeded=await new Promise((resolve,reject)=>{const listener=vscode.tasks.onDidEndTaskProcess(event=>{if(event.execution.task.definition.buildId===buildId){listener.dispose();resolve(event.exitCode===0);}});vscode.tasks.executeTask(task).then(()=>{},e=>{listener.dispose();reject(e);});});
    if(!succeeded)throw new Error('Connector build failed or was cancelled. Nothing was uploaded. Check the task terminal.');return folder;
  }
  async deploy(node){this.writable(node.env);const folder=await this.build();if(!folder)return;const dist=vscode.Uri.joinPath(folder,'dist');const files=(await vscode.workspace.fs.readDirectory(dist)).filter(([name,type])=>type===vscode.FileType.File&&name.endsWith('.zip'));
    if(!files.length)throw new Error('Build completed but dist contains no ZIP. Use Upload ZIP to choose the bundle.');const name=files.length===1?files[0][0]:await vscode.window.showQuickPick(files.map(([n])=>n),{title:'Choose built ZIP'});if(name)await this.upload(node,vscode.Uri.joinPath(dist,name));
  }
  async project(kind){this.app.trust();const name=await vscode.window.showInputBox({title:`Create ${kind==='connector'?'Connector':'Customizer'} Project`,validateInput:v=>/^[a-z0-9][a-z0-9-]{0,80}$/.test(v)?null:'Use lowercase letters, numbers and hyphens.'});if(!name)return;if(!/^[a-z0-9][a-z0-9-]{0,80}$/.test(name))throw new Error('Invalid project name.');
    const parent=(await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,title:'Parent folder for new project'}))?.[0];if(!parent)return;
    const destination=vscode.Uri.joinPath(parent,name);let exists=false;try{await vscode.workspace.fs.stat(destination);exists=true;}catch(e){if(!['FileNotFound','ENOENT'].includes(e.code))throw e;}if(exists)throw new Error('That project folder already exists. Choose a new name.');
    const source=vscode.Uri.file(this.app.context.asAbsolutePath('resources/saas-templates/'+kind));const copy=async(from,to)=>{await vscode.workspace.fs.createDirectory(to);for(const [file,type]of await vscode.workspace.fs.readDirectory(from)){if(type===vscode.FileType.Directory)await copy(vscode.Uri.joinPath(from,file),vscode.Uri.joinPath(to,file));else if(type===vscode.FileType.File){const content=(await this.readFile(vscode.Uri.joinPath(from,file))).toString('utf8').replaceAll('{{$ .ProjectName}}',name).replaceAll('{{$.ProjectName}}',name);await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(to,file),Buffer.from(content));}}};await copy(source,destination);
    for(const file of ['LICENSE.txt','ATTRIBUTION.md'])await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(destination,file),await this.readFile(vscode.Uri.file(this.app.context.asAbsolutePath('resources/saas-templates/'+file))));
    const open=await vscode.window.showInformationMessage(`Created ${name}. Run npm install in its folder, then use Build or Debug.`,'Open Folder');if(open==='Open Folder')await vscode.commands.executeCommand('vscode.openFolder',destination,{forceNewWindow:true});
  }
  async configuration(env){
    const mode=await vscode.window.showQuickPick([{label:'Load JSON configuration file',mode:'json'},{label:'Use SaaS source connector attributes',mode:'source'},{label:'Use connector-spec.json defaults',mode:'spec'},{label:'Empty configuration',mode:'empty'}].filter(o=>env||o.mode!=='source'),{title:'Connector test configuration'});if(!mode)return;
    let config={},spec;
    if(mode.mode==='json'){const file=(await vscode.window.showOpenDialog({canSelectMany:false,filters:{JSON:['json']}}))?.[0];if(!file)return;config=JSON.parse((await this.readFile(file)).toString('utf8'));}
    if(mode.mode==='source'){const sources=await this.app.listObjects(env,'/sources');const source=await vscode.window.showQuickPick(sources.map(o=>({label:o.name,id:o.id})),{title:'Source configuration'});if(!source)return;const response=await this.app.client.request(this.app.env(env.id),{version:env.version,path:'/sources/{id}',pathParams:{id:source.id}});config=response.data?.connectorAttributes||{};}
    if(mode.mode==='spec'){const folder=await this.folder();if(!folder)return;spec=JSON.parse((await this.readFile(vscode.Uri.joinPath(folder,'connector-spec.json'))).toString('utf8'));const keys=[];const visit=rows=>{for(const row of rows||[]){if(row.key)keys.push(row.key);if(Array.isArray(row.items))visit(row.items);}};visit(spec.sourceConfig);config={...Object.fromEntries(keys.map(k=>[k,null])),...spec.sourceConfigInitialValues};}
    if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('Configuration must be a JSON object.');
    const overlay=await vscode.window.showQuickPick([{label:'Continue with this configuration',env:false},{label:'Overlay values from an .env file',env:true}],{title:'Configuration overrides'});if(!overlay)return;
    if(overlay.env){const file=(await vscode.window.showOpenDialog({canSelectMany:false,title:'Select .env file'}))?.[0];if(!file)return;config={...config,...parseEnv((await this.readFile(file)).toString('utf8'))};}
    return {config,spec};
  }
  async test(node,local=false){this.app.trust();let env,connector,port;
    if(local){port=await vscode.window.showInputBox({title:'Local connector port',value:'3000',validateInput:v=>{try{localUrl(v);return null;}catch(e){return e.message;}}});if(port===undefined)return;localUrl(port);}
    else{env=await this.environment(node);if(!env)return;this.writable(env);connector=node?.kind==='connector'?node.object:(await vscode.window.showQuickPick((await this.list(env,'connector')).map(o=>({label:o.alias,object:o})),{title:'Connector to test'}))?.object;if(!connector)return;}
    const settings=await this.configuration(env);if(!settings)return;
    const supported=settings.spec?.commands;const choices=Array.isArray(supported)&&supported.every(v=>typeof v==='string')&&supported.length?supported:COMMANDS;
    const action=await vscode.window.showQuickPick(choices,{title:'Connector command'});if(!action)return;
    const text=await vscode.window.showInputBox({title:`Input JSON for ${action}`,value:'{}',ignoreFocusOut:true,validateInput:v=>{try{JSON.parse(v);return null;}catch{return 'Enter valid JSON.';}}});if(text===undefined)return;const input=JSON.parse(text);
    await this.executeTest({environmentId:env?.id,connectorId:connector?.id,label:connector?.alias||'Local connector',port,action,input,config:settings.config,local});
  }
  async executeTest(record){
    this.app.trust();const env=record.local?undefined:this.app.env(record.environmentId);if(env)this.writable(env);
    if(!await this.confirm(`Invoke ${record.action} on ${record.label}${env?' in '+env.name:' at '+localUrl(record.port)}? Connector commands can change the connected system.`,'Invoke'))return;
    const key=(env?.id||'local')+':'+(record.connectorId||record.port);if(this.busy.has(key))throw new Error('A test is already running for this connector.');this.busy.add(key);
    const channel=this.output(`SaaS Tests — ${env?.name||'Local'}`),secrets=[...secretValues(record.config),...secretValues(record.input)];
    if(env)secrets.push(...secretValues(await this.app.client.credentials(env.id)));
    const started=Date.now();channel.appendLine(`${record.action} — ${record.label} — starting`);
    try{
      const result=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Testing ${record.label}`,cancellable:true},async(_,token)=>{const controller=new AbortController(),subscription=token.onCancellationRequested(()=>controller.abort());try{
        if(record.local){const response=await this.fetch(localUrl(record.port),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:record.action,input:record.input,config:record.config}),redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});const bytes=await readBytes(response,5*1024*1024);return {status:response.status,data:bytes.toString('utf8')};}
        return await this.request(env,'POST','/platform-connectors/{id}/invoke',{id:record.connectorId,body:{connectorRef:record.connectorId,type:record.action,input:record.input,config:record.config,tag:'latest'},signal:controller.signal,rawText:true});
      }finally{subscription.dispose();}});
      const frames=parseFrames(result.data);for(const frame of frames)channel.appendLine(safeText(frame,secrets));const failed=result.status>=400||frames.some(failedFrame);channel.appendLine(`${failed?'Failed':'Finished'} — ${Date.now()-started} ms`);
      if(failed)await vscode.window.showErrorMessage(`Connector test failed: ${record.action}. See SaaS Tests output.`);else await vscode.window.showInformationMessage(`Connector test completed: ${record.action}. Results are in SaaS Tests output.`);
      this.history.unshift({...record,timestamp:new Date().toISOString()});this.history=this.history.slice(0,20);
    }catch(e){channel.appendLine(safeText(e.message,secrets));throw new Error(`Connector test failed or was cancelled. Check SaaS Tests output before repeating a write command.`);}finally{this.busy.delete(key);}
  }
  async replay(){this.app.trust();const selected=await vscode.window.showQuickPick(this.history.map(record=>({label:`${record.timestamp} — ${record.label} — ${record.action}`,record})),{title:'Replay connector test (session history)'});if(selected)await this.executeTest(selected.record);}
}
module.exports={SaaS};
