// A scripted stand-in for `claude -p --input-format stream-json` answering one get_usage control request.
// Message shapes copy a live probe from 2026-09-19; argv picks the scenario.
import {appendFileSync} from 'node:fs';
import readline from 'node:readline';

const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i>=0?process.argv[i+1]:fallback;};
const scenario=arg('scenario','ok'),log=arg('log');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const record=m=>{if(log)appendFileSync(log,JSON.stringify(m)+'\n');};
const resets=hours=>new Date(Date.UTC(2026,8,19,20,0,0)+hours*3600_000).toISOString();
// The real CLI prints its init line before it reads stdin.
send({type:'system',subtype:'init',cwd:process.cwd(),session_id:'11111111-2222-4333-8444-555555555555',tools:[],mcp_servers:[],model:'claude-opus-4-7',permissionMode:'dontAsk',apiKeySource:'none',claude_code_version:'2.1.278',output_style:'default',uuid:'u-1'});
if(scenario==='noisy')process.stdout.write('not json at all\n[1,2]\n"a string"\n');
if(scenario==='exit-auth')process.stderr.write('Not logged in. Please run /login\n',()=>process.exit(1));
if(scenario==='exit')process.stderr.write('boom\n',()=>process.exit(2));
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  record(m);
  if(m.type!=='control_request'||m.request?.subtype!=='get_usage')return;
  const id=m.request_id;
  const success=body=>send({type:'control_response',response:{subtype:'success',request_id:id,response:body}});
  switch(scenario){
    case 'ok':case 'noisy':return success({subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:27.3,resets_at:resets(3)},seven_day:{utilization:18,resets_at:resets(90)},seven_day_opus:null,seven_day_sonnet:{utilization:2.5,resets_at:resets(90)},seven_day_internal_pool:{utilization:99,resets_at:resets(1)},overage:{utilization:0}},session_cost_usd:0.42,behaviors:{skipped:true},context:{tokens:1234}});
    case 'not-signed-in':return success({subscription_type:null,rate_limits_available:false,rate_limits:{}});
    case 'no-plan':return success({subscription_type:null,rate_limits_available:true,rate_limits:{five_hour:{utilization:5,resets_at:resets(1)}}});
    case 'no-limits':return success({subscription_type:'max',rate_limits_available:false,rate_limits:{}});
    case 'null-limits':return success({subscription_type:'max',rate_limits_available:true,rate_limits:null});
    case 'refused':return send({type:'control_response',response:{subtype:'error',request_id:id,error:'Unknown control request subtype get_usage'}});
    case 'auth-refused':return send({type:'control_response',response:{subtype:'error',request_id:id,error:'Failed to authenticate: OAuth session expired and could not be refreshed'}});
    case 'auth-result':return send({type:'result',subtype:'success',is_error:true,result:'Failed to authenticate: OAuth session expired and could not be refreshed',session_id:'x',total_cost_usd:0});
    case 'malformed':return success('nope');
    case 'unwrapped':return send({type:'control_response',response:'nope'});
    case 'hang':return;
    default:return success({subscription_type:'max',rate_limits_available:true,rate_limits:{}});
  }
}).on('close',()=>process.exit(0));
