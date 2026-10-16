// Embedded diagnostics manifest configuration.
const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='0.9.2';
p.activationEvents=p.activationEvents.filter(s=>s!=='onView:iscWorkbench.operations');
p.contributes.views.iscWorkbench=p.contributes.views.iscWorkbench.filter(v=>v.id!=='iscWorkbench.operations');
const keep=['iscWorkbench.opsRefresh','iscWorkbench.opsDetails','iscWorkbench.opsFilter'];const remove=c=>(c.startsWith('iscWorkbench.ops')&&!keep.includes(c))||c==='iscWorkbench.openOperations';
p.contributes.commands=p.contributes.commands.filter(c=>!remove(c.command));
for(const k of Object.keys(p.contributes.menus))p.contributes.menus[k]=p.contributes.menus[k].filter(m=>!remove(m.command)&&!m.when?.includes('view == iscWorkbench.operations')&&!m.when?.includes('iscOpsjob'));
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');const l=JSON.parse(fs.readFileSync('package-lock.json','utf8'));l.version=p.version;l.packages[''].version=p.version;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2)+'\n');
