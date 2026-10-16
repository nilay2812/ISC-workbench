const fs=require('node:fs'),cp=require('node:child_process');
for(const f of fs.readdirSync('src').filter(f=>f.endsWith('.js')))cp.execFileSync(process.execPath,['--check','src/'+f],{stdio:'inherit'});
console.log('JavaScript syntax checks passed.');
