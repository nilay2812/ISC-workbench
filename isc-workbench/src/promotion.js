'use strict';
const vscode=require('vscode');
const {hash,canonical,bundleCheck,comparison,applyMappings,importIssues}=require('./core');
const {pollJob,importForm}=require('./client');
const enc=new TextEncoder();
class Promotions {
  constructor(app){this.app=app;this.approvals=new Map();this.busy=new Set();}
  async save(folder,name,data){await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder,name),enc.encode(JSON.stringify(data,null,2)+'\n'));}
  async read(folder,name){return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder,name))).toString('utf8'));}
  async folder(){const p=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Choose promotion folder'});return p?.[0];}
  async progress(title,fn){return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title,cancellable:true},async(p,t)=>{const controller=new AbortController();const sub=t.onCancellationRequested(()=>controller.abort());try{return await fn(controller.signal,s=>p.report({message:s}));}finally{sub.dispose();}});}
  async job(env,version,kind,options,signal,report){
    const res=await this.app.client.request(env,{version,path:`/sp-config/${kind}`,method:'POST',...options,signal});
    const jobId=res.data?.jobId;
    if(!jobId)throw new Error('Server returned no job ID');
    const job={environmentId:env.id,version,kind,jobId,createdAt:new Date().toISOString()};
    await this.app.context.globalState.update('isc.jobs',[job,...this.app.context.globalState.get('isc.jobs',[])].slice(0,50));
    report(`Accepted job ${jobId}`);
    let status;
    try{status=await pollJob(this.app.client,env,version,kind,jobId,signal,report);}
    catch(error){
      if(kind!=='import'||signal?.aborted)throw error;
      status=(await this.app.client.request(env,{version,path:`/sp-config/${kind}/{id}`,pathParams:{id:jobId},signal})).data;
      if(!['FAILED','CANCELLED'].includes(status.status))throw error;
    }
    const downloaded=await this.app.client.request(env,{version,path:`/sp-config/${kind}/{id}/download`,pathParams:{id:jobId},signal});
    return {jobId,status:status.status,data:downloaded.data};
  }
  export(env,version,options,signal,report){return this.job(env,version,'export',{nonMutatingJob:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(options)},signal,report);}
  async create(){
    this.app.trust();
    const source=await this.app.pickEnv('Source environment');if(!source)return;
    const target=await this.app.pickEnv('Target environment',source.id);if(!target)return;
    if(source.baseUrl===target.baseUrl)throw new Error('Choose two different tenant API hosts');
    const version=await vscode.window.showQuickPick(['v2026','v2025','v2024','beta'],{title:'Promotion API version'});if(!version)return;
    const configs=(await this.app.client.request(source,{version,path:'/sp-config/config-objects'})).data;
    if(!Array.isArray(configs))throw new Error('Config object discovery did not return a list');
    const picked=await vscode.window.showQuickPick(configs.filter(c=>c.exportable).map(c=>({label:c.objectType,description:c.signatureRequired?'Signed: cannot edit exported payload':'',config:c})),{title:'Select configuration types to promote',canPickMany:true});
    if(!picked?.length)return;
    const names=await vscode.window.showInputBox({title:'Optional exact object names, separated by commas',prompt:'Leave empty to export every object of the selected types. Dependencies must be present in target or included.',value:''});if(names===undefined)return;
    const exportOptions={includeTypes:picked.map(p=>p.label)};
    if(names.trim())exportOptions.objectOptions=Object.fromEntries(picked.map(p=>[p.label,{includedNames:names.split(',').map(n=>n.trim()).filter(Boolean)}]));
    const folder=await this.folder();if(!folder)return;
    try{await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder,'promotion.json'));throw new Error('This folder already contains a promotion; choose a new folder');}catch(e){if(e.code!=='FileNotFound')throw e;}
    await this.progress('Preparing promotion snapshots',async(signal,report)=>{
      const src=await this.export(source,version,exportOptions,signal,report);bundleCheck(src.data);
      // Full target types preserve a recovery snapshot and catch name collisions.
      const baseline=await this.export(target,version,{includeTypes:exportOptions.includeTypes},signal,report);
      if(!Array.isArray(baseline.data?.objects))throw new Error('Target export did not contain an objects array');
      await this.save(folder,'source.json',src.data);
      await this.save(folder,'candidate.json',src.data);
      await this.save(folder,'target-baseline.json',baseline.data);
      await this.save(folder,'mappings.json',[]);
      await this.save(folder,'object-configurations.json',configs);
      await this.save(folder,'promotion.json',{kind:'isc-promotion',formatVersion:1,sourceEnvironmentId:source.id,targetEnvironmentId:target.id,sourceOrigin:source.baseUrl,targetOrigin:target.baseUrl,version,includeTypes:exportOptions.includeTypes,sourceExportJobId:src.jobId,targetExportJobId:baseline.jobId,createdAt:new Date().toISOString()});
      await this.save(folder,'comparison.json',comparison(src.data,baseline.data));
      await this.save(folder,'READ-ME.json',{nextSteps:['Review candidate.json and comparison.json. Edit candidate.json or use explicit JSON Pointer replacements in mappings.json.','Run ISC Workbench: Apply Promotion Mappings if mappings.json was edited.','Run ISC Workbench: Preview Promotion and inspect preview-result.json.','Run ISC Workbench: Apply Promotion. A fresh preview and target drift check run before confirmation.'],mappingExample:{pointer:'/objects/0/object/owner/id',from:'SOURCE_ID',to:'TARGET_ID'},notes:['Snapshots may contain sensitive configuration. Store this folder securely.','SailPoint resolves supported references during preview. Arbitrary IDs embedded in scripts or workflow strings need review.','A backup is not a transaction: import may partially succeed. Recovery requires a separate reviewed import; new objects may require manual removal.']});
    });
    await this.app.openFile(vscode.Uri.joinPath(folder,'comparison.json'));
    await vscode.window.showInformationMessage('Promotion prepared. Review candidate.json; run Preview Promotion when ready.');
  }
  async load(folder){
    this.app.trust();
    const meta=await this.read(folder,'promotion.json');
    if(meta.kind!=='isc-promotion'||meta.formatVersion!==1||!['v2026','v2025','v2024','beta'].includes(meta.version)||!Array.isArray(meta.includeTypes)||!meta.includeTypes.length)throw new Error('Invalid promotion manifest');
    const source=this.app.env(meta.sourceEnvironmentId),target=this.app.env(meta.targetEnvironmentId);
    if(source.baseUrl!==meta.sourceOrigin||target.baseUrl!==meta.targetOrigin||source.baseUrl===target.baseUrl)throw new Error('Environment hosts changed or are identical. Create a new promotion.');
    const original=await this.read(folder,'source.json'),candidate=await this.read(folder,'candidate.json'),baseline=await this.read(folder,'target-baseline.json');
    bundleCheck(original);bundleCheck(candidate);
    if(!Array.isArray(baseline.objects))throw new Error('Invalid target baseline');
    // Refresh server configuration rules instead of trusting a modified local file.
    const configs=(await this.app.client.request(source,{version:meta.version,path:'/sp-config/config-objects'})).data;
    if(!Array.isArray(configs))throw new Error('Invalid configuration rules');
    for(const o of candidate.objects){
      const old=original.objects.find(s=>hash(s.self)===hash(o.self));
      if(!old)throw new Error('Candidate object metadata changed or object was added. Create a new export for these changes.');
      if(!meta.includeTypes.includes(o.self.type))throw new Error('Candidate type is outside the promotion scope');
      const config=configs.find(c=>c.objectType===o.self.type);
      if(!config || !config.exportable)throw new Error('Candidate type not supported by source export service');
      if(config.signatureRequired && hash(old)!==hash(o))throw new Error(`Signed object ${o.self.name} cannot be modified`);
    }
    return {meta,source,target,original,candidate,baseline,configs};
  }
  async mappings(){
    const folder=await this.folder();if(!folder)return;
    const {original,configs}=await this.load(folder);
    const mapped=applyMappings(original,await this.read(folder,'mappings.json'),configs);
    if(await vscode.window.showWarningMessage('Replace candidate.json with source.json plus the explicit mappings? Existing manual candidate edits will be replaced.',{modal:true},'Replace candidate')!=='Replace candidate')return;
    await this.save(folder,'candidate.json',mapped);this.approvals.delete(folder.toString());
    await this.app.openFile(vscode.Uri.joinPath(folder,'candidate.json'));
  }
  async previewAt(folder,loaded,signal,report){
    const {meta,target,candidate,baseline}=loaded;
    const preview=await this.job(target,meta.version,'import',{nonMutatingJob:true,query:{preview:true},body:importForm(candidate)},signal,report);
    await this.save(folder,'preview-result.json',preview);
    const issues=importIssues(preview.data);
    await this.save(folder,'comparison.json',comparison(candidate,baseline));
    if(preview.status!=='COMPLETE'||issues.errors.length)throw new Error(`Preview ${preview.status}: ${issues.errors.length} errors. See preview-result.json. Import blocked.`);
    return {preview,issues};
  }
  async preview(){
    const folder=await this.folder();if(!folder)return;
    const loaded=await this.load(folder);
    await this.progress(`Preview against ${loaded.target.name}`,async(signal,report)=>this.previewAt(folder,loaded,signal,report));
    await this.app.openFile(vscode.Uri.joinPath(folder,'preview-result.json'));
    await vscode.commands.executeCommand('vscode.diff',vscode.Uri.joinPath(folder,'target-baseline.json'),vscode.Uri.joinPath(folder,'candidate.json'),'Target baseline ↔ promotion candidate');
  }
  async apply(){
    const folder=await this.folder();if(!folder)return;
    const loaded=await this.load(folder);
    const {meta,target,candidate,baseline}=loaded;
    if(target.readOnly)throw new Error('Target is read-only. Enable writes using Configure Environment.');
    if(this.busy.has(target.id))throw new Error('Another promotion is running against this target');
    this.busy.add(target.id);
    try{
      await this.progress(`Validate promotion to ${target.name}`,async(signal,report)=>{
        const current=await this.export(target,meta.version,{includeTypes:meta.includeTypes},signal,report);
        await this.save(folder,'target-current.json',current.data);
        if(snapshotHash(current.data)!==snapshotHash(baseline))throw new Error('Target configuration changed since the baseline. Review target-current.json and create a fresh promotion. Import blocked.');
        const {issues}=await this.previewAt(folder,loaded,signal,report);
        await this.app.openFile(vscode.Uri.joinPath(folder,'preview-result.json'));
        const confirmation=await vscode.window.showInputBox({title:`Import ${candidate.objects.length} objects into ${target.name}`,prompt:`Inspect preview-result.json first. ${issues.warnings.length} warnings. Type the exact target name to apply with a backup.`,ignoreFocusOut:true});
        if(confirmation!==target.name)return;
        if(hash(await this.read(folder,'candidate.json'))!==hash(candidate)||hash(await this.read(folder,'promotion.json'))!==hash(meta))throw new Error('Promotion files changed during review. Run Apply again.');
        // Recheck after the human review; service has no transactional compare-and-swap.
        const latest=await this.export(target,meta.version,{includeTypes:meta.includeTypes},signal,report);
        if(snapshotHash(latest.data)!==snapshotHash(baseline))throw new Error('Target changed during review. Import blocked.');
        const live=this.app.env(target.id);
        if(live.readOnly||live.baseUrl!==target.baseUrl)throw new Error('Target settings changed during review');
        const runId=new Date().toISOString().replace(/[:.]/g,'-');
        const result=await this.job(live,meta.version,'import',{body:importForm(candidate)},signal,report);
        await this.save(folder,`import-result-${runId}.json`,result);
        if(result.data.exportJobId){
          const backup=await this.app.client.request(live,{version:meta.version,path:'/sp-config/export/{id}/download',pathParams:{id:result.data.exportJobId},signal});
          await this.save(folder,`backup-${runId}.json`,backup.data);
        }
        const issuesAfter=importIssues(result.data);
        if(result.status!=='COMPLETE'||issuesAfter.errors.length)throw new Error(`Import ${result.status} with ${issuesAfter.errors.length} object errors; partial changes are possible. Review import-result-${runId}.json and the backup.`);
        await vscode.window.showInformationMessage(`Import job complete for ${target.name}. Review import-result-${runId}.json (${issuesAfter.warnings.length} warnings).`);
      });
    }finally{this.busy.delete(target.id);}
  }
  async resume(){
    this.app.trust();
    const jobs=this.app.context.globalState.get('isc.jobs',[]);
    const item=await vscode.window.showQuickPick(jobs.map(j=>({label:`${j.kind} ${j.jobId}`,description:`${this.app.env(j.environmentId).name} · ${j.createdAt}`,job:j})),{title:'Resume or inspect a submitted SP-Config job'});if(!item)return;
    const j=item.job,env=this.app.env(j.environmentId);
    const status=await this.app.client.request(env,{version:j.version,path:`/sp-config/${j.kind}/{id}`,pathParams:{id:j.jobId}});
    await this.app.showJson(`Job ${j.jobId}`,status.data);
    if(['COMPLETE','FAILED','CANCELLED'].includes(status.data.status)){
      const result=await this.app.client.request(env,{version:j.version,path:`/sp-config/${j.kind}/{id}/download`,pathParams:{id:j.jobId}});
      await this.app.showJson(`Job result ${j.jobId}`,result.data);
    }
  }
}
function snapshotHash(bundle){
  if(!Array.isArray(bundle?.objects))throw new Error('Invalid snapshot');
  return hash(bundle.objects.map(o=>canonical(o)).sort((a,b)=>JSON.stringify(a.self).localeCompare(JSON.stringify(b.self))));
}
module.exports={Promotions,snapshotHash};
