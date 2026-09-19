import {mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
await mkdir('assets/Summon.iconset',{recursive:true});
execFileSync('/usr/bin/swift',['-module-cache-path','/private/tmp/summon-swift-icon-cache','scripts/draw-icon.swift','assets/icon.png']);
for(const size of [16,32,128,256,512])for(const scale of [1,2])execFileSync('/usr/bin/sips',['-z',String(size*scale),String(size*scale),'assets/icon.png','--out',`assets/Summon.iconset/icon_${size}x${size}${scale===2?'@2x':''}.png`],{stdio:'ignore'});
execFileSync('/usr/bin/iconutil',['-c','icns','assets/Summon.iconset','-o','assets/icon.icns']);
await rm('assets/Summon.iconset',{recursive:true,force:true});
console.log('Built Summon app icon');
