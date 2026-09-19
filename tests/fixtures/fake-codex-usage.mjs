// A scripted stand-in for `codex app-server` answering the handshake and one account/rateLimits/read.
// Message shapes copy a live probe from 2026-09-19; argv picks the scenario. thread/start is refused loudly.
import {appendFileSync} from 'node:fs';
import readline from 'node:readline';

const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i>=0?process.argv[i+1]:fallback;};
const scenario=arg('scenario','ok'),log=arg('log');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const notify=(method,params)=>send({jsonrpc:'2.0',method,params});
const record=m=>{if(log)appendFileSync(log,JSON.stringify(m)+'\n');};
const epoch=hours=>Math.floor((Date.UTC(2026,8,19,20,0,0)+hours*3600_000)/1000);
const window=(mins,used,hours)=>({usedPercent:used,windowDurationMins:mins,resetsAt:epoch(hours),resetsInSeconds:hours*3600});
const limits=(primary,secondary,plan='plus')=>({rateLimits:{primary,secondary,planType:plan,rateLimitReachedType:null,spendControlReached:false,credits:{hasCredits:false,unlimited:false,balance:'0'},accountId:'acc_secret',upsell:{kind:'plus'}},rateLimitsByLimitId:{codex:{primary,secondary}}});
const ESC=String.fromCharCode(27);
// The server-request scenario holds its answer until the client's refusal has arrived (bounded), so the test sees the refusal itself.
let refused=false,pendingAnswer=null;
process.stdout.write('fake codex app-server banner, not JSON\n');
if(scenario==='stderr-auth')process.stderr.write(`${ESC}[2m2026-09-19T16:44:51.086443Z${ESC}[0m ${ESC}[31mERROR${ESC}[0m codex_core::auth: failed to refresh access token: invalid_grant\n`,()=>process.exit(1));
if(scenario==='exit')process.stdout.write('',()=>process.exit(3));
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  record(m);
  if(m.id!==undefined&&m.method===undefined){if(m.id==='srv-1'){refused=true;if(pendingAnswer){pendingAnswer();pendingAnswer=null;}}return;}
  switch(m.method){
    case 'initialize':
      if(scenario==='init-error')return send({jsonrpc:'2.0',id:m.id,error:{code:-32600,message:'bad client'}});
      send({jsonrpc:'2.0',id:m.id,result:{userAgent:'summon/0.155.0-alpha.9.2 (fake)',codexHome:'/nonexistent/.codex',platformFamily:'unix',platformOs:'macos'}});
      notify('remoteControl/status/changed',{status:'disabled',serverName:'fake'});
      if(scenario==='server-request')send({jsonrpc:'2.0',id:'srv-1',method:'mcpServer/elicitation/request',params:{message:'Allow?'}});
      if(scenario==='auth-notification')notify('error',{error:{message:'Failed to refresh ChatGPT credentials: 401 Unauthorized. Please login again.'},willRetry:false});
      if(scenario==='retry-notification')notify('error',{error:{message:'stream disconnected before completion: 401 Unauthorized'},willRetry:true});
      return;
    case 'initialized':return;
    case 'account/rateLimits/read':
      switch(scenario){
        case 'ok':return send({jsonrpc:'2.0',id:m.id,result:limits(window(10080,1,100),null,'plus')});
        case 'both':return send({jsonrpc:'2.0',id:m.id,result:limits(window(300,41.26,2),window(10080,12,120),'pro')});
        case 'odd':return send({jsonrpc:'2.0',id:m.id,result:limits(window(1440,60,5),window(300,10,1),'team')});
        case 'unauthorized':return send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'Failed to refresh ChatGPT credentials: 401 Unauthorized. Please login again.'}});
        case 'unauthorized-info':return send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'Request failed.',data:{codexErrorInfo:'unauthorized'}}});
        case 'null':return send({jsonrpc:'2.0',id:m.id,result:{rateLimits:null,rateLimitsByLimitId:{}}});
        case 'malformed':return send({jsonrpc:'2.0',id:m.id,result:{rateLimits:'nope'}});
        case 'missing':return send({jsonrpc:'2.0',id:m.id,result:{}});
        case 'hang':return;
        case 'retry-notification':return send({jsonrpc:'2.0',id:m.id,result:limits(window(300,5,1),window(10080,2,50),'plus')});
        case 'server-request':{const answer=()=>send({jsonrpc:'2.0',id:m.id,result:limits(window(300,5,1),window(10080,2,50),refused?'plus':'no-refusal')});if(refused)return answer();pendingAnswer=answer;setTimeout(()=>{if(pendingAnswer){pendingAnswer();pendingAnswer=null;}},2000);return;}
        default:return send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:`unknown scenario ${scenario}`}});
      }
    case 'thread/start':process.stderr.write('THREAD START MUST NEVER HAPPEN\n');return send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'refused'}});
    default:return send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:`Method not found: ${m.method}`}});
  }
}).on('close',()=>process.exit(0));
