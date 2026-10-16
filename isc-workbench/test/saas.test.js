'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {mock,context,answers,messages}=require('./vscode-mock.cjs');
const {App}=require('../src/extension');
const {Client}=require('../src/client');
const {safeText,formatLog,parseFrames,failedFrame,parseEnv,localUrl}=require('../src/saas-utils');
const env={id:'sandbox',name:'Sandbox',baseUrl:'https://sandbox.api.identitynow.com',version:'v2026',readOnly:false};
async function setup(readOnly=false){
  answers.length=0;messages.length=0;mock.workspace.isTrusted=true;const dir=await fs.mkdtemp(path.join(os.tmpdir(),'isc-saas-'));const ctx=context(dir);await ctx.globalState.update('isc.environments',[{...env,readOnly}]);
  const outputs=[];mock.window.createOutputChannel=name=>{const channel={name,lines:[],appendLine(text){this.lines.push(text);},clear(){this.lines=[];},show(){},dispose(){this.disposed=true;}};outputs.push(channel);return channel;};
  mock.workspace.fs.readDirectory=async uri=>(await fs.readdir(uri.fsPath,{withFileTypes:true})).map(d=>[d.name,d.isDirectory()?2:1]);mock.FileType.Directory=2;
  const app=new App(ctx);return {app,saas:app.saas,ctx,dir,outputs};
}
const connector={env,kind:'connector',label:'Example',object:{id:'connector-id',alias:'Example'}};
const instance={env,kind:'instance',label:'Cloud Source',object:{id:'instance-id',name:'Cloud Source'}};
test('SaaS list reads share cache but detail reads bypass it for stale-edit checks',async()=>{
 const {saas,app}=await setup();let calls=0;app.client.request=async()=>{calls++;return {data:[{id:'x',alias:String(calls)}]};};await Promise.all([saas.list(env,'connector'),saas.list(env,'connector')]);assert.equal(calls,1);await saas.list(env,'connector');assert.equal(calls,1);assert.equal((await saas.readObject(env,'connector','x')).alias,'2');saas.refresh();await saas.list(env,'connector');assert.equal(calls,3);
});
test('Auto Save and writes without manual save intent never submit SaaS changes',async()=>{
 const {app,saas}=await setup();saas.list=async()=>[connector.object];let writes=0;app.client.request=async()=>{writes++;return {data:{}};};await saas.inspect(connector);const doc=mock.window.activeTextEditor.document;doc.text=JSON.stringify({...connector.object,alias:'Edited'});
 for(const reason of [2,3])await assert.rejects(()=>doc.save(reason),/Auto Save cannot write/);
 await assert.rejects(()=>app.files.writeFile(doc.uri,Buffer.from(doc.text)),/Auto Save cannot write/);assert.equal(writes,0);
 await doc.save(1);assert.equal(writes,1);await assert.rejects(()=>app.files.writeFile(doc.uri,Buffer.from(doc.text)),/Auto Save cannot write/);assert.equal(writes,1);
});
test('stream starts without prompts and excludes events before the click',async()=>{
 const {saas,app,outputs}=await setup();saas.timer=()=>1;saas.clearTimer=()=>{};const requests=[];app.client.request=async(e,o)=>{const body=JSON.parse(o.body);requests.push(body);return {data:{logs:[{timestamp:'2000-01-01T00:00:00Z',message:'PAST'},{timestamp:new Date(Date.now()+100).toISOString(),message:'NEW'}]}};};
 answers.push('must remain unused');await saas.logs(instance,true);assert.equal(answers.shift(),'must remain unused');assert(!outputs.flatMap(o=>o.lines).join('').includes('PAST'));assert(outputs.flatMap(o=>o.lines).join('').includes('NEW'));const state=saas.streams.get(saas.streamKey(instance));assert.equal(requests[0].filter.startTime,state.startTime);await saas.fetchLogs(state);assert(Date.parse(requests[1].filter.startTime)>=Date.parse(state.startTime));saas.dispose();
 const titleMenus=require('../package.json').contributes.menus['view/title'];assert(!titleMenus.some(m=>m.command==='iscWorkbench.saasStopAllLogs'));
});
test('main source tree only marks confirmed SaaS members and retains source menus',async()=>{
 const {app,saas}=await setup();app.listObjects=async()=>[{id:'s1',name:'Cloud',displayName:'Friendly Cloud'},{id:'s2',name:'AD'}];saas.list=async()=>[{id:'i1',name:'Cloud'}];
 const rows=await app.envTree.getChildren({env,contextValue:'iscCollection',route:'/sources',cacheKey:'saas-filter',offset:0});assert.equal(rows[0].contextValue,'iscSaasSource');assert.equal(rows[1].contextValue,'iscSource');assert.equal((await saas.logTarget(rows[0])).label,'Cloud');
 const menus=require('../package.json').contributes.menus['view/item/context'];assert(menus.filter(m=>m.command==='iscWorkbench.saasLogs').every(m=>!m.when.includes('== iscSource')));assert(menus.some(m=>m.command.includes('clone')&&m.when.includes('iscSaasSource')));
});
test('SaaS JSON documents save allowed fields by ID and obey changed locks',async()=>{
 const {app,saas,ctx}=await setup();let current={id:'connector-id',alias:'Example'},sent;saas.list=async()=>[current];app.client.request=async(e,o)=>{sent=o;current={...current,...JSON.parse(o.body)};return {data:current};};
 await saas.inspect(connector);const doc=mock.window.activeTextEditor.document;doc.text=JSON.stringify({...current,alias:'Renamed'});await doc.save();assert.equal(sent.method,'PUT');assert.equal(sent.pathParams.id,'connector-id');assert.deepEqual(JSON.parse(sent.body),{alias:'Renamed'});
 await ctx.globalState.update('isc.environments',[{...env,readOnly:true}]);doc.text=JSON.stringify({...current,alias:'Blocked'});await assert.rejects(()=>doc.save(),/read-only/);
});
test('SaaS save blocks unsupported fields and stale remote content',async()=>{
 const {saas}=await setup();const entry={environmentId:env.id,saasKind:'customizer',params:{id:'c'},original:{id:'c',name:'Original',imageVersion:'1'}};
 await assert.rejects(()=>saas.saveObject(entry,JSON.stringify({...entry.original,imageVersion:'2'})),/read-only/);saas.readObject=async()=>({...entry.original,name:'Other edit'});await assert.rejects(()=>saas.saveObject(entry,JSON.stringify({...entry.original,name:'Mine'})),/changed in ISC/);
});
test('instance editor validates customizer ID and uses PATCH unlink',async()=>{
 const {saas,app}=await setup();const original={id:'i',name:'Cloud',connectorCustomizerId:'c'};const entry={environmentId:env.id,saasKind:'instance',params:{id:'i'},original};saas.readObject=async()=>original;saas.list=async()=>[];
 await assert.rejects(()=>saas.saveObject(entry,JSON.stringify({...original,connectorCustomizerId:'missing'})),/does not exist/);let sent;app.client.request=async(e,o)=>{sent=o;return {data:{}};};await saas.saveObject(entry,JSON.stringify({...original,connectorCustomizerId:null}));assert.equal(sent.method,'PATCH');assert.deepEqual(JSON.parse(sent.body),[{op:'remove',path:'/connectorCustomizerId'}]);
});
test('SaaS tree shares tenants and sorts connector aliases',async()=>{
 const {saas,app}=await setup();app.client.request=async()=>({data:[{id:'2',alias:'Zebra'},{id:'1',alias:'Alpha'}]});const roots=await saas.getChildren();assert.equal(roots[0].env.id,env.id);const folders=await saas.getChildren(roots[0]);assert.deepEqual(folders.map(n=>n.kind),['connector','customizer','instance']);const rows=await saas.getChildren(folders[0]);assert.deepEqual(rows.map(n=>n.label),['Alpha','Zebra']);assert.equal(rows[0].object.id,'1');
});
test('SaaS forbidden collections report access failure as a tree message',async()=>{
 const {saas,app}=await setup();app.client.request=async()=>{throw Object.assign(new Error('Denied'),{status:403});};const rows=await saas.getChildren({env,kind:'connector',contextValue:'saasFolderconnector'});assert.match(rows[0].label,/access denied/);
});
test('read-only SaaS permits log query but rejects invocation and management',async()=>{
 const {saas,app}=await setup(true);let calls=0;app.client.request=async(e,o)=>{calls++;assert.equal(o.nonMutatingJob,true);assert.equal(o.path,'/platform-logs/query');return {data:{logs:[]}};};await saas.request(env,'POST','/platform-logs/query',{body:{filter:{}}});for(const route of ['/platform-connectors','/platform-connectors/{id}/invoke','/connector-customizers'])await assert.rejects(()=>saas.request(env,'POST',route,{body:{}}),/Unlock/);assert.equal(calls,1);
});
test('SaaS operations enforce Workspace Trust before using credentials',async()=>{
 const {saas,app}=await setup();mock.workspace.isTrusted=false;app.client.request=async()=>{throw new Error('Unexpected request');};await assert.rejects(()=>saas.list(env,'connector'),/Trust/);mock.workspace.isTrusted=true;
});
test('connector create and rename send distinct alias field using platform ID',async()=>{
 const {saas,app}=await setup();const calls=[];app.client.request=async(e,o)=>{calls.push(o);return {data:{id:'connector-id',alias:'New'},status:200};};answers.push('New');await saas.create({env},'connector');answers.push('Renamed');await saas.rename(connector);assert.equal(calls[0].path,'/platform-connectors');assert.deepEqual(JSON.parse(calls[0].body),{alias:'New'});assert.equal(calls[1].pathParams.id,'connector-id');assert.equal(calls[1].method,'PUT');
});
test('customizer links use instance ID and remove op unlinks',async()=>{
 const {saas,app}=await setup();const calls=[];app.client.request=async(e,o)=>{calls.push(o);return o.method==='GET'?{data:[{id:'custom-id',name:'Customizer'}]}:{data:{}};};answers.push({object:{id:'custom-id',name:'Customizer'}},'Continue');await saas.link(instance);answers.push('Continue');await saas.link(instance,true);const changes=calls.filter(o=>o.method==='PATCH');assert.equal(changes[0].pathParams.id,'instance-id');assert.deepEqual(JSON.parse(changes[0].body),[{op:'replace',path:'/connectorCustomizerId',value:'custom-id'}]);assert.deepEqual(JSON.parse(changes[1].body),[{op:'remove',path:'/connectorCustomizerId'}]);
});
test('ZIP upload uses raw bytes, application/zip and version endpoint',async()=>{
 const {saas,app,dir}=await setup();const file=path.join(dir,'connector.zip');await fs.writeFile(file,Buffer.from([0x50,0x4b,3,4,0,0]));let request;app.client.request=async(e,o)=>{request=o;return {data:{version:7}};};answers.push('Upload');await saas.upload(connector,mock.Uri.file(file));assert(Buffer.isBuffer(request.body));assert.equal(request.headers['Content-Type'],'application/zip');assert.equal(request.path,'/platform-connectors/{id}/versions');assert.equal(request.pathParams.id,'connector-id');assert(messages.some(m=>m.includes('version 7')));
});
test('SaaS deletion does not run for a wrong confirmation name',async()=>{
 const {saas,app}=await setup();let calls=0;app.client.request=async()=>{calls++;return {data:null};};answers.push('wrong');await saas.remove(connector);assert.equal(calls,0);answers.push('Example');await saas.remove(connector);assert.equal(calls,1);
});
test('log pagination keeps identical filter and de-duplicates overlapping events',async()=>{
 const {saas,app}=await setup();const requests=[],log={timestamp:new Date().toISOString(),level:'INFO',message:'hello'};app.client.request=async(e,o)=>{const b=JSON.parse(o.body);requests.push(b);return {data:b.nextToken?{logs:[log]}:{logs:[log],nextToken:'next'}};};const state={env,label:'Cloud',cursor:new Date(Date.now()-60000).toISOString(),seen:new Set(),lines:0,controller:new AbortController(),channel:saas.output('Logs'),secrets:[]};await saas.fetchLogs(state);assert.equal(requests.length,2);assert.deepEqual(requests[0].filter,requests[1].filter);assert.equal(state.channel.lines.length,1);
});
test('repeated log continuation token stops paging',async()=>{
 const {saas,app}=await setup();app.client.request=async()=>({data:{logs:[],nextToken:'repeat'}});await assert.rejects(()=>saas.fetchLogs({env,label:'Cloud',cursor:new Date().toISOString(),seen:new Set(),lines:0,controller:new AbortController(),channel:saas.output('Logs'),secrets:[]}),/repeated/);
});
test('stream stop cancels timer and aborts outstanding reads',async()=>{
 const {saas,app}=await setup();let scheduled,cancelled;saas.timer=fn=>{scheduled=fn;return 1;};saas.clearTimer=id=>{cancelled=id;};app.client.request=async()=>({data:{logs:[]}});answers.push({minutes:5},{levels:[]});await saas.logs(instance,true);const state=saas.streams.get(saas.streamKey(instance));assert.equal(typeof scheduled,'function');await saas.stop(instance);assert.equal(cancelled,1);assert(state.controller.signal.aborted);assert.equal(saas.streams.size,0);
});
test('snapshot logs finish and do not leave a poll timer',async()=>{
 const {saas,app}=await setup();saas.timer=()=>{throw new Error('Unexpected timer');};app.client.request=async()=>({data:{logs:[]}});answers.push({minutes:5},{levels:['ERROR']});await saas.logs(instance,false);assert.equal(saas.streams.size,0);
});
test('log and test output masks keyed secrets and known secret values',()=>{
 const value=safeText({apiKey:'api-value',token:'token-value',nested:{password:'pass-value'},message:'echo known-value'},['known-value']);assert(!/api-value|token-value|pass-value|known-value/.test(value));const log=formatLog({timestamp:'invalid',message:'{"apiKey":"hidden"}',level:'INFO'});assert(!log.includes('hidden'));assert(!safeText('apiKey="sensitive"').includes('sensitive'));
});
test('NDJSON invocation parsing detects embedded failure frames',()=>{const frames=parseFrames('{"output":1}\n{"type":"error","message":"failed"}\n');assert.equal(frames.length,2);assert(frames.some(failedFrame));assert(!failedFrame({success:true}));});
test('local connector URL cannot be changed to a remote origin',()=>{assert.equal(localUrl('3000'),'http://127.0.0.1:3000/');for(const value of ['3000/redirect','http://remote','80','65536','3000;echo'])assert.throws(()=>localUrl(value));});
test('env parsing treats shell expansions as literal text',()=>{const env=parseEnv('export KEY="$(malicious)"\nTOKEN=value # comment\n# ignored');assert.equal(env.KEY,'$(malicious)');assert.equal(env.TOKEN,'value');});
test('remote tester uses configured tenant, latest tag and no persistent history',async()=>{
 const {saas,app,ctx,outputs}=await setup();let request;app.client.request=async(e,o)=>{request=o;return {status:200,data:'{"output":{"token":"secret-value"}}\n{"completed":true}'};};answers.push('Invoke');await saas.executeTest({environmentId:env.id,connectorId:'connector-id',label:'Example',action:'std:test-connection',input:{},config:{token:'secret-value'}});assert.equal(request.pathParams.id,'connector-id');assert.equal(request.rawText,true);assert.equal(JSON.parse(request.body).tag,'latest');assert.equal(saas.history.length,1);assert(!JSON.stringify([...ctx.state]).includes('secret-value'));assert(!outputs.flatMap(o=>o.lines).join('').includes('secret-value'));saas.dispose();assert.equal(saas.history.length,0);
});
test('local tester never attaches ISC Authorization and disallows redirects',async()=>{
 const {saas}=await setup();let sent;saas.fetch=async(url,o)=>{sent={url,o};return new Response('{"completed":true}',{status:200});};answers.push('Invoke');await saas.executeTest({local:true,port:3000,label:'Local',action:'std:test-connection',input:{},config:{}});assert.equal(sent.url,'http://127.0.0.1:3000/');assert.equal(sent.o.headers.Authorization,undefined);assert.equal(sent.o.redirect,'error');
});
test('replayed invocation obeys a lock changed after the first call',async()=>{
 const {saas,ctx}=await setup();await ctx.globalState.update('isc.environments',[{...env,readOnly:true}]);await assert.rejects(()=>saas.executeTest({environmentId:env.id,connectorId:'id',config:{}}),/Unlock/);
});
test('rawText transport accepts NDJSON while applying response size cap',async()=>{
 const client=new Client(async()=>({kind:'token',accessToken:'test'}),{fetch:async()=>new Response('{"a":1}\n{"a":2}',{headers:{'content-type':'application/json'}})});const result=await client.request(env,{path:'/platform-connectors',rawText:true,maxResponseBytes:50});assert.equal(parseFrames(result.data).length,2);await assert.rejects(()=>client.request(env,{path:'/platform-connectors',rawText:true,maxResponseBytes:3}),/size limit/);
});
test('project scaffold uses template placeholders and refuses an existing folder',async()=>{
 const {saas,dir}=await setup();answers.push('sample-project',[mock.Uri.file(dir)]);await saas.project('connector');const pkg=JSON.parse(await fs.readFile(path.join(dir,'sample-project/package.json'),'utf8'));assert.equal(pkg.name,'sample-project');assert.equal(pkg.scripts['pack-zip'],'spcx package');answers.push('sample-project',[mock.Uri.file(dir)]);await assert.rejects(()=>saas.project('connector'),/already exists/);
});
test('failed build prevents deployment',async()=>{
 const {saas}=await setup();saas.build=async()=>{throw new Error('Build failed');};saas.upload=async()=>{throw new Error('Unexpected upload');};await assert.rejects(()=>saas.deploy(connector),/Build failed/);
});
test('build matches task definition across cloned events and quotes npm arguments',async()=>{
 const {saas,dir}=await setup();await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({scripts:{'pack-zip':'some-build'}}));
 mock.ShellQuoting={Strong:1};mock.ShellExecution=class{constructor(command,args,options){Object.assign(this,{command,args,options});}};
 mock.Task=class{constructor(definition,scope,name,source,execution){Object.assign(this,{definition,execution});}};
 mock.TaskScope={Workspace:1};mock.TaskRevealKind={Always:1};mock.TaskPanelKind={Dedicated:1};let listener,sent,disposed=false;
 mock.tasks={onDidEndTaskProcess:fn=>{listener=fn;return {dispose(){disposed=true;}};},executeTask:async task=>{sent=task;queueMicrotask(()=>listener({execution:{task:{definition:{...task.definition}}},exitCode:0}));}};
 answers.push('Run');const result=await saas.build(mock.Uri.file(dir));assert.equal(result.fsPath,dir);assert(disposed);assert.equal(sent.execution.command,'npm');assert.deepEqual(sent.execution.args,[{value:'run',quoting:1},{value:'pack-zip',quoting:1}]);
});
