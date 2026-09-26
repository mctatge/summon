import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const source=dirname(fileURLToPath(import.meta.url));
const output=process.argv[2]||'/private/tmp/summon-native-teaching-fixtures';
mkdirSync(output,{recursive:true});
const binary=join(output,'fixture');
const built=spawnSync('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',join(output,'swift-cache'),'-framework','AppKit',join(source,'Fixture.swift'),'-o',binary],{stdio:'inherit'});
if(built.status!==0)throw new Error('Could not compile the teaching fixture.');
for(const [suffix,name] of [['catalog','Summon Teaching Catalog'],['receiver','Summon Teaching Receiver']]){
  const app=join(output,`${name}.app`),contents=join(app,'Contents');mkdirSync(join(contents,'MacOS'),{recursive:true});
  copyFileSync(binary,join(contents,'MacOS','fixture'));
  writeFileSync(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>com.summon.teaching.fixture.${suffix}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const signed=spawnSync('/usr/bin/codesign',['--force','--sign','-',app],{encoding:'utf8'});if(signed.status!==0)throw new Error(signed.stderr);console.log(app);
}
