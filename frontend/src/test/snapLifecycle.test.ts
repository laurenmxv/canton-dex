// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { cantonSnapServer, SNAP_ASSETS, SNAP_HOST } from '../../dev/cantonSnap';

/**
 * The dev server's own lifecycle, against a real Vite server.
 *
 * A restart creates the server that takes over before the old one is gone, so
 * only a close Vite waits for keeps the Snap reachable throughout. This starts
 * a real listener, so it asks the operating system for a free port rather than
 * touching the one a development environment is using.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocket();
    probe.once('error', reject);
    probe.listen(0, SNAP_HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function manifest(port: number): Promise<string> {
  const answer = await fetch(`http://${SNAP_HOST}:${port}/snap.manifest.json`, {
    signal: AbortSignal.timeout(2_000),
  });
  return answer.text();
}

const OURS = readFileSync(`${ROOT}/${SNAP_ASSETS.get('/snap.manifest.json')!.file}`).toString();

let vite: ViteDevServer | undefined;
let configured: string | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await vite?.close();
  vite = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
  if (configured === undefined) delete process.env['VITE_SNAP_ID'];
  else process.env['VITE_SNAP_ID'] = configured;
});

/** A configuration file of its own, so a restart builds a new plugin. */
function writeConfigFile(): string {
  scratch = mkdtempSync(`${tmpdir()}/canton-snap-`);
  const file = `${scratch}/vite.config.mts`;
  writeFileSync(
    file,
    `import { cantonSnapServer } from '${ROOT}/dev/cantonSnap';\n` +
      `export default {\n` +
      `  root: '${ROOT}',\n` +
      `  logLevel: 'silent',\n` +
      `  plugins: [cantonSnapServer()],\n` +
      `  server: { port: 0, strictPort: false },\n` +
      `};\n`,
  );
  return file;
}

describe('the development Snap across a dev server lifecycle', () => {
  it('keeps serving the Snap through a restart, and stops at the close', async () => {
    const port = await freePort();
    configured = process.env['VITE_SNAP_ID'];
    process.env['VITE_SNAP_ID'] = `local:http://localhost:${port}`;

    vite = await createServer({
      configFile: false,
      root: ROOT,
      logLevel: 'silent',
      plugins: [cantonSnapServer()],
      server: { port: 0, strictPort: false },
    });
    await vite.listen();

    expect(await manifest(port)).toBe(OURS);

    // What a config change does: the next server takes the port over.
    await vite.restart();
    expect(await manifest(port)).toBe(OURS);

    await vite.close();
    vite = undefined;
    await expect(manifest(port)).rejects.toThrow();
  });

  it('starts nothing where the build asks for the published Snap', async () => {
    const port = await freePort();
    configured = process.env['VITE_SNAP_ID'];
    delete process.env['VITE_SNAP_ID'];

    vite = await createServer({
      configFile: false,
      root: ROOT,
      logLevel: 'silent',
      plugins: [cantonSnapServer()],
      server: { port: 0, strictPort: false },
    });
    await vite.listen();

    await expect(manifest(port)).rejects.toThrow();
  });

  it('hands the port over when a config reload builds a new plugin', async () => {
    const port = await freePort();
    configured = process.env['VITE_SNAP_ID'];
    process.env['VITE_SNAP_ID'] = `local:http://localhost:${port}`;

    // Vite loads the file again on restart, so the server taking over and the
    // one leaving are two plugins that have to agree about one listener.
    vite = await createServer({ configFile: writeConfigFile() });
    await vite.listen();

    expect(await manifest(port)).toBe(OURS);

    await vite.restart();
    expect(await manifest(port)).toBe(OURS);

    await vite.close();
    vite = undefined;
    await expect(manifest(port)).rejects.toThrow();
  });
});
