// Fixture child: actual source parser and atomic journal, terminated by the crash test without cleanup.
import fs from 'node:fs/promises';
const { createWorkRecovery } = await import(new URL('../../src/core/work-recovery.mjs', import.meta.url).href);
const { createWorkRecoverySources } = await import(new URL('../../src/core/sessions/work-recovery-sources.mjs', import.meta.url).href);

const [homeDir, repoPath, dataDir, mode, sourceFile, sessionId, start] = process.argv.slice(2);
let clock = Number(start);
const repo = { id: 'fixture-repo', path: repoPath, places: [], name: 'Crash fixture' };
const sourceReader = createWorkRecoverySources({ homeDir });
const service = await createWorkRecovery({ dataDir, getRepositories: async () => [repo], sourceReader, now: () => clock });
try {
  if (mode === 'prime') {
    await service.setEnabled({ repoId: repo.id, enabled: true });
    clock += 1;
    await fs.appendFile(sourceFile, `${JSON.stringify({ type: 'user', sessionId, cwd: repoPath, entrypoint: 'cli',
      uuid: '00000000-0000-4000-8000-000000000011', timestamp: new Date(clock).toISOString(),
      message: { role: 'user', content: 'Remember the pending parser check. Test key sk-Ab12cd34EF56gh78IJ90kl12 must be masked.' } })}\n`);
    const captured = await service.scan({ repoId: repo.id });
    process.send({ type: 'ready', captured });
    setInterval(() => {}, 60000); // Remain alive until the parent kills this process, without close().
  } else {
    const first = await service.scan({ repoId: repo.id });
    const second = await service.scan({ repoId: repo.id });
    await service.close();
    process.send({ type: 'recovered', first, second }, () => process.disconnect());
  }
} catch (error) {
  process.send?.({ type: 'failure', message: error.message });
  await service.close();
  process.disconnect?.(); process.exitCode = 1;
}
