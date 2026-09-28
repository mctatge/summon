/** The two ways the session readers open another app's file: a regular file only, and a bounded range of it.
 * Shared by the Claude reader's passes (claude.mjs) and the work-log pass (work-log.mjs). */
import fs from 'node:fs/promises';

// Opens a regular file only: O_NOFOLLOW so a symlink planted under a session file name cannot aim this at config.json
// or a .key file, O_NONBLOCK so a pipe returns an fd instead of waiting for a writer. The size comes from the fd, so
// nothing can be swapped between the stat and the read. Callers already treat a throw as "skip this file".
export async function openRead(file) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('Not a regular file.'), { code: 'EFTYPE' });
    return { handle, stat };
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}

/** Up to `length` bytes from `start`; fewer when the file is shorter than that. */
export async function readRange(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}
