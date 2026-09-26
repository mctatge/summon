import {spawnSync} from 'node:child_process';
import {mkdirSync,chmodSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

if(process.platform!=='darwin')throw new Error('Desktop teaching requires macOS.');
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const cache=`/private/tmp/summon-teaching-swift-cache-${process.getuid()}`;
mkdirSync(cache,{recursive:true,mode:0o700});
const output=join(root,'native','summon-teaching');
const result=spawnSync('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',cache,
  '-framework','AppKit','-framework','ApplicationServices','-framework','ScreenCaptureKit','-framework','Vision',
  join(root,'native','Teaching.swift'),join(root,'native','TeachingOCR.swift'),'-o',output],
  {stdio:'inherit',env:{...process.env,CLANG_MODULE_CACHE_PATH:cache,SWIFT_MODULECACHE_PATH:cache}});
if(result.error||result.status!==0)throw new Error(`Could not compile desktop teaching: ${result.error?.message||result.status}`);
chmodSync(output,0o755);console.log(`Built ${output}`);
