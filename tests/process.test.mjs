import test from 'node:test';
import assert from 'node:assert/strict';
import {scrubbedEnv,run,spawnLongLived} from '../src/main/process.mjs';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
test('engine child environments exclude API billing credentials and ambient commands',()=>{
  process.env.ANTHROPIC_API_KEY='test-never-forward';process.env.OPENAI_API_KEY='test-never-forward';process.env.CODEX_API_KEY='test-never-forward';process.env.NODE_OPTIONS='--inspect';process.env.CLAUDECODE='1';
  try{const env=scrubbedEnv();for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY','NODE_OPTIONS','CLAUDECODE'])assert.equal(env[key],undefined);assert.ok(env.HOME);}
  finally{delete process.env.ANTHROPIC_API_KEY;delete process.env.OPENAI_API_KEY;delete process.env.CODEX_API_KEY;delete process.env.NODE_OPTIONS;delete process.env.CLAUDECODE;}
});
test('shutdown terminates stubborn children, awaits cleanup and rejects new work',async()=>{
  // A distinct module instance keeps this irreversible shutdown isolated from
  // other process tests, just as a new app process gets its own registry.
  const isolated=await import('../src/main/process.mjs?shutdown-test');
  const dir=await mkdtemp('/private/tmp/summon-process-shutdown-');
  const ready=path.join(dir,'ready.json');
  const script=`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
  const job=(async()=>{try{return await isolated.run(process.execPath,['-e',script],{timeout:60000});}finally{await rm(dir,{recursive:true,force:true});}})();
  const completed=job.catch(error=>error);
  let pid;
  try{
    for(let attempt=0;attempt<100;attempt++){
      try{pid=JSON.parse(await readFile(ready,'utf8')).pid;break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}
    }
    assert.ok(pid,'The synthetic child must start before shutdown.');
    const started=Date.now();
    await isolated.stopProcesses();
    const error=await completed;
    assert.match(error.message,/shutting down/);
    assert.ok(Date.now()-started<3000,'SIGKILL must bound a child that ignores SIGTERM.');
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    await assert.rejects(access(dir),{code:'ENOENT'});
    await assert.rejects(isolated.run(process.execPath,['-e','process.exit(0)']),/shutting down/);
  }finally{await isolated.stopProcesses();await completed;await rm(dir,{recursive:true,force:true});}
});
test('process wrapper sends literal text over stdin and limits oversized output',async()=>{
  const result=await run(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:'$(do-not-run) `literal`'});assert.equal(result.stdout,'$(do-not-run) `literal`');
  await assert.rejects(run(process.execPath,['-e','process.stdout.write("x".repeat(10000))'],{maxBytes:100}),/size/);
});
test('process wrapper keeps multi-byte characters intact across output chunks',async()=>{
  const script='const a=Buffer.alloc(65535,120);const b=Buffer.from("\\u2014 end");process.stdout.write(Buffer.concat([a,b]));';
  const result=await run(process.execPath,['-e',script],{maxBytes:200000});
  assert.equal(result.stdout.length,65535+5);assert.ok(result.stdout.endsWith('— end'));assert.ok(!result.stdout.includes('�'));
});
test('long-lived children get the allowlist environment and shutdown ends their whole group',async()=>{
  const isolated=await import('../src/main/process.mjs?long-lived-test');
  const keys=['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY'];for(const key of keys)process.env[key]='test-never-forward';
  const dir=await mkdtemp('/private/tmp/summon-process-long-lived-');
  const ready=path.join(dir,'ready.json');
  // The child ignores SIGTERM so shutdown must escalate; its grandchild proves the whole group is signalled.
  const script=`process.on('SIGTERM',()=>{});const kid=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,kid:kid.pid,leaked:${JSON.stringify(keys)}.filter(key=>key in process.env)}));setInterval(()=>{},1000);`;
  const handle=isolated.spawnLongLived(process.execPath,['-e',script],{env:isolated.scrubbedEnv()});
  try{
    let info;
    for(let attempt=0;attempt<300&&!info;attempt++){try{info=JSON.parse(await readFile(ready,'utf8'));}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
    assert.ok(info,'The long-lived child must start.');assert.deepEqual(info.leaked,[]);
    assert.equal(typeof handle.child.pid,'number');assert.equal(typeof handle.stop,'function');
    const started=Date.now();
    await isolated.stopProcesses();await handle.closed;
    const elapsed=Date.now()-started;assert.ok(elapsed>=2500&&elapsed<6000,`SIGKILL follows SIGTERM after 3 s (took ${elapsed} ms).`);
    for(const pid of [info.pid,info.kid])assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    assert.throws(()=>isolated.spawnLongLived(process.execPath,['-e','0']),/shutting down/);
  }finally{for(const key of keys)delete process.env[key];await isolated.stopProcesses();await rm(dir,{recursive:true,force:true});}
});
test('long-lived stop is idempotent and resolves once the child has exited',async()=>{
  const handle=spawnLongLived(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0))']);
  const first=handle.stop(),second=handle.stop();assert.equal(first,second);
  await first;assert.ok(handle.child.exitCode!==null||handle.child.signalCode!==null);
});
