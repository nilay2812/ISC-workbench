'use strict';
const vscode=require('vscode');
const path=require('node:path');
const crypto=require('node:crypto');
const {jsonPatch,canonical,Catalog,resolve,validate,sample,tenantUrl,urlFor,serializeQuery,redact,hash,SAFE}=require('./core');
const {Client}=require('./client');
const {Promotions}=require('./promotion');
const {ResourceFiles}=require('./resource-files');
const {Operations}=require('./operations');
const {Creation,shape:requestShape}=require('./creation');
const {Actions}=require('./actions');
const {SaaS}=require('./saas');
const json=value=>JSON.stringify(value,null,2)+'\n';
const ITEM_TYPES={"/sources": {"label": "Source", "context": "iscSource"}, "/transforms": {"label": "Transform", "context": "iscTransform"}, "/roles": {"label": "Role", "context": "iscRole"}, "/access-profiles": {"label": "Access Profile", "context": "iscAccessProfile"}, "/connector-rules": {"label": "Connector Rule", "context": "iscConnectorRule"}, "/workflows": {"label": "Workflow", "context": "iscWorkflow"}, "/identity-profiles": {"label": "Identity Profile", "context": "iscIdentityProfile"}, "/identity-attributes": {"label": "Identity Attribute", "context": "iscIdentityAttribute"}, "/form-definitions": {"label": "Form", "context": "iscForm"}, "/workgroups": {"label": "Governance Group", "context": "iscGovernanceGroup"}, "/source-apps": {"label": "Application", "context": "iscApplication"}, "/identities": {"label": "Identity", "context": "iscIdentity"}, "/accounts": {"label": "Account", "context": "iscAccount"}, "/entitlements": {"label": "Entitlement", "context": "iscEntitlement"}, "/machine-identities": {"label": "Machine Identity", "context": "iscMachineIdentity"}, "schemas": {"label": "Schema", "context": "iscSchema"}, "provisioning-policies": {"label": "Provisioning Policy", "context": "iscProvisioningPolicy"}};
const RESOURCES=[['Sources','/sources'],['Transforms','/transforms'],['Connector Rules','/connector-rules'],['Workflows','/workflows'],['Identity Profiles','/identity-profiles'],['Identity Attributes','/identity-attributes'],['Access Profiles','/access-profiles'],['Roles','/roles'],['Identities','/identities'],['Accounts','/accounts'],['Entitlements','/entitlements'],['Governance Groups','/workgroups'],['Applications','/source-apps'],['Forms','/form-definitions'],['Machine Identities','/machine-identities']];
class App {
  constructor(context){
    this.context=context;this.catalog=new Catalog(context.asAbsolutePath('resources'));this.resources=new Map();this.runs=new Set();
    this.output=vscode.window.createOutputChannel('ISC Workbench — Requests');context.subscriptions.push(this.output);
    this.client=new Client(async id=>{const value=await context.secrets.get('isc.credentials.'+id);return value?JSON.parse(value):undefined;},{audit:event=>this.output.appendLine(JSON.stringify(event))});
    this.actions=new Actions(this);this.promotions=new Promotions(this);this.creation=new Creation(this);
    this.envTree=new EnvironmentTree(this);this.apiTree=new ApiTree(this);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('iscWorkbench.environments',this.envTree),vscode.window.registerTreeDataProvider('iscWorkbench.apis',this.apiTree));
    this.files=new ResourceFiles(this);
    context.subscriptions.push(this.files,vscode.workspace.registerFileSystemProvider('isc-resource',this.files,{isCaseSensitive:true}));
    this.register();this.saas=new SaaS(this);this.operations=new Operations(this);
  }
  trust(){if(!vscode.workspace.isTrusted)throw new Error('Trust this VS Code workspace before accessing tenant data or credentials.');}
  envs(){return this.context.globalState.get('isc.environments',[]);}
  env(id){const env=this.envs().find(e=>e.id===id);if(!env)throw new Error('Environment no longer exists. Add it or select another environment.');return env;}
  async pickEnv(title='Choose environment',exclude){const selected=await vscode.window.showQuickPick(this.envs().filter(e=>e.id!==exclude).map(e=>({label:e.name,description:`${e.baseUrl} · ${e.readOnly?'read-only':'writes enabled'}`,env:e})),{title});return selected?.env;}
  async openFile(uri){return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));}
  async showJson(title,data){const doc=await vscode.workspace.openTextDocument({language:'json',content:json(data)});await vscode.window.showTextDocument(doc);return doc;}
  command(name,fn){this.context.subscriptions.push(vscode.commands.registerCommand('iscWorkbench.'+name,async(...args)=>{try{return await fn(...args);}catch(e){await vscode.window.showErrorMessage(e instanceof Error?e.message:'ISC operation failed');}}));}
  register(){
    this.command('reloadFromISC',()=>this.files.reload());
    this.command('compareWithISC',()=>this.files.compare());
    this.command('copySourceTargetName',node=>this.actions.copySourceTargetName(node));
    this.command('cloneResource',node=>this.actions.clone(node));
    this.command('exportResource',node=>this.actions.export(node));
    this.command('deleteResource',node=>this.actions.remove(node));
    this.command('enableResource',node=>this.actions.enabled(node,true));
    this.command('disableResource',node=>this.actions.enabled(node,false));
    this.command('cloneResourceSource',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceSource',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceSource',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsSource',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceSource',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceSource',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceSource',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceSource',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdSource',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionSource',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceTransform',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceTransform',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceTransform',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsTransform',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceTransform',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceTransform',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceTransform',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceTransform',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdTransform',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionTransform',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceRole',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceRole',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceRole',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsRole',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceRole',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceRole',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceRole',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceRole',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdRole',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionRole',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionAccessProfile',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionConnectorRule',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionWorkflow',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionIdentityProfile',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionIdentityAttribute',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceForm',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceForm',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceForm',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsForm',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceForm',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceForm',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceForm',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceForm',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdForm',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionForm',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionGovernanceGroup',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceApplication',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceApplication',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceApplication',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsApplication',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceApplication',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceApplication',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceApplication',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceApplication',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdApplication',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionApplication',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceIdentity',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceIdentity',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceIdentity',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsIdentity',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceIdentity',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceIdentity',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceIdentity',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceIdentity',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdIdentity',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionIdentity',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceAccount',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceAccount',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceAccount',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsAccount',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceAccount',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceAccount',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceAccount',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceAccount',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdAccount',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionAccount',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionEntitlement',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionMachineIdentity',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceSchema',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceSchema',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceSchema',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsSchema',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceSchema',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceSchema',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceSchema',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceSchema',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdSchema',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionSchema',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('cloneResourceProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.cloneResource',node));
    this.command('exportResourceProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.exportResource',node));
    this.command('deleteResourceProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.deleteResource',node));
    this.command('resourceActionsProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.resourceActions',node));
    this.command('enableResourceProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.enableResource',node));
    this.command('disableResourceProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.disableResource',node));
    this.command('createResourceProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.createResource',node));
    this.command('openResourceProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.openResource',node));
    this.command('copyResourceIdProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.copyResourceId',node));
    this.command('refreshCollectionProvisioningPolicy',node=>vscode.commands.executeCommand('iscWorkbench.refreshCollection',node));
    this.command('home',()=>this.home());
    this.command('addEnvironment',()=>this.addEnvironment());
    this.command('toggleWrites',node=>this.toggleWrites(node?.env));
    this.command('unlockEnvironment',node=>this.setReadOnly(node?.env,false));
    this.command('lockEnvironment',node=>this.setReadOnly(node?.env,true));
    this.command('copyResourceId',async node=>{const id=node?.apiId;if(id===undefined)throw new Error('No API resource ID is available');await vscode.env.clipboard.writeText(String(id));});
    this.command('refreshCollection',node=>this.envTree.refresh());
    this.command('refreshConnectorTypes',node=>this.creation.refreshConnectorTypes(node));
    this.command('resourceActions',node=>this.resourceActions(node));
    this.command('aggregateSource',node=>this.sourceAction(node,'aggregate'));
    this.command('aggregateSourceUnoptimized',node=>this.sourceAction(node,'unoptimized'));
    this.command('testSource',node=>this.sourceAction(node,'test'));
    this.command('pingSource',node=>this.sourceAction(node,'ping'));
    this.command('findSource',node=>this.findSource(node));
    this.command('openRuleScript',node=>this.openRuleScript(node));
    this.command('enableWorkflow',node=>this.setWorkflow(node,true));
    this.command('disableWorkflow',node=>this.setWorkflow(node,false));
    this.command('configureEnvironment',node=>this.configureEnvironment(node?.env));
    this.command('removeEnvironment',node=>this.removeEnvironment(node?.env));
    this.command('testConnection',node=>this.testConnection(node?.env));
    this.command('refresh',()=>this.envTree.refresh());
    this.command('searchApi',()=>this.searchApi());
    this.command('newRequest',(op)=>this.newRequest(op?.key||op));
    this.command('runRequest',()=>this.runRequest());
    this.command('requestDocs',()=>this.requestDocs());
    this.command('operationDetails',node=>this.operationDetails(node?.key||node));
    this.command('openResource',node=>this.openResource(node));
    this.command('publishResource',()=>this.publishResource());
    this.command('createResource',node=>this.createResource(node));
    this.command('nextPage',node=>this.envTree.nextPage(node));
    this.command('newPromotion',()=>this.promotions.create());
    this.command('applyMappings',()=>this.promotions.mappings());
    this.command('previewPromotion',()=>this.promotions.preview());
    this.command('applyPromotion',()=>this.promotions.apply());
    this.command('resumeJob',()=>this.promotions.resume());
    this.command('showLog',()=>this.output.show());
    this.context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc=>{this.resources.delete(doc.uri.toString());if(doc.uri.scheme==='isc-resource')this.files.forget(doc.uri);}));
  }
  async addEnvironment(){
    this.trust();
    const name=await vscode.window.showInputBox({title:'Environment name',placeHolder:'Development / UAT / Production',validateInput:v=>!v.trim()?'Enter a name':this.envs().some(e=>e.name===v.trim())?'Name already exists':null});if(!name)return;
    const base=await vscode.window.showInputBox({title:'SailPoint tenant API origin',placeHolder:'https://your-tenant.api.identitynow.com',validateInput:v=>{try{tenantUrl(v);return null;}catch(e){return e.message;}}});if(!base)return;
    const credentials=await this.askCredentials();if(!credentials)return;
    const env={id:crypto.randomUUID(),name:name.trim(),baseUrl:tenantUrl(base),readOnly:true,version:'v2026'};
    await this.context.secrets.store('isc.credentials.'+env.id,JSON.stringify(credentials));
    await this.context.globalState.update('isc.environments',[...this.envs(),env]);this.envTree.refresh();
    await vscode.window.showInformationMessage(`${env.name} added in read-only mode. Use Configure Environment to enable writes.`);
  }
  async askCredentials(){
    const kind=await vscode.window.showQuickPick([{label:'Personal Access Token / OAuth client credentials',value:'pat'},{label:'Short-lived bearer access token',value:'token'}],{title:'Authentication method'});if(!kind)return;
    if(kind.value==='token'){const accessToken=await vscode.window.showInputBox({title:'Bearer token',password:true,ignoreFocusOut:true});return accessToken?{kind:'token',accessToken}:undefined;}
    const clientId=await vscode.window.showInputBox({title:'Client ID',ignoreFocusOut:true});if(!clientId)return;
    const clientSecret=await vscode.window.showInputBox({title:'Client secret',password:true,ignoreFocusOut:true});return clientSecret?{kind:'pat',clientId,clientSecret}:undefined;
  }
  async configureEnvironment(env){
    this.trust();env=env?this.env(env.id):await this.pickEnv();if(!env)return;
    const action=await vscode.window.showQuickPick(['Change API version',env.readOnly?'Enable writes':'Enable read-only mode','Update credentials','Rename'],{title:env.name});if(!action)return;
    if(action==='Update credentials'){const c=await this.askCredentials();if(c){await this.context.secrets.store('isc.credentials.'+env.id,JSON.stringify(c));this.client.clear(env.id);}return;}
    const next={...env};
    if(action==='Change API version'){const v=await vscode.window.showQuickPick(Object.keys(this.catalog.index.versions),{title:'Default version for resource browsing'});if(!v)return;next.version=v;}
    else if(action==='Rename'){const name=await vscode.window.showInputBox({title:'New environment name',value:env.name,validateInput:v=>!v.trim()||this.envs().some(e=>e.id!==env.id&&e.name===v.trim())?'Use a unique, non-empty name':null});if(!name)return;next.name=name.trim();}
    else next.readOnly=!env.readOnly;
    await this.context.globalState.update('isc.environments',this.envs().map(e=>e.id===env.id?next:e));this.envTree.refresh();this.files.permissionsChanged(env.id);
  }
  async setReadOnly(env,readOnly){env=env?this.env(env.id):await this.pickEnv();if(env&&env.readOnly!==readOnly)await this.toggleWrites(env);}
  async toggleWrites(env){
    this.trust();env=env?this.env(env.id):await this.pickEnv();if(!env)return;
    await this.context.globalState.update('isc.environments',this.envs().map(e=>e.id===env.id?{...e,readOnly:!e.readOnly}:e));
    this.envTree.refresh();this.files.permissionsChanged(env.id);
    await vscode.window.showInformationMessage(env.readOnly?`${env.name}: writes enabled. Saving resource documents now updates ISC (explicit Save only; Auto Save is blocked).`:`${env.name}: read-only.`);
  }
  async removeEnvironment(env){
    this.trust();env=env?this.env(env.id):await this.pickEnv();if(!env)return;
    if(await vscode.window.showWarningMessage(`Remove local connection and credentials for ${env.name}?`,{modal:true},'Remove')!=='Remove')return;
    await this.context.secrets.delete('isc.credentials.'+env.id);this.client.clear(env.id);
    await this.context.globalState.update('isc.environments',this.envs().filter(e=>e.id!==env.id));this.envTree.refresh();
  }
  async testConnection(env){
    this.trust();env=env?this.env(env.id):await this.pickEnv();if(!env)return;
    await this.client.request(env,{version:env.version,path:'/sources',query:{limit:1}});await vscode.window.showInformationMessage(`Authentication and sources read succeeded for ${env.name}. Other APIs require their documented scopes and roles.`);
  }
  async searchApi(){
    const picked=await vscode.window.showQuickPick(this.catalog.index.operations.map(op=>({label:`${op.method} ${op.path}`,description:`${op.version} · ${op.tags.join(', ')}${op.deprecated?' · deprecated':''}`,detail:`${op.operationId}: ${op.summary}`,key:op.key})),{title:'Search all official ISC API operations',matchOnDescription:true,matchOnDetail:true});if(picked)await this.newRequest(picked.key);
  }
  async newRequest(key,environment,params={}){
    this.trust();if(!key)return this.searchApi();
    const env=environment||await this.pickEnv();if(!env)return;
    const draft=this.catalog.draft(key,env.id);Object.assign(draft.path,params);
    const schemaUri=await this.requestSchema(key);
    await this.showJson('Request',{$schema:schemaUri.toString(),...draft});
  }
  async requestSchema(key){
    const op=this.catalog.operation(key),spec=op.spec;
    const schema={type:'object',required:['kind','environmentId','operation'],properties:{$schema:{type:'string'},kind:{const:'isc-request'},environmentId:{const:undefined,type:'string',description:'Environment ID stored in VS Code; never place credentials in this file'},operation:{const:key},path:{type:'object',properties:{},required:[]},query:{type:'object',properties:{},required:[]},headers:{type:'object',properties:{},required:[]},contentType:{enum:Object.keys(op.request?.content||{})},body:{}},$defs:spec.$defs};
    for(const p of op.parameters){const g=p.in==='path'?'path':p.in==='query'?'query':p.in==='header'?'headers':null;if(g){schema.properties[g].properties[p.name]={...(p.schema||{}),description:p.description};if(p.required)schema.properties[g].required.push(p.name);}}
    const media=op.request?.content||{};const contentType=Object.keys(media).find(k=>k==='application/json')||Object.keys(media)[0];
    schema.properties.body=media[contentType]?.schema||{};
    if(!op.request)delete schema.properties.contentType;
    // OpenAPI binary properties are represented by {$file:"local-path"} in drafts.
    if(contentType==='multipart/form-data'||contentType==='application/octet-stream')schema.properties.body={description:'Binary inputs use an object with $file set to an absolute local file path.'};
    const dir=vscode.Uri.joinPath(this.context.globalStorageUri,'schemas');await vscode.workspace.fs.createDirectory(dir);
    const uri=vscode.Uri.joinPath(dir,hash(key)+'.json');await vscode.workspace.fs.writeFile(uri,Buffer.from(json(schema)));return uri;
  }
  activeRequest(){const editor=vscode.window.activeTextEditor;if(!editor)throw new Error('Open an ISC request JSON document');let draft;try{draft=JSON.parse(editor.document.getText());}catch{throw new Error('Request is not valid JSON');}if(draft.kind!=='isc-request')throw new Error('Use New API Request to create a request document');return {draft,document:editor.document};}
  async operationDetails(key){
    if(!key)key=this.activeRequest().draft.operation;
    const op=this.catalog.operation(key);
    await this.showJson('API specification',{operationId:op.operationId,version:op.version,method:op.method,path:op.path,description:op.definition.description,security:op.definition.security,userLevels:op.definition['x-sailpoint-userLevels'],parameters:op.parameters,requestBody:op.request,responses:op.definition.responses,$defs:op.spec.$defs});
  }
  async requestDocs(){const {draft}=this.activeRequest();const op=this.catalog.operation(draft.operation);const slug=op.operationId.replace(/([a-z0-9])([A-Z])/g,'$1-$2').toLowerCase();await vscode.env.openExternal(vscode.Uri.parse(`https://developer.sailpoint.com/docs/api/${op.version==='v2026'?'':op.version+'/'}${slug}/`));}
  async bodyFor(op,draft){
    if(draft.body===undefined){if(op.request?.required)throw new Error('This operation requires a request body');return {};}
    const type=draft.contentType;
    if(!op.request?.content?.[type])throw new Error('Select a contentType documented for this operation');
    const schema=op.request.content[type].schema;
    if(type.includes('json')){
      const errors=validate(op.spec,schema,draft.body);if(errors.length)throw new Error('Request validation: '+errors.slice(0,8).join('; '));
      return {body:JSON.stringify(draft.body),headers:{'Content-Type':type}};
    }
    const file=async value=>{
      if(!value || typeof value.$file!=='string'||!path.isAbsolute(value.$file))throw new Error('Binary fields require {"$file":"absolute local file path"}');
      const uri=vscode.Uri.file(value.$file);const stat=await vscode.workspace.fs.stat(uri);if(stat.size>100*1024*1024)throw new Error('Upload exceeds 100 MB limit');
      const approval=await vscode.window.showWarningMessage(`Upload local file ${value.$file} to ${this.env(draft.environmentId).name}?`,{modal:true},'Upload file');if(approval!=='Upload file')throw new Error('Upload cancelled');
      return {bytes:await vscode.workspace.fs.readFile(uri),name:path.basename(value.$file)};
    };
    if(type==='multipart/form-data'){
      const form=new FormData(),s=resolve(op.spec,schema)||{};
      for(const key of s.required||[])if(draft.body[key]===undefined)throw new Error(`Missing multipart field ${key}`);
      for(const [key,value] of Object.entries(draft.body)){
        if(value && typeof value==='object' && Object.hasOwn(value,'$file')){const f=await file(value);form.append(key,new Blob([f.bytes]),f.name);}
        else if(value!==null && typeof value==='object')form.append(key,new Blob([JSON.stringify(value)],{type:'application/json'}));
        else form.append(key,String(value));
      }
      return {body:form,headers:{}};
    }
    if(type==='application/x-www-form-urlencoded')return {body:new URLSearchParams(Object.entries(draft.body).map(([k,v])=>[k,String(v)])),headers:{'Content-Type':type}};
    if(draft.body && typeof draft.body==='object' && '$file' in draft.body){const f=await file(draft.body);return {body:f.bytes,headers:{'Content-Type':type}};}
    if(typeof draft.body!=='string')throw new Error('This content type requires a text body or a $file input');
    return {body:draft.body,headers:{'Content-Type':type}};
  }
  async runRequest(){
    this.trust();const {draft,document}=this.activeRequest();
    if(this.runs.has(document.uri.toString()))throw new Error('This request is already running');
    const op=this.catalog.operation(draft.operation),env=this.env(draft.environmentId);
    const missing=[];
    for(const p of op.parameters){const group=p.in==='path'?draft.path:p.in==='query'?draft.query:p.in==='header'?draft.headers:undefined;const val=group?.[p.name];if(val===undefined){if(p.required)missing.push(`${p.in}.${p.name}: required`);}else missing.push(...validate(op.spec,p.schema,val,`${p.in}.${p.name}`));}
    if(missing.length)throw new Error(missing.slice(0,8).join('; '));
    urlFor(env.baseUrl,op.version,op.path,draft.path,draft.query);
    if(env.readOnly&&!SAFE.has(op.method))throw new Error('Environment is read-only. Use Configure Environment to enable writes.');
    if(!SAFE.has(op.method)&&await vscode.window.showWarningMessage(`${op.method} ${op.path} on ${env.name} (${env.baseUrl})? This may change tenant data.`,{modal:true},'Execute request')!=='Execute request')return;
    this.runs.add(document.uri.toString());
    try{
      const payload=await this.bodyFor(op,draft);
      const res=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`${op.method} ${op.path} — ${env.name}`,cancellable:true},async(_,token)=>{
        const controller=new AbortController(),sub=token.onCancellationRequested(()=>controller.abort());
        try{return await this.client.request(this.env(env.id),{method:op.method,version:op.version,path:op.path,pathParams:draft.path,query:serializeQuery(op.parameters,draft.query),headers:{...draft.headers,...payload.headers},body:payload.body,signal:controller.signal});}finally{sub.dispose();}
      });
      if(Buffer.isBuffer(res.data)){
        const uri=await vscode.window.showSaveDialog({saveLabel:'Save API download'});if(uri)await vscode.workspace.fs.writeFile(uri,res.bytes);
      }else if(!SAFE.has(op.method))await this.actions.notify(op.summary||op.operationId,res);else await this.showJson('API response',{environment:env.name,operation:op.operationId,status:res.status,headers:res.headers,data:redact(res.data)});
      if(SAFE.has(op.method))await vscode.window.showInformationMessage(`${op.operationId}: HTTP ${res.status}`);
    }finally{this.runs.delete(document.uri.toString());}
  }
  findOp(version,method,route){return this.catalog.index.operations.find(o=>o.version===version&&o.method===method&&o.path===route);}
  async readResource(env,binding){
    const op=this.findOp(binding.version,'GET',binding.path),draft=this.catalog.draft(op.key,env.id);
    return this.client.request(env,{version:binding.version,path:binding.path,pathParams:binding.params,headers:draft.headers,query:draft.query});
  }
  async openResource(node){
    this.trust();if(!node?.resource)throw new Error('Select a resource in the environment tree');
    const env=this.env(node.env.id),binding=node.resource;
    const uri=this.files.uri(env,binding,node.label);
    if(this.files.entries.has(uri.toString()))await this.files.reload(uri,{quiet:true});
    const editor=await this.openFile(uri);
    await vscode.languages.setTextDocumentLanguage(editor.document,'json');
  }
  canUpdate(binding){
    return ['PATCH','PUT'].some(method=>{
      const meta=this.findOp(binding.version,method,binding.path);if(!meta)return false;
      const op=this.catalog.operation(meta.key),content=op.request?.content||{};
      return Object.entries(content).some(([type,media])=>type.includes('json')&&(method==='PUT'||resolve(op.spec,media.schema)?.type==='array'));
    });
  }
  async publishResource(){
    const doc=vscode.window.activeTextEditor?.document;
    if(!doc||doc.uri.scheme!=='isc-resource')throw new Error('Open a resource from the environment tree, edit it, and press Ctrl+S.');
    await doc.save();
  }
  async saveResource(binding,text){
    this.trust();
    const env=this.env(binding.environmentId);if(env.readOnly)throw new Error('Environment is read-only');
    if(binding.uncertain)throw new Error('The previous write may have been accepted but could not be verified. Preserve your edits locally, then close and reopen this resource before saving again.');
    let edited;try{edited=JSON.parse(text);}catch{throw new Error('Invalid JSON. Correct it before saving; nothing was written to ISC.');}
    if(!edited||typeof edited!=='object'||Array.isArray(edited))throw new Error('Resource must be a JSON object');
    const changed=[...new Set([...Object.keys(binding.original),...Object.keys(edited)])].filter(k=>hash(json(binding.original[k]))!==hash(json(edited[k])));
    if(!changed.length)return;
    const put=this.findOp(binding.version,'PUT',binding.path),patchMeta=this.findOp(binding.version,'PATCH',binding.path);
    const patch=patchMeta&&Object.entries(this.catalog.operation(patchMeta.key).request?.content||{}).some(([t,m])=>t.includes('json')&&resolve(this.catalog.spec(binding.version),m.schema)?.type==='array')?patchMeta:undefined;
    const selected=patch||put;
    if(!selected)throw new Error('This resource has no documented PUT/PATCH at this path. Use the API explorer for its supported actions.');
    const op=this.catalog.operation(selected.key);
    const media=Object.keys(op.request?.content||{}).find(k=>k.includes('json'));if(!media)throw new Error('Resource update is not a JSON operation; use the API explorer.');
    const get=this.findOp(binding.version,'GET',binding.path),getOp=get&&this.catalog.operation(get.key);
    const responseSchema=resolve(op.spec,getOp?.definition?.responses?.['200'])?.content?.['application/json']?.schema;
    const props=resolve(op.spec,responseSchema)?.properties||{};
    for(const k of changed)if(['id','created','modified','createdBy','modifiedBy'].includes(k)||resolve(op.spec,props[k])?.readOnly)throw new Error(`Cannot edit read-only field ${k}`);
    const current=(await this.readResource(env,binding)).data;
    if(hash(canonical(current))!==hash(canonical(binding.remote||binding.original)))throw Object.assign(new Error('Remote resource changed since opening. Use Compare with Latest ISC or Reload from ISC; your edits are preserved.'),{code:'ISC_REMOTE_CHANGED'});
    const draft=this.catalog.draft(selected.key,env.id);draft.path=binding.params;draft.contentType=media;
    if(patch){
      const schema=resolve(op.spec,op.request.content[media].schema);
      if(schema.type!=='array')throw new Error('This PATCH uses a custom body. Use the API explorer to prepare it.');
      draft.body=jsonPatch(binding.original,edited);
    }else{
      draft.body={...edited};const schema=requestShape(op.spec,op.request.content[media].schema);
      if(schema.required?.includes('id')&&draft.body.id===undefined&&current.id!==undefined)draft.body.id=current.id;
      if(draft.body.owner?.id===''&&binding.original.owner?.id===''&&binding.remote?.owner?.id)draft.body.owner=binding.remote.owner;
      for(const k of Object.keys(draft.body))if((['id','created','modified','createdBy','modifiedBy'].includes(k)&&!schema.required?.includes(k))||resolve(op.spec,schema.properties?.[k])?.readOnly)delete draft.body[k];
    }
    const payload=await this.bodyFor(op,draft);
    try{await this.client.request(this.env(env.id),{method:op.method,version:op.version,path:op.path,pathParams:binding.params,...payload,headers:{...draft.headers,...payload.headers},query:serializeQuery(op.parameters,draft.query)});}
    catch(error){if(error.status>=500 || /may have accepted/.test(error.message))binding.uncertain=true;throw error;}
    binding.original=edited;
    try{binding.remote=(await this.readResource(this.env(env.id),binding)).data;}
    catch{binding.uncertain=true;void vscode.window.showWarningMessage('Saved to ISC, but verification failed. Use Reload from ISC before your next edit.');}
    this.envTree.refresh();
  }
  async openRuleScript(node){
    this.trust();if(!node?.resource?.path.startsWith('/connector-rules/'))throw new Error('Select a connector rule.');
    const uri=this.files.uri(this.env(node.env.id),{...node.resource,kind:'script'},node.label);
    if(this.files.entries.has(uri.toString()))await this.files.reload(uri,{quiet:true});
    const editor=await this.openFile(uri);await vscode.languages.setTextDocumentLanguage(editor.document,'java');
  }
  async setWorkflow(node,enabled){
    this.trust();if(!node?.resource?.path.startsWith('/workflows/'))throw new Error('Select a workflow.');
    const env=this.env(node.env.id);if(env.readOnly)throw new Error('Environment is read-only');
    const original=(await this.readResource(env,node.resource)).data;
    await this.saveResource({environmentId:env.id,...node.resource,original,remote:original},JSON.stringify({...original,enabled}));
  }
  async sourceAction(node,action){
    this.trust();const env=this.env(node.env.id);if(env.readOnly)throw new Error('Unlock the environment before running source actions.');
    const version=node.resource.version,id=node.apiId;if(!id)throw new Error('Missing source API ID.');
    const route=action==='test'?'/sources/{sourceId}/connector/test-configuration':action==='ping'?'/sources/{sourceId}/connector/ping-cluster':'/sources/{id}/load-accounts';
    if(!this.findOp(version,'POST',route))throw new Error('This action is unavailable in this API version.');
    const title=action==='unoptimized'?'Run unoptimized account aggregation':action==='aggregate'?'Run account aggregation':action==='test'?'Test source connection':'Ping source cluster';
    if(await vscode.window.showWarningMessage(`${title} for ${node.label} in ${env.name}?`,{modal:true},'Run')!=='Run')return;
    const request={method:'POST',version,path:route,pathParams:{id,sourceId:id}};
    if(action==='aggregate'||action==='unoptimized'){const source=(await this.readResource(env,node.resource)).data;if(source.connector==='delimited-file')throw new Error('Delimited-file aggregation requires a CSV upload. Use Resource API Actions → Account aggregation.');const form=new FormData();form.append('disableOptimization',String(action==='unoptimized'));request.body=form;}
    const result=await this.client.request(this.env(env.id),request);await this.actions.notify(title,result);this.envTree.refresh();
  }
  async resourceActions(node){
    if(!node?.resource)return;const {version,path,params}=node.resource;
    const rows=this.catalog.index.operations.filter(o=>o.version===version&&(o.path===path||o.path.startsWith(path+'/'))).map(o=>({label:o.summary||o.operationId,description:o.method+' '+o.path,op:o})).sort((a,b)=>this.compareLabels(a.label,b.label));
    const chosen=await vscode.window.showQuickPick(rows,{title:'Resource API Actions',matchOnDescription:true});if(!chosen)return;
    const draft=this.catalog.draft(chosen.op.key,node.env.id);Object.assign(draft.path,params);await this.showJson(chosen.label,draft);
  }
  async createResource(node){return this.creation.create(node);}
  compareLabels(a,b){return String(a).localeCompare(String(b),'en',{sensitivity:'base',numeric:true})||String(a).localeCompare(String(b),'en');}
  async listObjects(env,route,params={}){
    const meta=this.findOp(env.version,'GET',route);if(!meta)throw new Error(`No list endpoint for ${route}`);
    const op=this.catalog.operation(meta.key),draft=this.catalog.draft(meta.key,env.id);
    const policyList=route.endsWith('/provisioning-policies');
    const limitParam=!policyList&&op.parameters.find(p=>p.name==='limit'),hasOffset=!policyList&&op.parameters.some(p=>p.name==='offset');
    const limit=Math.min(250,limitParam?.schema?.maximum||250),all=[];
    let previous;for(let offset=0;;){
      if(offset>=10000)throw new Error('Collection exceeds 10,000 objects. Use Search All APIs with filters to narrow the results.');
      const query={};if(op.parameters.some(p=>p.name==='count'))query.count=true;if(route==='/sources')query.sorters='name';if(limitParam)query.limit=limit;if(hasOffset)query.offset=offset;
      const result=await this.client.request(env,{version:env.version,path:route,pathParams:params,query,headers:draft.headers});
      const data=Array.isArray(result.data)?result.data:result.data?.items||result.data?.data||result.data?.results;
      if(!Array.isArray(data))throw new Error('This endpoint does not return a collection. Use Search All APIs to inspect it.');
      if(!data.length)break;const signature=hash(data);if(signature===previous)throw new Error('The API repeated a page despite an increased offset. Use Find Source or a filtered API request.');previous=signature;all.push(...data);if(!hasOffset||!limitParam)break;offset+=data.length;const total=Number(result.headers?.['x-total-count']??result.headers?.get?.('x-total-count'));if(total>0&&offset>=total)break;
    }
    return all.sort((a,b)=>this.compareLabels(a.displayName||a.connectorAttributes?.cloudDisplayName||a.name||a.usageType||a.id||'',b.displayName||b.connectorAttributes?.cloudDisplayName||b.name||b.usageType||b.id||''));
  }

  async findSource(node){
    this.trust();const env=node?.env?this.env(node.env.id):await this.pickEnv('Find source in tenant');if(!env)return;
    const name=await vscode.window.showInputBox({title:'Find Source — exact display name',prompt:'Runs a fresh API lookup without using the tree cache.'});if(!name?.trim())return;
    const matches=new Map(),report=[];
    // v2025 is the reference extension's source-list API. Compare other documented versions only for reads.
    for(const version of [...new Set([env.version,'v2025','v3','beta'])]){
      if(!this.findOp(version,'GET','/sources'))continue;
      try{
        const r=await this.client.request(env,{version,path:'/sources',query:{filters:'name eq '+JSON.stringify(name.trim()),sorters:'name',limit:250}});
        const rows=Array.isArray(r.data)?r.data:[];
        report.push({version,count:rows.length,status:r.status});
        for(const obj of rows)if(obj.id&&obj.name===name.trim()&&!matches.has(obj.id))matches.set(obj.id,{obj,version});
      }catch(error){report.push({version,status:error.status||'NETWORK_ERROR',message:error.message});}
    }
    if(!matches.size){
      try{const rows=await this.listObjects(env,'/sources');report.push({version:env.version,lookup:'unfiltered display-name fallback',count:rows.length});for(const obj of rows)if(obj.id&&[obj.name,obj.displayName,obj.connectorAttributes?.cloudDisplayName].includes(name.trim()))matches.set(obj.id,{obj,version:env.version});}
      catch(error){report.push({version:env.version,lookup:'unfiltered display-name fallback',status:error.status||'ERROR',message:error.message});}
    }
    this.output.appendLine(JSON.stringify({diagnostic:'Find Source',environment:env.name,name:name.trim(),versions:report,matchedIds:[...matches.keys()]}));
    if(!matches.size){await this.showJson('Source lookup diagnostics',{environment:env.name,apiOrigin:env.baseUrl,requestedName:name.trim(),versions:report,conclusion:'No matching API source returned. Check the configured tenant, token permissions, and exact API source name. This result does not prove the source is absent from the tenant.'});return;}
    const rows=[...matches.values()];const selected=rows.length===1?rows[0]:(await vscode.window.showQuickPick(rows.map(r=>({label:r.obj.name,description:r.obj.id,record:r})),{title:'Select matching API source'}))?.record;if(!selected)return;
    const get=this.catalog.index.operations.find(o=>o.version===selected.version&&o.method==='GET'&&/^\/sources\/\{[^}]+\}$/.test(o.path));
    await this.openResource({label:selected.obj.name,env,resource:{version:selected.version,path:get.path,params:{[get.path.match(/\{([^}]+)\}/)[1]]:selected.obj.id}}});
    if(selected.version!==env.version)await vscode.window.showInformationMessage(`Source found through ${selected.version}; this editor uses that version. Set the environment's version to ${selected.version} if your current list omits it.`);
    this.envTree.refresh();
  }
  home(){
    const panel=vscode.window.createWebviewPanel('iscWorkbench.home','ISC Workbench',vscode.ViewColumn.One,{enableScripts:true});
    const nonce=crypto.randomBytes(18).toString('base64');const count=this.catalog.index.operations.length;
    panel.webview.html=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:36px;max-width:960px;margin:auto}h1{font-size:38px;letter-spacing:-1px;margin:12px 0}.eyebrow{color:var(--vscode-textLink-foreground);font-size:12px;letter-spacing:2px}.intro{font-size:17px;line-height:1.6;max-width:720px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-top:30px}.card{padding:24px;border:1px solid var(--vscode-panel-border);border-radius:8px}h2{font-size:19px}.card p{line-height:1.6;min-height:75px;color:var(--vscode-descriptionForeground)}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:10px 15px;border-radius:3px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}.stat{font-size:28px;margin-top:30px}.note{margin-top:28px;line-height:1.7;color:var(--vscode-descriptionForeground)}</style></head><body><div class="eyebrow">IDENTITY SECURITY CLOUD / DEVELOPER WORKSPACE</div><h1>ISC Workbench</h1><p class="intro">Explore your tenants, work with configuration in JSON, and review changes before promoting them across environments.</p><div class="stat">Connect. Edit. Save.</div><p>Your resource documents stay connected to their tenant.</p><div class="grid"><div class="card"><h2>Connect environments</h2><p>Add development, UAT, and production. Credentials stay in VS Code SecretStorage; new connections start read-only.</p><button data-command="addEnvironment">Add environment</button></div><div class="card"><h2>Edit resource JSON</h2><p>Unlock your environment, open a source or resource, and save your changes directly to ISC with Ctrl+S.</p><button data-command="toggleWrites">Toggle environment lock</button></div><div class="card"><h2>Promote configuration</h2><p>Export a candidate and target baseline. Review mappings, run SailPoint’s preview, then import with a backup.</p><button data-command="newPromotion">Prepare promotion</button></div></div><p class="note">Start with the environment tree on the left. Unlock an environment, open a resource, edit its JSON, and save to update ISC. Auto Save also writes when enabled. Promotion covers the configuration types supported by SailPoint SP-Config; API availability depends on tenant permissions and features.</p><script nonce="${nonce}">const api=acquireVsCodeApi();document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>api.postMessage({command:b.dataset.command})));</script></body></html>`;
    panel.webview.onDidReceiveMessage(m=>{if(['addEnvironment','searchApi','newPromotion','toggleWrites'].includes(m?.command))vscode.commands.executeCommand('iscWorkbench.'+m.command);},null,this.context.subscriptions);
  }
}
class EnvironmentTree {
  constructor(app){this.app=app;this.changed=new vscode.EventEmitter();this.onDidChangeTreeData=this.changed.event;this.cache=new Map();this.collectionData=new Map();app.context.subscriptions.push(this.changed);}
  refresh(){this.cache.clear();this.collectionData.clear();this.changed.fire();this.app.saas?.refresh();this.app.operations?.refresh();}
  getTreeItem(node){return node;}
  item(label,state,data){return Object.assign(new vscode.TreeItem(label,state),data);}
  nextPage(node){const parent=node.parent;parent.offset=node.offset;this.cache.delete(parent.cacheKey);this.changed.fire(parent);}
  async getChildren(node){
    if(!node)return [...this.app.envs()].sort((a,b)=>this.app.compareLabels(a.name,b.name)).map(env=>this.item(env.name,vscode.TreeItemCollapsibleState.Collapsed,{env,contextValue:env.readOnly?'iscEnvironmentLocked':'iscEnvironmentWritable',description:`${env.version} · ${env.readOnly?'read-only':'writable'}`,tooltip:env.baseUrl,iconPath:new vscode.ThemeIcon(env.readOnly?'lock':'unlock')}));
    if(node.contextValue?.startsWith('iscEnvironment'))return [...RESOURCES].sort((a,b)=>this.app.compareLabels(a[0],b[0])).filter(([,route])=>this.app.findOp(node.env.version,'GET',route)).map(([name,route])=>this.item(name,vscode.TreeItemCollapsibleState.Collapsed,{env:node.env,route,offset:0,cacheKey:node.env.id+route,contextValue:'iscCollection'+(ITEM_TYPES[route]?.context||'').replace('isc',''),iconPath:new vscode.ThemeIcon('folder')})).concat(this.app.operations.group(node.env,'activities','/account-activities',{sorters:'-created'},'Provisioning Activities')).sort((a,b)=>this.app.compareLabels(a.label,b.label));
    if(node.contextValue?.startsWith('iscOps')||['workflow','campaign'].includes(node.kind))return this.app.operations.getChildren(node);
    if(/^iscWorkflow(Enabled|Disabled)$/.test(node.contextValue))return this.app.operations.getChildren({env:node.env,kind:'workflow',object:{id:node.apiId}});
    if(node.contextValue==='iscIdentity')return [this.app.operations.group(node.env,'activities','/account-activities',{'regarding-identity':node.apiId,sorters:'-created'},'Provisioning Activities')];
    if(['iscResource','iscSource','iscSaasSource'].includes(node.contextValue)&&node.resource.path.match(/^\/sources\/\{[^}]+\}$/)){
      const env=this.app.env(node.env.id),sourceId=Object.values(node.resource.params)[0];
      return [['Provisioning Policies','provisioning-policies'],['Schemas','schemas']].flatMap(([label,suffix])=>{
        const op=this.app.catalog.index.operations.find(o=>o.version===node.resource.version&&o.method==='GET'&&new RegExp('^/sources/\\{[^}]+\\}/'+suffix+'$').test(o.path));
        if(!op)return [];
        return [this.item(label,vscode.TreeItemCollapsibleState.Collapsed,{env,route:op.path,params:{[op.path.match(/\{([^}]+)\}/)[1]]:sourceId},offset:0,cacheKey:env.id+op.path+sourceId,contextValue:'iscCollection'+ITEM_TYPES[suffix].context.replace('isc',''),iconPath:new vscode.ThemeIcon('folder')})];
      });
    }
    if(node.contextValue?.startsWith('iscCollection')){
      this.app.trust();if(this.cache.has(node.cacheKey))return this.cache.get(node.cacheKey);
      try{
        let env=this.app.env(node.env.id);
        const dataKey=node.cacheKey+env.version;
        if(!this.collectionData.has(dataKey)){
          let objects;try{objects=await this.app.listObjects(env,node.route,node.params);}catch(error){
            if(error.status===403)throw new Error(`${node.label}: ISC denied access (403). This is not an empty collection. Check the PAT owner's access and this tenant's feature entitlement. No version fallback attempted for denied access.`);
            if(error.status!==404)throw error;
            for(const version of ['v2025','v3','beta'].filter(v=>v!==env.version&&this.app.findOp(v,'GET',node.route))){try{objects=await this.app.listObjects({...env,version},node.route,node.params);objects.apiVersion=version;break;}catch(e){if(e.status!==404)throw e;}}
            if(!objects)throw new Error(`${node.label}: no available endpoint in the configured or compatibility API versions (404). The tenant may not have this feature enabled.`);
          }this.collectionData.set(dataKey,objects);
        }
        if(this.collectionData.get(dataKey).apiVersion)env={...env,version:this.collectionData.get(dataKey).apiVersion};
        const all=this.collectionData.get(dataKey),paged=['/identities','/accounts','/entitlements'].includes(node.route),data=paged?all.slice(node.offset,node.offset+50):all;
        const detail=this.app.catalog.index.operations.find(o=>o.version===env.version&&o.method==='GET'&&o.path.startsWith(node.route+'/')&&/^\{[^}]+\}$/.test(o.path.slice(node.route.length+1)));
        let instances=[];if(node.route==='/sources')try{instances=await this.app.saas.list(env,'instance');}catch{/* Hide SaaS-only actions when membership cannot be verified. */}
        const rows=data.map(obj=>{
          const id=obj.id,params={...(node.params||{})};
          if(detail){const unbound=[...detail.path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]).find(p=>!Object.hasOwn(params,p));if(unbound)params[unbound]=unbound==='usageType'?obj.usageType:unbound==='name'?obj.name:id;}
          const resource={version:env.version,path:detail?.path||node.route,params};
          const row=this.item(String(obj.displayName||obj.connectorAttributes?.cloudDisplayName||obj.name||obj.usageType||obj.id||'Object'),['/sources','/workflows','/identities'].includes(node.route)?vscode.TreeItemCollapsibleState.Collapsed:0,{env,resource,apiId:obj.id??obj.usageType,contextValue:node.route==='/workflows'?(obj.enabled?'iscWorkflowEnabled':'iscWorkflowDisabled'):(ITEM_TYPES[node.route]?.context||ITEM_TYPES[node.route.split('/').pop()]?.context||'iscResource'),description:node.route==='/workflows'?(obj.enabled?'enabled':'disabled'):obj.id,tooltip:`${obj.displayName||obj.name||''}\nAPI ID: ${obj.id??obj.usageType??'not provided'}`,iconPath:new vscode.ThemeIcon('json')});
          if(node.route==='/sources'){const matches=instances.filter(i=>i.id===obj.id||i.name===obj.name);if(matches.length===1){row.contextValue='iscSaasSource';row.saasInstance=matches[0];}}
          if(detail&&Object.values(params).every(v=>v!==undefined&&v!==null))row.command={command:'iscWorkbench.openResource',title:'Open resource',arguments:[row]};else row.description='No API identifier returned';return row;
        });
        if(paged&&node.offset+50<all.length){const more=this.item(`Load next 50 (offset ${node.offset+50})`,0,{parent:node,offset:node.offset+50});more.command={command:'iscWorkbench.nextPage',title:'Next page',arguments:[more]};rows.push(more);}
        if(paged&&node.offset>0){const first=this.item('Back to first page',0,{parent:node,offset:0});first.command={command:'iscWorkbench.nextPage',title:'First page',arguments:[first]};rows.push(first);}
        this.cache.set(node.cacheKey,rows);return rows;
      }catch(e){return [this.item(e.message,0,{iconPath:new vscode.ThemeIcon('warning'),tooltip:e.message})];}
    }
    return [];
  }
}
class ApiTree {
  constructor(app){this.app=app;}
  getTreeItem(node){return node;}
  getChildren(node){
    if(!node)return Object.entries(this.app.catalog.index.versions).map(([v,d])=>Object.assign(new vscode.TreeItem(v,vscode.TreeItemCollapsibleState.Collapsed),{version:v,description:`${d.operations} operations`}));
    if(!node.tag)return [...new Set(this.app.catalog.index.operations.filter(o=>o.version===node.version).flatMap(o=>o.tags))].sort().map(tag=>Object.assign(new vscode.TreeItem(tag,vscode.TreeItemCollapsibleState.Collapsed),{version:node.version,tag}));
    return this.app.catalog.index.operations.filter(o=>o.version===node.version&&o.tags.includes(node.tag)).map(o=>Object.assign(new vscode.TreeItem(`${o.method} ${o.path}`,0),{key:o.key,contextValue:'iscOperation',description:o.deprecated?'Deprecated':o.summary,tooltip:`${o.operationId}\n${o.summary}`,command:{command:'iscWorkbench.newRequest',title:'New request',arguments:[o.key]},iconPath:new vscode.ThemeIcon(SAFE.has(o.method)?'arrow-down':'arrow-up')}));
  }
}
async function activate(context){const app=new App(context);await app.files.migration;return app;}
function deactivate(){}
module.exports={activate,deactivate,App,EnvironmentTree,ApiTree};
