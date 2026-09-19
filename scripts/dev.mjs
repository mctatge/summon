import {spawn} from 'node:child_process';
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit'});
let electron;
const cleanup=()=>{vite.kill();electron?.kill();};
process.on('SIGINT',cleanup);process.on('SIGTERM',cleanup);
for(let n=0;n<50;n++){
  try{await fetch('http://127.0.0.1:5179');electron=spawn('node_modules/.bin/electron',['.'],{stdio:'inherit',env:{...process.env,SUMMON_DEV_URL:'http://127.0.0.1:5179'}});electron.on('exit',()=>{cleanup();process.exit(0);});break;}
  catch{await new Promise(r=>setTimeout(r,200));}
}
if(!electron){cleanup();throw new Error('Vite did not start');}
