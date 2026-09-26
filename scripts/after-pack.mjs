import { copyFile } from 'node:fs/promises';
import path from 'node:path';

// The app imports this canonical module from app.asar. Declaring the same source
// in extraResources makes electron-builder exclude it from that archive, so copy
// the standalone MCP adapter's sibling after packing and before signing instead.
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { packager } = context;
  const resources = path.join(context.appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  await copyFile(path.join(packager.projectDir, 'src', 'core', 'work-item-protocol.mjs'), path.join(resources, 'work-item-protocol.mjs'));
}
