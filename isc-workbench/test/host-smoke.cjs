const assert=require('node:assert/strict');
const vscode=require('vscode');
exports.run=async()=>{
 const extension=vscode.extensions.getExtension('nilay-mani.isc-workbench');assert(extension,'Extension installed');
 const app=await extension.activate();assert(app.catalog.index.operations.length===3315);
 const commands=await vscode.commands.getCommands(true);
 for(const command of extension.packageJSON.contributes.commands)assert(commands.includes(command.command),command.command);
 await vscode.commands.executeCommand('iscWorkbench.home');
 console.log('Extension-host smoke passed: activation, catalog, commands, and dashboard.');
};
