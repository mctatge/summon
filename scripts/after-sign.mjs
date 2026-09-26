import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';

// electron-builder afterSign hook. The local bundle is ad-hoc signed, and an
// ad-hoc signature's default designated requirement is its cdhash, so every
// rebuild used to invalidate the Input Monitoring and Accessibility grants that
// macOS keys to that requirement. Re-sign only the outer bundle with a
// requirement made of the bundle identifier; nested helpers keep their own
// signatures and the seal over them. See docs/decisions.md 2026-09-18.
export default async function afterSign(context){
  if(context.electronPlatformName!=='darwin')return;
  const {packager}=context;
  const appPath=path.join(context.appOutDir,`${packager.appInfo.productFilename}.app`);
  const identifier=packager.appInfo.id;
  const options=packager.platformSpecificBuildOptions||{};
  if(options.identity!=='-'&&options.identity!==null)return; // A real certificate already gives a stable requirement.
  const entitlements=path.resolve(packager.projectDir,options.entitlements||'build/entitlements.mac.plist');
  // The teaching helper can also own an Accessibility/Input Monitoring grant.
  // Keep that local identity stable across rebuilds, then reseal the outer app.
  const teaching=path.join(appPath,'Contents','Resources','summon-teaching');
  if(existsSync(teaching)){
    const helperId=`${identifier}.teaching`;
    const result=spawnSync('/usr/bin/codesign',['--force','--sign','-','--options','runtime','--identifier',helperId,'--requirements',`=designated => identifier "${helperId}"`,teaching],{stdio:'inherit'});
    if(result.error||result.status!==0)throw new Error(`Teaching helper signature failed: ${result.error?.message||result.status}`);
  }
  const requirement=`=designated => identifier "${identifier}"`;
  const sign=spawnSync('/usr/bin/codesign',['--force','--sign','-','--options','runtime','--identifier',identifier,'--entitlements',entitlements,'--requirements',requirement,appPath],{stdio:'inherit'});
  if(sign.error||sign.status!==0)throw new Error(`Stable ad-hoc signature failed: ${sign.error?.message||`codesign exited ${sign.status}`}`);
  const verify=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=1',appPath],{encoding:'utf8'});
  if(verify.status!==0)throw new Error(`Signature verification failed after re-signing:\n${verify.stderr}`);
  const shown=spawnSync('/usr/bin/codesign',['--display','-r-',appPath],{encoding:'utf8'});
  if(!/designated => identifier "/.test(shown.stdout))throw new Error(`Designated requirement was not applied:\n${shown.stdout}${shown.stderr}`);
  console.log(`  • stable requirement  ${shown.stdout.trim().split('\n').pop()}`);
}
