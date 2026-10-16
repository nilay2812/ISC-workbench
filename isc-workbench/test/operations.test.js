'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {mock,context,answers,messages}=require('./vscode-mock.cjs');const {App}=require('../src/extension');
const env={id:'sandbox',name:'Sandbox',baseUrl:'https://sandbox.api.identitynow.com',version:'v2026',readOnly:true};
async function setup(){answers.length=0;messages.length=0;mock.workspace.isTrusted=true;const dir=await fs.mkdtemp(path.join(os.tmpdir(),'isc-ops-'));const ctx=context(dir);await ctx.globalState.update('isc.environments',[env]);const channels=[];mock.window.createOutputChannel=name=>{const c={name,lines:[],appendLine(v){this.lines.push(v);},clear(){this.lines=[];},show(){},dispose(){}};channels.push(c);return c;};const app=new App(ctx);return {app,ops:app.operations,ctx,channels};}
test('Operations exposes all four groups and uses paged read-only requests',async()=>{
 const {ops,app}=await setup();const roots=await ops.getChildren();const groups=await ops.getChildren(roots[0]);assert.deepEqual(groups.map(g=>g.kind),['jobs','campaigns','activities','workflows']);let sent;app.client.request=async(e,o)=>{sent=o;assert(e.readOnly);return {data:[{id:'a',name:'Provisioning',completionStatus:'FAILURE'}]};};const rows=await ops.getChildren(groups[2]);assert.equal(sent.method,'GET');assert.equal(sent.query.limit,50);assert.equal(sent.query.sorters,'-created');assert.equal(rows[0].kind,'activity');assert.equal(rows.at(-1).offset,1);
});
test('Operations rejects repeated pages and keeps filtering on next pages',async()=>{
 const {ops,app}=await setup();app.client.request=async()=>({data:[{id:'same'}]});const group=ops.group(env,'activities','/account-activities',{filters:'type eq "appRequest"'});const first=await ops.getChildren(group);const next=first.at(-1);assert.equal(next.query.filters,group.query.filters);const second=await ops.getChildren(next);assert.match(second[0].label,/repeated/);
});
test('Operations reports denied access without fallback or tenant writes',async()=>{
 const {ops,app}=await setup();let calls=0;app.client.request=async()=>{calls++;throw Object.assign(new Error('Denied'),{status:403});};const rows=await ops.getChildren(ops.group(env,'campaigns','/campaigns'));assert.match(rows[0].label,/Access denied/);assert.equal(calls,1);mock.workspace.isTrusted=false;await assert.rejects(()=>ops.get(env,'/campaigns'),/Trust/);
});
test('campaign dashboard shows completion and report status child',async()=>{
 const {ops,app}=await setup();app.client.request=async()=>({data:[{id:'c',name:'Review',status:'ACTIVE',completedCertifications:3,totalCertifications:10,deadline:'2026-12-01T00:00:00Z'}]});const rows=await ops.getChildren(ops.group(env,'campaigns','/campaigns'));assert.match(rows[0].description,/3\/10 complete/);const children=await ops.getChildren(rows[0]);assert.equal(children[1].command.arguments[0].route,'/campaigns/{id}/reports');
});
test('workflow failed runs use documented status filter and history route',async()=>{
 const {ops,app}=await setup();const folders=await ops.getChildren({env,kind:'workflow',object:{id:'w'}});assert.equal(folders[1].query.filters,'status eq "Failed"');let sent;app.client.request=async(e,o)=>{sent=o;return {data:{history:{events:[]}}};};await ops.details({env,kind:'execution',object:{id:'run'}});assert.equal(sent.path,'/workflow-executions/{id}/history-v2');assert.equal(sent.pathParams.id,'run');
});
test('provisioning details render readable failures and mask known/keyed secrets',async()=>{
 const {ops,app,channels}=await setup();app.client.request=async()=>({data:{errors:['Connector rejected operation'],password:'hidden',items:[{name:'AD'}]}});await ops.details({env,kind:'activity',object:{id:'a'}});const output=channels.flatMap(c=>c.lines).join('\n');assert.match(output,/Connector rejected operation/);assert(!output.includes('hidden'));assert.match(output,/name: AD/);
});
test('aggregation monitor stops on completion and preserves zero counts',async()=>{
 const {ops,app,channels}=await setup();app.client.request=async()=>({data:{status:'COMPLETED',totalAccounts:0,processedAccounts:0}});ops.timer=()=>{throw new Error('Should not poll completed jobs');};await ops.monitor({env,label:'Job',object:{id:'job'}});assert.equal(ops.monitors.size,0);assert(channels.flatMap(c=>c.lines).some(t=>t.includes('accounts 0/0')));assert(messages.some(t=>t.includes('does not guarantee')));
});
test('aggregation stop cancels timer and in-flight signal',async()=>{
 const {ops,app}=await setup();let cancelled;ops.timer=()=>12;ops.clearTimer=id=>{cancelled=id;};app.client.request=async()=>({data:{status:'STARTED'}});const node={env,label:'Job',object:{id:'j'}};await ops.monitor(node);const state=ops.monitors.get('sandbox:j');ops.stop(node);assert.equal(cancelled,12);assert(state.controller.signal.aborted);assert.equal(ops.monitors.size,0);
});
test('workflow history and identity activities live under normal tree items',async()=>{
 const {app}=await setup();const runs=await app.envTree.getChildren({env,apiId:'w-id',contextValue:'iscWorkflowEnabled'});assert.equal(runs[0].params.id,'w-id');assert.equal(runs[1].query.filters,'status eq "Failed"');const activities=await app.envTree.getChildren({env,apiId:'person-id',contextValue:'iscIdentity'});assert.equal(activities[0].query['regarding-identity'],'person-id');
});
test('main environment includes activities and manifest has no Operations view',async()=>{
 const {app}=await setup();const rows=await app.envTree.getChildren({env,contextValue:'iscEnvironmentLocked'});assert(rows.some(n=>n.label==='Provisioning Activities'));const pkg=require('../package.json');assert(!pkg.contributes.views.iscWorkbench.some(v=>v.id==='iscWorkbench.operations'));assert(!pkg.contributes.commands.some(c=>c.command==='iscWorkbench.openOperations'));
});
test('legacy sensitive drafts migrate to SecretStorage before plaintext is cleared',async()=>{
 const ctx=context(await fs.mkdtemp(path.join(os.tmpdir(),'isc-drafts-')));await ctx.globalState.update('isc.drafts',{draft1:{environmentId:'sandbox',initialText:'sensitive-body'}});const app=new App(ctx);await app.files.migration;assert.deepEqual(ctx.globalState.get('isc.drafts'),{});assert.equal(JSON.parse(await ctx.secrets.get('isc.drafts.secure')).draft1.initialText,'sensitive-body');
 await Promise.all([app.files.recordDraft({draftId:'a',initialText:'a'}),app.files.recordDraft({draftId:'b',initialText:'b'})]);const saved=JSON.parse(await ctx.secrets.get('isc.drafts.secure'));assert(saved.a&&saved.b&&saved.draft1);assert(!JSON.stringify([...ctx.state]).includes('sensitive-body'));
});
test('failed SecretStorage migration retains the original draft and rejects reads',async()=>{
 const ctx=context(await fs.mkdtemp(path.join(os.tmpdir(),'isc-drafts-')));await ctx.globalState.update('isc.drafts',{d:{initialText:'preserve'}});ctx.secrets.store=async()=>{throw new Error('Keychain unavailable');};const app=new App(ctx);await assert.rejects(()=>app.files.migration,/Keychain/);assert.equal(ctx.globalState.get('isc.drafts').d.initialText,'preserve');
});
test('SaaS instance opens the normal source document using actual source ID',async()=>{
 const {app}=await setup();app.listObjects=async()=>{throw new Error('Full inventory must not be fetched');};app.client.request=async(e,o)=>{assert.equal(o.query.filters,'name eq \"Backend\"');assert.equal(o.query.limit,2);return {data:[{id:'real-source',name:'Backend',displayName:'Display'}]};};let opened;app.openResource=async n=>{opened=n;};await app.saas.inspect({env,kind:'instance',object:{id:'platform-instance',name:'Backend'}});assert.equal(opened.resource.path,'/sources/{id}');assert.equal(opened.resource.params.id,'real-source');assert.equal(opened.label,'Display');assert.equal(opened.resource.kind,undefined);
});
test('ambiguous SaaS source match offers Find Source and does not open arbitrary data',async()=>{
 const {app}=await setup();app.client.request=async()=>({data:[{id:'1',name:'Same'},{id:'2',name:'Same'}]});let opened=false;app.openResource=async()=>{opened=true;};await app.saas.inspect({env,kind:'instance',object:{id:'other',name:'Same'}});assert.equal(opened,false);assert(messages.some(m=>m.includes('No unique source match')));
});
