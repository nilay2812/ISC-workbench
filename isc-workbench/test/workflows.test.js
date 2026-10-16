const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {mock,context,answers,messages,commands}=require('./vscode-mock.cjs');
const {App}=require('../src/extension');
const {Promotions,snapshotHash}=require('../src/promotion');
const env={id:'dev',name:'Dev',baseUrl:'https://dev.api.identitynow.com',version:'v2026',readOnly:false};
const target={id:'prod',name:'Production',baseUrl:'https://prod.api.identitynow.com',version:'v2026',readOnly:false};
const config={version:1,objects:[{version:1,self:{type:'TRANSFORM',name:'Test',id:'1'},object:{name:'Test',type:'static',attributes:{value:'dev'}}}]};
async function setup(){answers.length=0;messages.length=0;mock.workspace.isTrusted=true;const dir=await fs.mkdtemp(path.join(os.tmpdir(),'isc-test-'));const ctx=context(dir);await ctx.globalState.update('isc.environments',[env,target]);const app=new App(ctx);return {app,dir,ctx};}
async function promotion(){const s=await setup(),p=s.app.promotions,folder=mock.Uri.file(s.dir);p.folder=async()=>folder;p.load=async()=>({meta:{kind:'isc-promotion',formatVersion:1,version:'v2026',includeTypes:['TRANSFORM']},target,source:env,candidate:config,baseline:config});p.export=async()=>({data:config});await p.save(folder,'candidate.json',config);await p.save(folder,'promotion.json',(await p.load()).meta);return {...s,p,folder};}

test('extension activates and registers every contributed command',async()=>{await setup();const pkg=require('../package.json');for(const c of pkg.contributes.commands)assert(commands.has(c.command),c.command);});
test('environment creation persists credentials only in SecretStorage',async()=>{
  const {app,ctx}=await setup();answers.push('UAT','https://uat.api.identitynow.com',{value:'pat'},'client-id','secret-value');await app.addEnvironment();
  assert.equal(app.envs().length,3);assert.equal(app.envs()[2].readOnly,true);assert(!JSON.stringify([...ctx.state]).includes('secret-value'));assert(JSON.stringify([...ctx.secretValues]).includes('secret-value'));
});
test('untrusted workspace blocks tenant operations',async()=>{const {app}=await setup();mock.workspace.isTrusted=false;await assert.rejects(()=>app.addEnvironment(),/Trust/);mock.workspace.isTrusted=true;});
test('API requests execute through bound environments and redact response secrets',async()=>{
  const {app}=await setup();let sent;app.client.request=async(e,o)=>{sent={e,o};return {status:200,headers:{},data:{name:'Test',clientSecret:'abc'}};};
  const op=app.findOp('v2026','GET','/transforms');await app.newRequest(op.key,env);await app.runRequest();assert.equal(sent.e.id,'dev');assert.equal(sent.o.path,'/transforms');assert(mock.window.activeTextEditor.document.getText().includes('[REDACTED]'));
});
test('request drafts cannot bypass read-only environment mode',async()=>{
  const {app,ctx}=await setup();await ctx.globalState.update('isc.environments',[{...env,readOnly:true}]);const op=app.findOp('v2026','POST','/transforms');await app.newRequest(op.key,env);await assert.rejects(()=>app.runRequest(),/read-only/);
});
test('saving a remote transform uses its documented update method',async()=>{
  const {app}=await setup();const original={id:'1',name:'Test',type:'static',attributes:{value:'dev'}};const calls=[];
  app.client.request=async(e,o)=>{calls.push(o);return {data:original,status:200};};
  const detail=app.catalog.index.operations.find(o=>o.version==='v2026'&&o.method==='GET'&&/^\/transforms\/\{/.test(o.path));
  const param=detail.path.match(/\{([^}]+)\}/)[1];await app.openResource({label:'Test',env,resource:{version:'v2026',path:detail.path,params:{[param]:'1'}}});
  mock.window.activeTextEditor.document.text=JSON.stringify({...original,attributes:{value:'prod'}});await app.publishResource();
  const update=calls.find(c=>c.method==='PATCH'||c.method==='PUT');assert(update);assert(update.body.includes('prod'));assert(!update.body.includes('"path":"/id"'));
});
test('stale remote edits are blocked before update',async()=>{
  const {app}=await setup();const original={id:'1',name:'Test',type:'static',attributes:{value:'dev'}};let reads=0;
  app.client.request=async()=>({data:++reads===1?original:{...original,name:'Changed'}});
  const detail=app.catalog.index.operations.find(o=>o.version==='v2026'&&o.method==='GET'&&/^\/transforms\/\{/.test(o.path));
  await app.openResource({label:'Test',env,resource:{version:'v2026',path:detail.path,params:{[detail.path.match(/\{([^}]+)\}/)[1]]:'1'}}});
  mock.window.activeTextEditor.document.text=JSON.stringify({...original,attributes:{value:'prod'}});await assert.rejects(()=>app.publishResource(),/Remote resource changed/);
});
test('promotion snapshot ignores export timestamp and object order only',()=>{
  assert.equal(snapshotHash(config),snapshotHash({...config,timestamp:'tomorrow'}));assert.notEqual(snapshotHash(config),snapshotHash({objects:[{...config.objects[0],object:{name:'different'}}]}));
});
test('target drift blocks promotion before preview/import',async()=>{
  const {p}=await promotion();p.export=async()=>({data:{objects:[]}});p.job=async()=>{throw new Error('Should not submit');};await assert.rejects(()=>p.apply(),/Target configuration changed/);
});
test('preview errors block actual promotion',async()=>{
  const {p}=await promotion();const calls=[];p.job=async(e,v,k,o)=>{calls.push(o);return {status:'COMPLETE',data:{results:{TRANSFORM:{errors:[{text:'Unresolved owner'}],warnings:[]}}}};};
  await assert.rejects(()=>p.apply(),/Import blocked/);assert.equal(calls.length,1);assert.equal(calls[0].query.preview,true);
});
test('promotion requires exact target confirmation and runs a fresh preview',async()=>{
  const {p}=await promotion();const calls=[];p.job=async(e,v,k,o)=>{calls.push(o);return {status:'COMPLETE',data:{results:{TRANSFORM:{errors:[],warnings:[]}}}};};answers.push('wrong-name');await p.apply();assert.equal(calls.length,1);assert.equal(calls[0].query.preview,true);
});
test('successful promotion checks target twice and downloads automatic backup',async()=>{
  const {p,app,dir}=await promotion();let exports=0;p.export=async()=>{exports++;return {data:config};};const calls=[];
  p.job=async(e,v,k,o)=>{calls.push(o);return {status:'COMPLETE',jobId:'job',data:{results:{TRANSFORM:{errors:[],warnings:[],importedObjects:[{id:'1'}]}},...(o.query?{}:{exportJobId:'backup-job'})}};};
  app.client.request=async(e,o)=>{assert.equal(o.pathParams.id,'backup-job');return {data:config};};answers.push('Production');await p.apply();assert.equal(exports,2);assert.equal(calls.length,2);assert.equal(calls[0].query.preview,true);assert.equal(calls[1].query,undefined);assert((await fs.readdir(dir)).some(n=>n.startsWith('backup-')));
});
test('partial import results are saved and reported as failures, with backup',async()=>{
  const {p,app,dir}=await promotion();p.job=async(e,v,k,o)=>({status:'COMPLETE',jobId:'job',data:{results:{TRANSFORM:{errors:o.query?[]:[{text:'partial failure'}],warnings:[]}},...(o.query?{}:{exportJobId:'backup'})}});
  app.client.request=async()=>({data:config});answers.push('Production');await assert.rejects(()=>p.apply(),/partial changes are possible/);const files=await fs.readdir(dir);assert(files.some(n=>n.startsWith('backup-')));assert(files.some(n=>n.startsWith('import-result-')));
});

async function remoteEditor(app,kind='transforms'){
  const op=app.catalog.index.operations.find(o=>o.version==='v2026'&&o.method==='GET'&&new RegExp('^/'+kind+'/\\{[^}]+\\}$').test(o.path));
  await app.openResource({label:'Example',env,resource:{version:op.version,path:op.path,params:{[op.path.match(/\{([^}]+)\}/)[1]]:'1'}}});
  return mock.window.activeTextEditor.document;
}
test('Ctrl+S writes twice without dialogs and tolerates server timestamps',async()=>{
  const {app}=await setup();let remote={id:'1',name:'Example',type:'static',attributes:{value:'one'},modified:'t1'},writes=0;
  app.client.request=async(e,o)=>{if(o.method==='PUT'){writes++;remote={...JSON.parse(o.body),id:'1',modified:'t'+(writes+1)};}return {data:structuredClone(remote),status:200};};
  const doc=await remoteEditor(app);assert.equal(doc.uri.scheme,'isc-resource');
  for(const value of ['two','three']){const edited=JSON.parse(doc.getText());edited.attributes.value=value;doc.text=JSON.stringify(edited);await doc.save();}
  assert.equal(writes,2);assert.equal(remote.attributes.value,'three');assert(!messages.some(m=>m.includes('Publish')));
});
test('Ctrl+S patches only a changed nested source attribute',async()=>{
  const {app}=await setup();let remote={id:'1',name:'Source',connectorAttributes:{host:'old',password:'MASKED'}},body;
  app.client.request=async(e,o)=>{if(o.method==='PATCH'){body=JSON.parse(o.body);remote.connectorAttributes.host='new';}return {data:structuredClone(remote)};};
  const doc=await remoteEditor(app,'sources');const edited=JSON.parse(doc.text);edited.connectorAttributes.host='new';doc.text=JSON.stringify(edited);await doc.save();
  assert.deepEqual(body,[{op:'replace',path:'/connectorAttributes/host',value:'new'}]);
});
test('lock changes editor permissions and prevents saving an already-open document',async()=>{
  const {app}=await setup();app.client.request=async()=>({data:{id:'1',name:'Example',type:'static',attributes:{value:'one'}}});
  const doc=await remoteEditor(app);assert.equal((await app.files.stat(doc.uri)).permissions,undefined);
  await app.toggleWrites(env);assert.equal((await app.files.stat(doc.uri)).permissions,mock.FilePermission.Readonly);
  await assert.rejects(()=>doc.save(),/read-only/);await app.toggleWrites(env);assert.equal((await app.files.stat(doc.uri)).permissions,undefined);
});
test('failed save retains baseline and edited document; invalid JSON never writes',async()=>{
  const {app}=await setup();let writes=0;app.client.request=async(e,o)=>{if(o.method){writes++;throw Object.assign(new Error('Rejected'),{status:400});}return {data:{id:'1',name:'Example',type:'static',attributes:{value:'one'}}};};
  const doc=await remoteEditor(app);doc.text='{';await assert.rejects(()=>doc.save(),/Invalid JSON/);assert.equal(writes,0);
  doc.text=JSON.stringify({id:'1',name:'Example',type:'static',attributes:{value:'two'}});await assert.rejects(()=>doc.save(),/Rejected/);
  assert.equal((await app.files.entry(doc.uri)).original.attributes.value,'one');assert(doc.text.includes('two'));
});
test('ambiguous network failure blocks another save until resource is reopened',async()=>{
  const {app}=await setup();let writes=0;app.client.request=async(e,o)=>{if(o.method){writes++;throw new Error('The server may have accepted this write');}return {data:{id:'1',name:'Example',type:'static',attributes:{value:'one'}}};};
  const doc=await remoteEditor(app);doc.text=JSON.stringify({id:'1',name:'Example',type:'static',attributes:{value:'two'}});await assert.rejects(()=>doc.save(),/may have accepted/);await assert.rejects(()=>doc.save(),/previous write/);assert.equal(writes,1);
});
test('resource URI can restore its binding after provider restart',async()=>{
  const {app}=await setup();app.client.request=async()=>({data:{id:'1',name:'Example',type:'static',attributes:{value:'one'}}});const doc=await remoteEditor(app);
  app.files.forget(doc.uri);assert.equal((await app.files.entry(mock.Uri.parse(doc.uri.toString()))).environmentId,env.id);
});
test('source has nested schema and provisioning-policy collections with bound source ID',async()=>{
  const {app}=await setup();const rows=await app.envTree.getChildren({contextValue:'iscResource',env,resource:{version:'v2026',path:'/sources/{id}',params:{id:'source1'}}});assert.equal(rows.length,2);
  for(const row of rows)assert.equal(Object.values(row.params)[0],'source1');
});
test('API Catalog is opt-in and resource filesystem activates on reload',()=>{
  const pkg=require('../package.json');assert.equal(pkg.contributes.configuration.properties['iscWorkbench.showApiCatalog'].default,false);assert.equal(pkg.contributes.views.iscWorkbench.find(v=>v.id==='iscWorkbench.apis').when,'config.iscWorkbench.showApiCatalog');assert(pkg.activationEvents.includes('onFileSystem:isc-resource'));
});

test('environment/category order is alphabetical and lock icons reflect state',async()=>{
 const {app}=await setup();const envRows=await app.envTree.getChildren();assert.deepEqual(envRows.map(r=>r.label),['Dev','Production']);assert.equal(envRows[0].iconPath.id,'unlock');assert.equal(envRows[0].contextValue,'iscEnvironmentWritable');
 await app.setReadOnly(env,true);const locked=(await app.envTree.getChildren())[0];assert.equal(locked.iconPath.id,'lock');assert.equal(locked.contextValue,'iscEnvironmentLocked');
 const categories=await app.envTree.getChildren(locked);assert.deepEqual(categories.map(r=>r.label),[...categories.map(r=>r.label)].sort((a,b)=>app.compareLabels(a,b)));
});
test('collection sort spans API pages, and second UI page uses the cached list',async()=>{
 const {app}=await setup();app.saas.list=async()=>[];const calls=[];app.client.request=async(e,o)=>{calls.push(o);return {data:o.query.offset===0?Array.from({length:250},(_,i)=>({id:'id'+i,name:'Z '+i})):o.query.offset===250?[{id:'first',name:'Alpha'}]:[]};};
 const node={contextValue:'iscCollection',env,route:'/sources',offset:0,cacheKey:'source-list'};let rows=await app.envTree.getChildren(node);assert.equal(rows[0].label,'Alpha');assert.equal(calls.length,3);assert.equal(rows[0].resource.params.id,'first');
 node.offset=50;app.envTree.cache.delete(node.cacheKey);await app.envTree.getChildren(node);assert.equal(calls.length,3);
});
test('source reads use immutable ID regardless of display or backend-style name',async()=>{
 const {app}=await setup();app.client.request=async(e,o)=>({data:o.query.offset?[]:[{id:'api-uuid',name:'source-1788980854',displayName:'testing-nilay'}]});const rows=await app.envTree.getChildren({contextValue:'iscCollection',env,route:'/sources',offset:0,cacheKey:'sources'});
 assert.equal(rows[0].label,'testing-nilay');assert.equal(rows[0].resource.params.id,'api-uuid');assert.equal(rows[0].apiId,'api-uuid');
});
test('resources without an API ID do not fall back to display names',async()=>{
 const {app}=await setup();app.client.request=async(e,o)=>({data:o.query.offset?[]:[{name:'display-only'}]});const rows=await app.envTree.getChildren({contextValue:'iscCollection',env,route:'/sources',offset:0,cacheKey:'sources'});assert.equal(rows[0].command,undefined);
});
test('source creation asks name/type, resolves exact PAT owner and opens returned ID',async()=>{
 const {app,ctx}=await setup();await ctx.secrets.store('isc.credentials.dev',JSON.stringify({kind:'pat',clientId:'pat-client',clientSecret:'test-only'}));
 const connector={scriptName:'delimited-file',name:'Delimited File',type:'Delimited File'},calls=[];
 app.client.request=async(e,o)=>{calls.push(o);if(o.path==='/connectors')return {data:o.query.offset?[]:[connector]};if(o.path==='/personal-access-tokens')return {data:[{id:'other',owner:{id:'wrong'}},{id:'pat-client',owner:{id:'real-owner',name:'Owner'}}]};if(o.method==='POST')return {status:201,data:{id:'source-uuid',name:'Friendly Source'}};return {data:{id:'source-uuid',name:'Friendly Source'}};};
 answers.push('Friendly Source',{scriptName:'delimited-file'});await app.createResource({env,route:'/sources',label:'Sources'});
 const post=calls.find(c=>c.method==='POST');assert.deepEqual(JSON.parse(post.body),{name:'Friendly Source',description:'',connector:'delimited-file',owner:{type:'IDENTITY',id:'real-owner',name:'Owner'}});assert.equal(mock.window.activeTextEditor.document.uri.scheme,'isc-resource');assert(calls.some(c=>c.pathParams?.id==='source-uuid'));assert.equal(answers.length,0);
});
test('transform creation is name/type wizard and no raw API request document',async()=>{
 const {app}=await setup();const calls=[];app.client.request=async(e,o)=>{calls.push(o);return {data:{id:'new-transform',name:'Example',type:'static',attributes:{value:''}},status:201};};
 answers.push('Example',{label:'Static',template:require('../resources/upstream/transforms.json').Static.newtemplate});await app.createResource({env,route:'/transforms',label:'Transforms'});assert.deepEqual(JSON.parse(calls.find(c=>c.method==='POST').body),{name:'Example',type:'static',attributes:{value:''}});assert.equal(mock.window.activeTextEditor.document.uri.scheme,'isc-resource');assert(!mock.window.activeTextEditor.document.text.includes('isc-request'));
});
test('cancelled wizard and locked environment make no creation request',async()=>{
 const {app}=await setup();let writes=0;app.client.request=async()=>{writes++;throw new Error('Unexpected request');};answers.push(undefined);await app.createResource({env,route:'/transforms',label:'Transforms'});assert.equal(writes,0);await app.setReadOnly(env,true);await assert.rejects(()=>app.createResource({env,route:'/sources'}),/Unlock/);assert.equal(writes,0);
});
test('create accepted with delayed read is not reported as a failed creation',async()=>{
 const {app}=await setup();let posts=0;app.client.request=async(e,o)=>{if(o.method==='POST'){posts++;return {data:{id:'new-id',name:'New'}};}throw new Error('Not visible yet');};answers.push('New',{label:'Static',template:require('../resources/upstream/transforms.json').Static.newtemplate});await app.createResource({env,route:'/transforms'});assert.equal(posts,1);assert(messages.some(m=>m.includes('Read-back failed')));
});

test('creation completes on dialog acceptance without saving a draft',async()=>{
 const {app}=await setup();let posts=0;app.client.request=async(e,o)=>{if(o.method==='POST')posts++;return {data:{id:'created',name:'Instant',type:'static',attributes:{value:''}}};};
 answers.push('Instant',{template:require('../resources/upstream/transforms.json').Static.newtemplate});await app.createResource({env,route:'/transforms'});assert.equal(posts,1);assert(!messages.some(m=>m.includes('Draft ready')));
});
test('first draft save creates once; following save and restored URI update the same ID',async()=>{
 const {app}=await setup();let remote,posts=0,puts=0;app.client.request=async(e,o)=>{if(o.method==='POST'){posts++;remote={...JSON.parse(o.body),id:'stable-id'};}if(o.method==='PUT'){puts++;remote={...JSON.parse(o.body),id:'stable-id'};}return {data:structuredClone(remote)};};
 await app.files.openDraft({env,operation:'v2026:post:/transforms',params:{},text:JSON.stringify({name:'Draft',type:'static',attributes:{value:''}}),name:'Draft'});const doc=mock.window.activeTextEditor.document;
 await doc.save();let edited=JSON.parse(doc.text);edited.attributes.value='second';doc.text=JSON.stringify(edited);await doc.save();assert.equal(posts,1);assert.equal(puts,1);
 app.files.forget(doc.uri);const restored=await app.files.entry(doc.uri);assert.equal(restored.params.id,'stable-id');assert.equal(restored.createState,'created');assert.equal(restored.original.attributes.value,'second');
});
test('unknown creation receipt survives reopening and never resubmits POST',async()=>{
 const {app}=await setup();let posts=0;app.client.request=async()=>{posts++;throw new Error('Network failed: may have accepted');};await app.files.openDraft({env,operation:'v2026:post:/transforms',params:{},text:JSON.stringify({name:'Draft',type:'static',attributes:{value:''}}),name:'Draft'});const doc=mock.window.activeTextEditor.document;
 await assert.rejects(()=>doc.save(),/Network/);app.files.forget(doc.uri);await assert.rejects(()=>doc.save(),/will not resubmit/);assert.equal(posts,1);
});
test('source list shows every fetched configuration row including testing-nilay beyond row fifty',async()=>{
 const {app}=await setup();app.client.request=async(e,o)=>({data:o.query.offset?[]:[...Array.from({length:80},(_,i)=>({id:'s'+i,name:'A '+i})),{id:'actual-source-id',name:'testing-nilay'}]});
 const rows=await app.envTree.getChildren({env,contextValue:'iscCollection',route:'/sources',cacheKey:'all',offset:0});assert.equal(rows.length,81);assert(rows.some(r=>r.label==='testing-nilay'));assert(!rows.some(r=>r.label.startsWith('Load next')));
});
test('Find Source bypasses cache and opens a source returned by v2025 with that API ID',async()=>{
 const {app}=await setup();const calls=[];app.client.request=async(e,o)=>{calls.push(o);return {status:200,data:o.path==='/sources'?(o.version==='v2025'?[{id:'actual-id',name:'testing-nilay'}]:[]):{id:'actual-id',name:'testing-nilay'}};};
 answers.push('testing-nilay');await app.findSource({env});const entry=await app.files.entry(mock.window.activeTextEditor.document.uri);assert.equal(entry.version,'v2025');assert.equal(entry.params.id,'actual-id');assert(calls.some(c=>c.query?.filters==='name eq "testing-nilay"'));
});
test('Find Source reports absent results without claiming the source is deleted',async()=>{
 const {app}=await setup();app.client.request=async()=>({status:200,data:[]});answers.push('testing-nilay');await app.findSource({env});assert(mock.window.activeTextEditor.document.text.includes('does not prove'));
});
test('connector-rule script editor changes only script through the supported update API',async()=>{
 const {app}=await setup();let remote={id:'rule-id',name:'Rule',type:'BuildMap',sourceCode:{version:'1.0',script:'return null;'}},put;
 app.client.request=async(e,o)=>{if(o.method){put=JSON.parse(o.body);remote={...put,id:'rule-id'};}return {data:structuredClone(remote)};};
 const op=app.catalog.index.operations.find(o=>o.version==='v2026'&&o.method==='GET'&&/^\/connector-rules\/\{/.test(o.path));const params={[op.path.match(/\{([^}]+)\}/)[1]]:'rule-id'};
 await app.openRuleScript({env,label:'Rule',resource:{version:'v2026',path:op.path,params}});const doc=mock.window.activeTextEditor.document;assert.equal(doc.text,'return null;');doc.text='return new java.util.HashMap();';await doc.save();assert.equal(put.sourceCode.script,doc.text);assert.equal(put.type,'BuildMap');
});
test('workflow enable command rechecks environment lock before network access',async()=>{
 const {app}=await setup();await app.setReadOnly(env,true);app.client.request=async()=>{throw new Error('Unexpected network');};await assert.rejects(()=>app.setWorkflow({env,resource:{version:'v2026',path:'/workflows/{id}',params:{id:'w'}}},true),/read-only/);
});

test('workflow enable sends a documented update for the enabled field',async()=>{
 const {app}=await setup();let remote={id:'wf-id',name:'Workflow',enabled:false},update;
 app.client.request=async(e,o)=>{if(o.method){update=o;remote.enabled=true;}return {data:structuredClone(remote)};};
 await app.setWorkflow({env,resource:{version:'v2026',path:'/workflows/{id}',params:{id:'wf-id'}}},true);assert(update);assert(JSON.stringify(JSON.parse(update.body)).includes('true'));
});
test('source display alias is visible while the request uses the actual API ID',async()=>{
 const {app}=await setup();app.client.request=async(e,o)=>({data:o.query.offset?[]:[{id:'real-id',name:'source-123',connectorAttributes:{cloudDisplayName:'testing-nilay'}}]});
 const rows=await app.envTree.getChildren({env,contextValue:'iscCollection',route:'/sources',cacheKey:'aliases',offset:0});assert.equal(rows[0].label,'testing-nilay');assert.equal(rows[0].resource.params.id,'real-id');
});

test('short server pages advance by received rows and continue until empty',async()=>{
 const {app}=await setup();const offsets=[];app.client.request=async(e,o)=>{offsets.push(o.query.offset);return {data:o.query.offset===0?[{id:'1',name:'A'},{id:'2',name:'B'}]:o.query.offset===2?[{id:'3',name:'testing-nilay'}]:[]};};
 assert.equal((await app.listObjects(env,'/sources')).length,3);assert.deepEqual(offsets,[0,2,3]);
});
test('total count terminates pagination without unnecessary trailing request',async()=>{
 const {app}=await setup();let calls=0;app.client.request=async()=>{calls++;return {headers:{'x-total-count':'1'},data:[{id:'one'}]};};assert.equal((await app.listObjects(env,'/sources')).length,1);assert.equal(calls,1);
});
test('repeated API page is reported instead of silently duplicated',async()=>{
 const {app}=await setup();app.client.request=async()=>({data:[{id:'repeat'}]});await assert.rejects(()=>app.listObjects(env,'/sources'),/repeated a page/);
});
test('collection 404 falls back and binds detail editors to successful version',async()=>{
 const {app}=await setup();app.client.request=async(e,o)=>{if(e.version==='v2026')throw Object.assign(new Error('404'),{status:404});return {data:o.query.offset?[]:[{id:'machine-id',displayName:'Machine'}]};};
 const rows=await app.envTree.getChildren({env,contextValue:'iscCollection',route:'/machine-identities',label:'Machine Identities',cacheKey:'machines',offset:0});assert.equal(rows[0].resource.version,'v2025');assert.equal(rows[0].apiId,'machine-id');
});
test('403 is shown as unavailable access without fallback attempts',async()=>{
 const {app}=await setup();let calls=0;app.client.request=async()=>{calls++;throw Object.assign(new Error('403'),{status:403});};const rows=await app.envTree.getChildren({env,contextValue:'iscCollection',route:'/form-definitions',label:'Forms',cacheKey:'forms',offset:0});assert.equal(calls,1);assert.match(rows[0].label,/denied access/);
});
test('unoptimized aggregation uses multipart flag and actual source ID',async()=>{
 const {app}=await setup();let post;app.client.request=async(e,o)=>{if(o.method==='POST'){post=o;return {data:{taskId:'job'}};}return {data:{id:'source-id',connector:'active-directory'}};};answers.push('Run');await app.sourceAction({env,label:'AD',apiId:'source-id',resource:{version:'v2026',path:'/sources/{id}',params:{id:'source-id'}}},'unoptimized');assert.equal(post.body.get('disableOptimization'),'true');assert.equal(post.pathParams.id,'source-id');
});
test('locked source action performs no request',async()=>{
 const {app}=await setup();await app.setReadOnly(env,true);app.client.request=async()=>{throw new Error('Unexpected network');};await assert.rejects(()=>app.sourceAction({env},'unoptimized'),/Unlock/);
});

test('provisioning policies are read once without paging parameters',async()=>{
 const {app}=await setup();let calls=0;app.client.request=async(e,o)=>{calls++;assert.equal(o.query.offset,undefined);assert.equal(o.query.limit,undefined);return {data:[{name:'Create',usageType:'CREATE'},{name:'Update',usageType:'UPDATE'}]};};const list=await app.listObjects(env,'/sources/{sourceId}/provisioning-policies',{sourceId:'s'});assert.equal(list.length,2);assert.equal(calls,1);
});
test('action business failures produce a notification without opening an editor',async()=>{
 const {app}=await setup();const editor=mock.window.activeTextEditor;assert.equal(await app.actions.notify('Aggregation',{status:200,data:{task:{status:'FAILED',errors:['sensitive detail']}}}),false);assert.equal(mock.window.activeTextEditor,editor);assert(messages.some(m=>m.includes('Aggregation failed')));assert(!messages.some(m=>m.includes('sensitive detail')));
});
test('accepted job notification does not claim completion or open a page',async()=>{
 const {app}=await setup();const editor=mock.window.activeTextEditor;await app.actions.notify('Aggregation',{status:202,data:{taskId:'t'}});assert(messages.some(m=>m.includes('processing may still be running')));assert.equal(mock.window.activeTextEditor,editor);
});
test('role clone preserves references, removes ID and disables clone',async()=>{
 const {app}=await setup();let post;const original={id:'old',name:'Role',enabled:true,description:'Example',owner:{type:'IDENTITY',id:'owner'},accessProfiles:[{id:'ap',type:'ACCESS_PROFILE'}]};app.client.request=async(e,o)=>{if(o.method==='POST'){post=JSON.parse(o.body);return {data:{...post,id:'new'}};}return {data:original};};answers.push('Role Copy');await app.actions.clone({env,label:'Role',apiId:'old',resource:{version:'v2026',path:'/roles/{id}',params:{id:'old'}}});assert.equal(post.id,undefined);assert.equal(post.name,'Role Copy');assert.equal(post.enabled,false);assert.equal(post.accessProfiles[0].id,'ap');
});
test('delete requires exact name and uses actual ID',async()=>{
 const {app}=await setup();let sent;app.client.request=async(e,o)=>{sent=o;return {status:204,data:null};};const node={env,label:'Transform',resource:{version:'v2026',path:'/transforms/{id}',params:{id:'actual'}}};answers.push('wrong');await app.actions.remove(node);assert.equal(sent,undefined);answers.push('Transform');await app.actions.remove(node);assert.equal(sent.method,'DELETE');assert.equal(sent.pathParams.id,'actual');
});
test('source clone collision stops before importing',async()=>{
 const {app}=await setup();app.listObjects=async()=>[{name:'Existing'}];app.promotions.export=async()=>{throw new Error('Unexpected export');};answers.push('Clone');await assert.rejects(()=>app.actions.cloneSource({env,label:'Source',apiId:'old',resource:{version:'v2026'}},'Existing'),/already exists/);
});
test('source clone rewrites exported ID and previews before import',async()=>{
 const {app}=await setup();app.listObjects=async()=>[];app.promotions.export=async()=>({data:{options:{objectOptions:{SOURCE:{includedIds:['old']}}},objects:[{self:{id:'old',name:'Old',type:'SOURCE'},object:{id:'old',name:'Old',connectorAttributes:{cloudDisplayName:'Old'}}}]}});const calls=[];app.promotions.job=async(e,v,k,o)=>{calls.push(o);return {status:'COMPLETE',data:{results:{SOURCE:{errors:[]}}}};};answers.push('Clone');await app.actions.cloneSource({env,label:'Old',apiId:'old',resource:{version:'v2026',path:'/sources/{id}'}},'New');assert.equal(calls.length,2);assert.equal(calls[0].query.preview,true);const bundle=JSON.parse(await calls[1].body.get('data').text());assert.equal(bundle.objects[0].object.name,'New');assert.notEqual(bundle.objects[0].self.id,'old');assert.equal(bundle.objects[0].self.id,bundle.objects[0].object.id);
});
test('lock commands share fixed menu group and tenant delete is context only',()=>{
 const menus=require('../package.json').contributes.menus['view/item/context'];assert.equal(menus.find(m=>m.command==='iscWorkbench.lockEnvironment').group,menus.find(m=>m.command==='iscWorkbench.unlockEnvironment').group);assert(!menus.find(m=>m.command==='iscWorkbench.removeEnvironment').group.startsWith('inline'));assert.equal(menus.find(m=>m.command==='iscWorkbench.configureEnvironment').group,'inline@2');
});

test('configuration export preserves complete server SP-Config envelope and selected ID',async()=>{
 const {app,dir}=await setup();const bundle={version:1,timestamp:'time',tenant:'dev',options:{includeTypes:['ROLE']},objects:[{version:1,self:{id:'r',type:'ROLE',name:'Role'},object:{name:'Role'}}]};let call;app.promotions.export=async(e,v,o)=>{call={v,o};return {data:bundle};};const file=mock.Uri.file(path.join(dir,'role.json'));answers.push(file);await app.actions.export({env,label:'Role',apiId:'r',resource:{version:'v2026',path:'/roles/{id}'}});assert.equal(call.v,'beta');assert.deepEqual(call.o.objectOptions.ROLE.includedIds,['r']);assert.deepEqual(JSON.parse(await fs.readFile(file.fsPath,'utf8')),bundle);
});
test('collection configuration export scopes type without inventing a self block',async()=>{
 const {app}=await setup();let options;app.promotions.export=async(e,v,o)=>{options=o;return {data:{version:1,objects:[]}};};await app.actions.exportBundle({env,label:'Sources',route:'/sources'},undefined,()=>{});assert.deepEqual(options,{includeTypes:['SOURCE']});
});
test('export rejects wrong selected object rather than saving unrelated config',async()=>{
 const {app}=await setup();app.promotions.export=async()=>({data:{objects:[{self:{id:'wrong',type:'ROLE'},object:{}}]}});await assert.rejects(()=>app.actions.exportBundle({env,label:'Role',apiId:'right',resource:{path:'/roles/{id}'}}),/exactly Role/);
});
test('menus omit product prefix and use item-specific action labels',()=>{
 const pkg=require('../package.json');assert(pkg.contributes.commands.every(c=>!c.title.includes('ISC Workbench:')));const titles=pkg.contributes.commands.map(c=>c.title);assert(titles.includes('Clone Source…'));assert(titles.includes('Delete Role…'));assert(titles.includes('Export Access Profile Configuration (SP-Config)…'));assert(titles.includes('Create Provisioning Policy…'));
});
test('clone preview 500 uses beta and never submits apply or retries',async()=>{
 const {app}=await setup();app.listObjects=async()=>[];app.actions.exportBundle=async()=>({data:{objects:[{self:{id:'old',type:'SOURCE'},object:{id:'old'}}]}});let calls=0;app.promotions.job=async(e,v,k,o)=>{calls++;assert.equal(v,'beta');assert.equal(o.query.preview,true);assert.equal(typeof o.body.get('options'),'string');throw new Error('HTTP 500');};answers.push('Clone');await assert.rejects(()=>app.actions.cloneSource({env,label:'Old',apiId:'old',resource:{path:'/sources/{id}',version:'v2026'}},'New'),/No apply request was sent/);assert.equal(calls,1);
});

test('readable tab names keep same-name items isolated through URI metadata',async()=>{
 const {app}=await setup(),base={version:'v2026',path:'/sources/{id}',params:{id:'one'}};
 const a=app.files.uri(env,base,'Payroll'),b=app.files.uri(env,{...base,params:{id:'two'}},'Payroll');
 assert.equal(a.path.split('/').pop(),'Payroll.json');assert.notEqual(a.toString(),b.toString());
 assert.equal(JSON.parse(a.query).params.id,'one');
});
test('reload fetches current ISC data and resets conflict baseline without a write',async()=>{
 const {app}=await setup();let remote={id:'1',name:'Example',type:'static',attributes:{value:'old'}},writes=0;
 app.client.request=async(e,o)=>{if(o.method)writes++;return {data:structuredClone(remote)};};
 const doc=await remoteEditor(app),open=mock.workspace.openTextDocument,execute=mock.commands.executeCommand;
 try{
  mock.workspace.openTextDocument=async()=>doc;
  mock.commands.executeCommand=async id=>{assert.equal(id,'workbench.action.files.revert');doc.text=Buffer.from(await app.files.readFile(doc.uri)).toString();};
  remote.attributes.value='changed in UI';await app.files.reload(doc.uri);
  assert.equal(JSON.parse(doc.text).attributes.value,'changed in UI');assert.equal((await app.files.entry(doc.uri)).remote.attributes.value,'changed in UI');assert.equal(writes,0);
 }finally{mock.workspace.openTextDocument=open;mock.commands.executeCommand=execute;}
});
test('reload cancellation and quiet reopen preserve dirty edits and baseline',async()=>{
 const {app}=await setup();app.client.request=async()=>({data:{id:'1',name:'Example',type:'static',attributes:{value:'old'}}});const doc=await remoteEditor(app),open=mock.workspace.openTextDocument;
 try{mock.workspace.openTextDocument=async()=>doc;doc.isDirty=true;doc.text='local edits';let reads=0;app.client.request=async()=>{reads++;throw new Error('Must not fetch');};
  assert.equal(await app.files.reload(doc.uri,{quiet:true}),false);assert.equal(await app.files.reload(doc.uri),false);assert.equal(reads,0);assert.equal(doc.text,'local edits');assert.equal((await app.files.entry(doc.uri)).original.attributes.value,'old');
 }finally{mock.workspace.openTextDocument=open;}
});
test('reload aborts if the document changes during the remote fetch',async()=>{
 const {app}=await setup();app.client.request=async()=>({data:{id:'1',name:'Example',type:'static',attributes:{value:'old'}}});const doc=await remoteEditor(app),open=mock.workspace.openTextDocument;
 try{mock.workspace.openTextDocument=async()=>doc;app.client.request=async()=>{doc.text='typed while loading';return {data:{id:'1',name:'New'}};};await assert.rejects(()=>app.files.reload(doc.uri),/Edits changed/);assert.equal(doc.text,'typed while loading');assert.equal((await app.files.entry(doc.uri)).original.name,'Example');}
 finally{mock.workspace.openTextDocument=open;}
});
test('compare uses a read-only snapshot without rebasing or writing local edits',async()=>{
 const {app}=await setup();app.client.request=async()=>({data:{id:'1',name:'Example',type:'static',attributes:{value:'old'}}});const doc=await remoteEditor(app),execute=mock.commands.executeCommand;
 try{doc.text='unsaved edits';let args;mock.commands.executeCommand=async(...a)=>{args=a;};app.client.request=async(e,o)=>{assert(!o.method);return {data:{id:'1',name:'Changed remotely'}};};await app.files.compare(doc.uri);assert.equal(args[0],'vscode.diff');assert.equal(args[1].scheme,'isc-snapshot');assert.equal(args[2],doc.uri);assert(app.files.snapshots.get(args[1].toString()).includes('Changed remotely'));assert.equal(doc.text,'unsaved edits');assert.equal((await app.files.entry(doc.uri)).original.name,'Example');}
 finally{mock.commands.executeCommand=execute;}
});
test('completed clone releases progress and busy guard while notification stays open',async()=>{
 const {app}=await setup(),info=mock.window.showInformationMessage;
 app.listObjects=async()=>[];app.actions.exportBundle=async()=>({data:{objects:[{self:{id:'old',type:'SOURCE'},object:{id:'old',name:'Old'}}]}});
 app.promotions.job=async()=>({status:'COMPLETE',data:{results:{SOURCE:{errors:[]}}}});
 let notifications=0;mock.window.showInformationMessage=()=>{notifications++;return new Promise(()=>{});};answers.push('New','Clone');
 try{await app.actions.clone({env,label:'Old',apiId:'old',resource:{version:'v2026',path:'/sources/{id}',params:{id:'old'}}});assert.equal(notifications,1);assert.equal(app.actions.busy.size,0);}
 finally{mock.window.showInformationMessage=info;}
});
test('failed source clone releases busy guard and does not retry import',async()=>{
 const {app}=await setup();app.listObjects=async()=>[];app.actions.exportBundle=async()=>{throw new Error('Export failed');};answers.push('New','Clone');await assert.rejects(()=>app.actions.clone({env,label:'Old',apiId:'old',resource:{path:'/sources/{id}'}}),/Export failed/);assert.equal(app.actions.busy.size,0);
});
test('target name lookup scopes aggregation history to source ID and copies exact returned name',async()=>{
 const {app}=await setup(),calls=[];app.readResource=async()=>({data:{id:'123',name:'Payroll'}});app.client.request=async(e,o)=>{calls.push(o);return {data:[{target:{name:'Payroll [source-9876]'}}]};};
 const result=await app.actions.copySourceTargetName({env,apiId:'123',resource:{path:'/sources/{id}',version:'v2026',params:{id:'123'}}});assert.equal(result,'Payroll [source-9876]');assert.equal(mock.clipboardText,result);assert.equal(calls[0].query.filters,'sourceId eq "123" and type eq "CLOUD_ACCOUNT_AGGREGATION"');assert(!calls[0].method);
});
test('missing target name never fabricates a suffix or starts aggregation',async()=>{
 const {app}=await setup();app.readResource=async()=>({data:{id:'123',name:'Payroll'}});app.client.request=async(e,o)=>{assert.equal(o.path,'/task-status');assert(!o.method);return {data:[]};};mock.clipboardText='unchanged';await assert.rejects(()=>app.actions.copySourceTargetName({env,apiId:'123',resource:{path:'/sources/{id}',version:'v2026'}}),/No source target name/);assert.equal(mock.clipboardText,'unchanged');
});
