// Mechanical manifest update for the integrated SaaS Connectivity view.
const fs=require('node:fs');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.version='0.8.2';
const commands=[
 ['saasRefresh','Refresh SaaS Connectivity','refresh'],
 ['saasCreateConnector','Create SaaS Connector…','add'],['saasCreateCustomizer','Create Customizer…','add'],
 ['saasRename','Rename SaaS Connector…','edit'],['saasDelete','Delete SaaS Connector…','trash'],
 ['saasRenameCustomizer','Rename Customizer…','edit'],['saasDeleteCustomizer','Delete Customizer…','trash'],
 ['saasUploadCustomizer','Upload Customizer ZIP…','cloud-upload'],['saasDeployCustomizer','Build and Deploy Customizer…','rocket'],
 ['saasUpload','Upload Connector ZIP…','cloud-upload'],['saasDeploy','Build and Deploy Connector…','rocket'],
 ['saasLink','Link Customizer…','link'],['saasUnlink','Unlink Customizer…','unlink'],
 ['saasLogs','Fetch Source Logs…','output'],['saasTail','Stream Source Logs…','play'],['saasStopLogs','Stop Source Logs','debug-stop'],['saasStopAllLogs','Stop All Source Log Streams','debug-stop'],
 ['saasInspect','Open SaaS Configuration','json'],['saasCopyId','Copy SaaS Item ID','copy'],
 ['saasTest','Test SaaS Connector…','beaker'],['saasTestLocal','Test Local Connector…','beaker'],
 ['saasReplay','Replay Connector Test…','history'],['saasClearHistory','Clear Connector Test History','clear-all'],
 ['saasProjectConnector','Create Connector Project…','new-folder'],['saasProjectCustomizer','Create Customizer Project…','new-folder'],
 ['saasBuild','Build Connector Project…','tools'],['saasDebug','Start Connector Debug Server…','debug-start']
];
pkg.contributes.commands=pkg.contributes.commands.filter(c=>!commands.some(([id])=>c.command==='iscWorkbench.'+id));
for(const [id,title,icon]of commands)pkg.contributes.commands.push({command:'iscWorkbench.'+id,title,icon:'$('+icon+')'});
pkg.activationEvents=[...new Set([...pkg.activationEvents,'onView:iscWorkbench.saas'])];
pkg.contributes.views.iscWorkbench=pkg.contributes.views.iscWorkbench.filter(v=>v.id!=='iscWorkbench.saas');
pkg.contributes.views.iscWorkbench.push({id:'iscWorkbench.saas',name:'SaaS Connectivity',visibility:'visible'});
pkg.contributes.viewsWelcome=pkg.contributes.viewsWelcome.filter(v=>v.view!=='iscWorkbench.saas');
pkg.contributes.viewsWelcome.push({view:'iscWorkbench.saas',contents:'Add an environment to manage custom SaaS connectors, customizers and source logs.\n[Add Environment](command:iscWorkbench.addEnvironment)'});
const menus=pkg.contributes.menus;for(const key of ['view/title','view/item/context'])menus[key]=menus[key].filter(m=>!commands.some(([id])=>m.command==='iscWorkbench.'+id));
for(const id of ['saasRefresh'])menus['view/title'].push({command:'iscWorkbench.'+id,when:'view == iscWorkbench.saas',group:'navigation'});
for(const menu of menus['view/item/context'])if(menu.when)menu.when=menu.when.replace(/viewItem == iscSource\b/g,'viewItem =~ /^(iscSource|iscSaasSource)$/');
const both='viewItem =~ /^saas(connector|customizer)$/',all='viewItem =~ /^saas(connector|customizer|instance)$/',instances='viewItem == saasinstance || viewItem == iscSaasSource';
for(const [id,when,group]of [
 ['saasRefresh','viewItem =~ /^saasFolder/','inline@1'],
 ['saasCreateConnector','viewItem == saasFolderconnector','inline@2'],['saasCreateCustomizer','viewItem == saasFoldercustomizer','inline@2'],
 ['saasRename','viewItem == saasconnector','manage@1'],['saasDelete','viewItem == saasconnector','manage@9'],['saasUpload','viewItem == saasconnector','deploy@1'],['saasDeploy','viewItem == saasconnector','deploy@2'],
 ['saasRenameCustomizer','viewItem == saascustomizer','manage@1'],['saasDeleteCustomizer','viewItem == saascustomizer','manage@9'],['saasUploadCustomizer','viewItem == saascustomizer','deploy@1'],['saasDeployCustomizer','viewItem == saascustomizer','deploy@2'],
 ['saasInspect',all,'details@1'],['saasCopyId',all,'details@2'],
 ['saasLink','viewItem == saascustomizer || viewItem == saasinstance','customizer@1'],['saasUnlink','viewItem == saasinstance','customizer@2'],
 ['saasLogs',instances,'logs@1'],['saasTail',instances,'logs@2'],['saasStopLogs',instances,'logs@3'],
 ['saasTest','viewItem == saasconnector','test@1']
])menus['view/item/context'].push({command:'iscWorkbench.'+id,when,group});
const contextOnly=['saasRename','saasDelete','saasUpload','saasDeploy','saasRenameCustomizer','saasDeleteCustomizer','saasUploadCustomizer','saasDeployCustomizer','saasLink','saasUnlink','saasInspect','saasCopyId'];
menus.commandPalette=(menus.commandPalette||[]).filter(m=>!contextOnly.includes(m.command.replace('iscWorkbench.','')));
for(const id of contextOnly)menus.commandPalette.push({command:'iscWorkbench.'+id,when:'false'});
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));lock.version=pkg.version;lock.packages[''].version=pkg.version;fs.writeFileSync('package-lock.json',JSON.stringify(lock,null,2)+'\n');
