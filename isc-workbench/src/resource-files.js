'use strict';
const vscode=require('vscode');
const crypto=require('node:crypto');
const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
class ResourceFiles {
  constructor(app){this.app=app;this.entries=new Map();this.saving=new Set();this.manualSaves=new Map();this.changed=new vscode.EventEmitter();this.onDidChangeFile=this.changed.event;
    this.snapshots=new Map();
    app.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('isc-snapshot',{provideTextDocumentContent:uri=>this.snapshots.get(uri.toString())||''}),vscode.workspace.onDidCloseTextDocument(doc=>{this.snapshots.delete(doc.uri.toString());if(doc.uri.scheme==='isc-resource'&&!this.saving.has(doc.uri.toString()))this.forget(doc.uri);}));
    this.migration=this.migrateDrafts();this.migration.catch(()=>{});this.draftWrites=this.migration;
    app.context.subscriptions.push(vscode.workspace.onWillSaveTextDocument(event=>{
      if(event.document.uri.scheme!=='isc-resource')return;
      const key=event.document.uri.toString();this.manualSaves.delete(key);
      if(event.reason===vscode.TextDocumentSaveReason.Manual)this.manualSaves.set(key,{text:event.document.getText(),expires:Date.now()+5000});
    }));
  }
  async migrateDrafts(){const legacy=this.app.context.globalState.get('isc.drafts',{});if(!Object.keys(legacy).length)return;const current=JSON.parse(await this.app.context.secrets.get('isc.drafts.secure')||'{}');await this.app.context.secrets.store('isc.drafts.secure',JSON.stringify({...legacy,...current}));await this.app.context.globalState.update('isc.drafts',{});}
  uri(env,resource,label){return vscode.Uri.from({scheme:'isc-resource',authority:env.id,path:`/${env.name}/${resource.path.split('/').filter(p=>!p.startsWith('{')).join('/')}/${String(label).replace(/[\/\\]/g,'_')}${resource.kind==='script'?'.bsh':'.json'}`,query:JSON.stringify(resource)});}
  async entry(uri){
    await this.migration;
    this.app.trust();const key=uri.toString();if(this.entries.has(key))return this.entries.get(key);
    let resource;try{resource=JSON.parse(uri.query);}catch{throw vscode.FileSystemError.FileNotFound(uri);}
    const env=this.app.env(uri.authority);
    if(resource.kind==='draft'){
      const saved=JSON.parse(await this.app.context.secrets.get('isc.drafts.secure')||'{}')[resource.draftId];
      if(!saved||saved.environmentId!==env.id)throw vscode.FileSystemError.FileNotFound(uri);
      const entry={...saved,mtime:Date.now()};
      if(entry.createState==='created'){const data=(await this.app.readResource(env,entry)).data;entry.original=data;entry.remote=data;entry.uncertain=false;}
      this.entries.set(key,entry);return entry;
    }
    if(resource.kind==='saas'){
      if(!['connector','customizer','instance'].includes(resource.saasKind)||typeof resource.params?.id!=='string')throw vscode.FileSystemError.FileNotFound(uri);
      const data=await this.app.saas.readObject(env,resource.saasKind,resource.params.id);
      const entry={environmentId:env.id,...resource,original:data,mtime:Date.now()};this.entries.set(key,entry);return entry;
    }
    if(!this.app.findOp(resource.version,'GET',resource.path))throw vscode.FileSystemError.FileNotFound(uri);
    const response=await this.app.readResource(env,resource);
    const entry={environmentId:env.id,...resource,original:response.data,remote:response.data,mtime:Date.now()};this.entries.set(key,entry);return entry;
  }
  async recordDraft(entry){await this.migration;const write=this.draftWrites.catch(()=>{}).then(async()=>{const drafts=JSON.parse(await this.app.context.secrets.get('isc.drafts.secure')||'{}');const {environmentId,draftId,operation,initialText,createState,path,version,params}=entry;await this.app.context.secrets.store('isc.drafts.secure',JSON.stringify({...drafts,[draftId]:{environmentId,draftId,operation,initialText,createState,path,version,params}}));});this.draftWrites=write;await write;}
  async openDraft({env,operation,params,text,name}){
    const draftId=crypto.randomUUID(),op=this.app.catalog.operation(operation);
    const entry={environmentId:env.id,draftId,operation,initialText:text,createState:'draft',path:op.path,version:op.version,params,mtime:Date.now()};
    await this.recordDraft(entry);
    const uri=this.uri(env,{kind:'draft',draftId,path:op.path,params},'NEW — '+name);
    this.entries.set(uri.toString(),entry);
    const editor=await this.app.openFile(uri);
    await vscode.languages.setTextDocumentLanguage(editor.document,'json');
    const edit=new vscode.WorkspaceEdit();edit.insert(uri,editor.document.positionAt(editor.document.getText().length),'\n');
    if(!await vscode.workspace.applyEdit(edit))throw new Error('Could not prepare the editable draft.');
    await vscode.window.showInformationMessage('Draft ready. Ctrl+S creates this resource in ISC; Auto Save cannot create it.');
  }
  writable(entry){return !this.app.env(entry.environmentId).readOnly && (entry.kind==='saas'||entry.createState&&entry.createState!=='created'||this.app.canUpdate(entry));}
  bytes(e){if(e.kind==='script')return Buffer.from(e.original.sourceCode?.script||'');return e.createState&&e.createState!=='created'?Buffer.from(e.initialText):encode(e.original);}
  async stat(uri){const e=await this.entry(uri);return {type:vscode.FileType.File,ctime:0,mtime:e.mtime,size:this.bytes(e).length,permissions:this.writable(e)?undefined:vscode.FilePermission.Readonly};}
  async readFile(uri){return this.bytes(await this.entry(uri));}
  async writeFile(uri,content){
    const permit=this.manualSaves.get(uri.toString());this.manualSaves.delete(uri.toString());
    if(!permit||permit.expires<Date.now()||permit.text!==Buffer.from(content).toString('utf8'))throw vscode.FileSystemError.NoPermissions('Auto Save cannot write to ISC. Use an explicit Save (Ctrl+S).');
    const key=uri.toString(),e=await this.entry(uri);
    if(!this.writable(e))throw vscode.FileSystemError.NoPermissions('This environment or resource is read-only.');
    if(this.saving.has(key))throw vscode.FileSystemError.Unavailable('A save is already running.');
    this.saving.add(key);
    try{if(e.kind==='saas')await this.app.saas.saveObject(e,Buffer.from(content).toString('utf8'));else if(e.createState&&e.createState!=='created')await this.app.creation.submit(e,Buffer.from(content).toString('utf8'));else if(e.kind==='script'){const edited=structuredClone(e.original);edited.sourceCode={...edited.sourceCode,script:Buffer.from(content).toString('utf8')};await this.app.saveResource(e,JSON.stringify(edited));}else await this.app.saveResource(e,Buffer.from(content).toString('utf8'));e.mtime=Date.now();this.changed.fire([{type:vscode.FileChangeType.Changed,uri}]);}
    catch(error){if(error.code==='ISC_REMOTE_CHANGED')this.conflict(uri);throw error;}
    finally{this.saving.delete(key);}
  }
  async fresh(e){const env=this.app.env(e.environmentId);return e.kind==='saas'?this.app.saas.readObject(env,e.saasKind,e.params.id):(await this.app.readResource(env,e)).data;}
  async reload(uri=vscode.window.activeTextEditor?.document.uri,{quiet=false}={}){
    if(uri?.scheme!=='isc-resource')throw new Error('Open a connected ISC item first.');
    const key=uri.toString();if(this.saving.has(key))throw new Error('Wait for the current save to finish.');
    const e=await this.entry(uri);if(e.createState&&e.createState!=='created')throw new Error('This creation draft has no confirmed remote item to reload.');
    const doc=await vscode.workspace.openTextDocument(uri);
    if(doc.isDirty){if(quiet)return false;if(await vscode.window.showWarningMessage('Discard unsaved edits and reload the latest version from ISC?',{modal:true},'Reload from ISC')!=='Reload from ISC')return false;}
    const before=doc.getText(),data=await this.fresh(e);
    if(doc.getText()!==before)throw new Error('Edits changed while reloading. Nothing was discarded; retry Reload from ISC.');
    e.original=data;e.remote=data;e.uncertain=false;e.mtime=Date.now();this.manualSaves.delete(key);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    this.changed.fire([{type:vscode.FileChangeType.Changed,uri}]);return true;
  }
  async compare(uri=vscode.window.activeTextEditor?.document.uri){
    if(uri?.scheme!=='isc-resource')throw new Error('Open a connected ISC item first.');
    const e=await this.entry(uri);if(e.createState&&e.createState!=='created')throw new Error('This creation draft has no confirmed remote item to compare.');
    const data=await this.fresh(e),snapshot=vscode.Uri.from({scheme:'isc-snapshot',path:`/${crypto.randomUUID()}/Latest ISC${e.kind==='script'?'.bsh':'.json'}`});
    this.snapshots.set(snapshot.toString(),this.bytes({...e,original:data}).toString('utf8'));
    await vscode.commands.executeCommand('vscode.diff',snapshot,uri,'Latest ISC ↔ Your edits');
  }
  conflict(uri){
    void vscode.window.showWarningMessage('This item changed in ISC. Your edits are preserved; nothing was saved. Compare with the latest version or reload it.','Compare with Latest ISC','Reload from ISC').then(choice=>{
      if(choice==='Compare with Latest ISC')return this.compare(uri);
      if(choice==='Reload from ISC')return this.reload(uri);
    }).catch(error=>vscode.window.showErrorMessage(error.message));
  }
  permissionsChanged(id){for(const [key,e] of this.entries)if(e.environmentId===id)this.changed.fire([{type:vscode.FileChangeType.Changed,uri:vscode.Uri.parse(key)}]);}
  forget(uri){this.entries.delete(uri.toString());this.manualSaves.delete(uri.toString());}
  watch(){return new vscode.Disposable(()=>{});}
  readDirectory(){return [];}
  createDirectory(){throw vscode.FileSystemError.NoPermissions('Create resources using their documented creation command.');}
  delete(){throw vscode.FileSystemError.NoPermissions('Resource deletion is not a file operation.');}
  rename(){throw vscode.FileSystemError.NoPermissions('Resource renaming is not a file operation.');}
  dispose(){this.changed.dispose();}
}
module.exports={ResourceFiles};
