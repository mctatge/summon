import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(fileURLToPath(import.meta.url)),folder=mkdtempSync(join(tmpdir(),'summon-teaching-check-'));
const cache=`/private/tmp/summon-teaching-swift-cache-${process.getuid()}`;
mkdirSync(cache,{recursive:true,mode:0o700});
try{
  const binary=join(folder,'check');
  const compiled=spawnSync('/usr/bin/xcrun',['swiftc','-D','SUMMON_TEACHING_TEST','-module-cache-path',cache,
    '-framework','AppKit','-framework','ApplicationServices','-framework','ScreenCaptureKit','-framework','Vision',
    join(root,'Teaching.swift'),join(root,'TeachingOCR.swift'),join(root,'TeachingOCRChecks.swift'),'-o',binary],{encoding:'utf8'});
  if(compiled.status!==0)throw new Error(compiled.stderr||'Native teaching compile failed.');
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:20_000});
  if(result.status!==0||!result.stdout.includes('passed'))throw new Error(result.stderr||'Native teaching checks failed.');
  console.log('Native teaching synthetic checks passed. No other app was inspected.');
}finally{rmSync(folder,{recursive:true,force:true});}
