const path=require('node:path');
require('@vscode/test-electron').runTests({extensionDevelopmentPath:path.resolve(__dirname,'..'),extensionTestsPath:path.resolve(__dirname,'../test/host-smoke.cjs'),launchArgs:['--no-sandbox','--disable-gpu','--ozone-platform=headless','--skip-welcome','--skip-release-notes','--disable-workspace-trust']}).catch(e=>{console.error(e.message);process.exit(1);});
