import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createFnKeyMonitor} from '../src/main/fn-key.mjs';

function harness(options={}){
  const spawns=[],timers=[],statuses=[];let taps=0,nextTimer=1;
  const spawnChild=(binary,args,opts)=>{
    assert.equal(binary,'/tmp/summon-fn-key');assert.equal(opts.stdio.join(','),'pipe,pipe,pipe');
    assert.equal(opts.env.ANTHROPIC_API_KEY,undefined);assert.equal(opts.env.PATH,'/usr/bin:/bin:/usr/sbin:/sbin');
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};
    child.writes=[];child.ended=false;child.killed=false;
    child.stdin={on(){},end(){child.ended=true;},write(text){child.writes.push(text);}};
    child.kill=()=>{child.killed=true;child.emit('exit',null);};
    child.say=message=>child.stdout.emit('data',Buffer.from(`${JSON.stringify(message)}\n`));
    spawns.push({args,child});return child;
  };
  const setTimer=(fn,ms)=>{const timer={id:nextTimer++,fn,ms,unref(){}};timers.push(timer);return timer;};
  const clearTimer=timer=>{const index=timers.indexOf(timer);if(index>=0)timers.splice(index,1);};
  const fire=ms=>{const index=timers.findIndex(timer=>timer.ms===ms);assert.ok(index>=0,`no ${ms}ms timer pending`);const [timer]=timers.splice(index,1);timer.fn();};
  const monitor=createFnKeyMonitor({executable:'/tmp/summon-fn-key',onTap:()=>{taps++;},onStatus:status=>statuses.push(status),spawnChild,setTimer,clearTimer,retryMs:250,maxRetries:3,...options});
  return {monitor,spawns,timers,statuses,fire,taps:()=>taps,last:()=>spawns.at(-1).child};
}

test('a ready helper forwards bare Fn taps and nothing before it is ready',()=>{
  const h=harness();h.monitor.start();
  assert.equal(h.spawns.length,1);assert.deepEqual(h.spawns[0].args,[]);
  h.last().say({type:'fn-tap'});assert.equal(h.taps(),0);
  h.last().say({type:'ready'});h.last().say({type:'fn-tap'});h.last().say({type:'fn-tap'});
  assert.equal(h.taps(),2);assert.deepEqual(h.statuses,['starting','ready']);
  assert.equal(h.timers.length,0,'the ready deadline is cleared');
  h.last().say({type:'fn-tap',extra:'x'});assert.equal(h.taps(),3);
});

test('a missing grant asks macOS once, then re-checks quietly until it is granted',()=>{
  const h=harness();h.monitor.start();
  h.last().say({type:'permission-required'});h.last().emit('exit',77);
  assert.equal(h.spawns.length,2);assert.deepEqual(h.spawns[1].args,['--request-permission']);
  h.last().say({type:'permission-required'});h.last().emit('exit',77);
  assert.equal(h.spawns.length,2,'no relaunch before the retry timer');assert.equal(h.timers.length,1);
  h.fire(250);assert.equal(h.spawns.length,3);assert.deepEqual(h.spawns[2].args,[]);
  h.last().say({type:'permission-required'});h.last().emit('exit',77);
  assert.equal(h.spawns.filter(s=>s.args.length).length,1,'macOS is asked only once per run');
  h.fire(250);h.last().say({type:'ready'});
  assert.equal(h.monitor.status(),'ready');
  assert.deepEqual(h.statuses,['starting','permission-required','ready'],'quiet re-checks do not flicker through starting');
});

test('permission granted from the prompt relaunches the helper immediately',()=>{
  const h=harness();h.monitor.start();
  h.last().say({type:'permission-required'});h.last().emit('exit',77);
  h.last().say({type:'permission-granted'});h.last().emit('exit',0);
  assert.equal(h.spawns.length,3);assert.deepEqual(h.spawns[2].args,[]);
  h.last().say({type:'ready'});assert.equal(h.monitor.status(),'ready');
});

test('exhausted retries wait for a poke, which restarts the quiet re-check',()=>{
  const h=harness({maxRetries:1});h.monitor.start();
  h.last().say({type:'permission-required'});h.last().emit('exit',77);
  h.last().say({type:'permission-required'});h.last().emit('exit',77);
  h.fire(250);h.last().say({type:'permission-required'});h.last().emit('exit',77);
  assert.equal(h.timers.length,0,'retries are bounded');assert.equal(h.monitor.status(),'permission-required');
  h.monitor.poke();assert.equal(h.spawns.length,4);assert.deepEqual(h.spawns[3].args,[]);
  h.last().say({type:'ready'});assert.equal(h.monitor.status(),'ready');
  h.monitor.poke();assert.deepEqual(h.last().writes,['reset\n'],'a poke while running resets the detector after sleep or unlock');
  assert.equal(h.spawns.length,4);
});

test('a helper error stops without retrying and stop() ends the helper cleanly',()=>{
  const h=harness();h.monitor.start();
  h.last().say({type:'error',message:'no tap'});
  assert.equal(h.monitor.status(),'error');assert.ok(h.last().killed);assert.equal(h.timers.length,0);
  h.monitor.poke();assert.equal(h.spawns.length,1,'an error is not retried by a poke');
  const g=harness();g.monitor.start();g.last().say({type:'ready'});
  g.monitor.stop();
  assert.ok(g.last().ended&&g.last().killed);assert.equal(g.monitor.status(),'off');
  g.monitor.start();g.monitor.poke();assert.equal(g.spawns.length,1,'a stopped monitor never relaunches');
});

test('an unexpected exit of a ready helper is retried, and floods or timeouts become errors',()=>{
  const h=harness();h.monitor.start();h.last().say({type:'ready'});
  h.last().emit('exit',0);
  assert.equal(h.monitor.status(),'starting');assert.equal(h.timers.length,1);
  h.fire(250);h.last().say({type:'ready'});assert.equal(h.monitor.status(),'ready');
  h.last().stdout.emit('data',Buffer.alloc(9000,'x'));
  assert.equal(h.monitor.status(),'error');assert.ok(h.last().killed);
  const g=harness();g.monitor.start();
  g.fire(10000);assert.equal(g.monitor.status(),'error');assert.ok(g.last().killed);
  const r=harness();r.monitor.start();r.last().say({type:'permission-required'});r.last().emit('exit',77);
  r.fire(10000);
  assert.equal(r.monitor.status(),'permission-required','a stalled prompt is not an error');assert.equal(r.timers.filter(t=>t.ms===250).length,1);
});
