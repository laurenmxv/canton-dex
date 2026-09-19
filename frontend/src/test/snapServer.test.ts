import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSnapServed,
  SNAP_ASSETS,
  SNAP_DIRECTORY,
  SNAP_HOST,
  snapAsset,
  snapPort,
} from '../../dev/cantonSnap';
import { PUBLISHED_SNAP, PUBLISHED_SNAP_ID, resolveSnapTarget, SNAP_VERSION } from '../wallet/snap';

/** The id the development environment installs, which the port comes from. */
const LOCAL_SNAP = resolveSnapTarget('local:http://localhost:4040', true);

describe('what the development Snap server serves', () => {
  it('answers the four files MetaMask fetches, and each with its own type', () => {
    expect([...SNAP_ASSETS.keys()].sort()).toEqual([
      '/dist/bundle.js',
      '/images/icon.svg',
      '/package.json',
      '/snap.manifest.json',
    ]);
    expect(snapAsset('/snap.manifest.json')?.type).toBe('application/json');
    expect(snapAsset('/images/icon.svg')?.type).toBe('image/svg+xml');
  });

  it.each([
    ['a listing', '/'],
    ['a directory', '/dist/'],
    ['a walk out of the package', '/../src/main.tsx'],
    ['a walk through a known file', '/dist/bundle.js/../../../src/main.tsx'],
    ['the notice beside the package', '/NOTICE.md'],
    ['a prototype key', '/__proto__'],
    ['anything else', '/.env'],
  ])('serves nothing for %s', (_name, url) => {
    expect(snapAsset(url)).toBeNull();
  });

  it('ignores a query or a fragment on a path it does serve', () => {
    expect(snapAsset('/dist/bundle.js?v=1')?.file).toBe(`${SNAP_DIRECTORY}/dist/bundle.js`);
    expect(snapAsset('/package.json#top')?.file).toBe(`${SNAP_DIRECTORY}/package.json`);
  });

  it('listens on loopback, at the port the Snap id itself names', () => {
    expect(SNAP_HOST).toBe('127.0.0.1');
    expect(snapPort(LOCAL_SNAP)).toBe(4040);
    expect(snapPort(resolveSnapTarget('local:http://127.0.0.1:5199', true))).toBe(5199);
    // The published Snap is fetched from npm, so nothing here listens for it.
    expect(PUBLISHED_SNAP.local).toBe(false);
  });
});

describe('the package it serves', () => {
  function asset(path: string): string {
    return readFileSync(`${process.cwd()}/${SNAP_ASSETS.get(path)!.file}`).toString();
  }

  it('is the published Snap at the version this app installs', () => {
    const manifest = JSON.parse(asset('/snap.manifest.json'));
    const npm = JSON.parse(asset('/package.json'));

    expect(manifest.version).toBe(SNAP_VERSION);
    expect(npm.name).toBe(PUBLISHED_SNAP_ID.replace('npm:', ''));
    expect(npm.version).toBe(SNAP_VERSION);
    expect(manifest.source.location.npm.filePath).toBe('dist/bundle.js');
    expect(manifest.source.location.npm.iconPath).toBe('images/icon.svg');
  });

  it('carries the icon MetaMask can read, which is the whole patch', () => {
    const icon = asset('/images/icon.svg');

    // MetaMask's own build cannot close an XML comment, so the icon has none.
    expect(icon).not.toContain('<!--');
    expect(icon).toContain('<svg');
  });
});

describe('when something else already holds the port', () => {
  afterEach(() => vi.unstubAllGlobals());

  const PORT = snapPort(LOCAL_SNAP);

  function answering(body: (path: string) => { ok: boolean; bytes: Uint8Array }) {
    vi.stubGlobal('fetch', (url: string) => {
      const answer = body(new URL(url).pathname);
      return Promise.resolve({
        ok: answer.ok,
        status: answer.ok ? 200 : 404,
        // A copy, because a file read shares one pooled buffer with others.
        arrayBuffer: () => Promise.resolve(new Uint8Array(answer.bytes).buffer),
      } as Response);
    });
  }

  function ours(path: string): Uint8Array {
    return readFileSync(`${process.cwd()}/${SNAP_ASSETS.get(path)!.file}`);
  }

  it('leaves a server that holds the same Snap alone', async () => {
    answering((path) => ({ ok: true, bytes: ours(path) }));

    await expect(assertSnapServed(process.cwd(), PORT)).resolves.toBeUndefined();
  });

  it('refuses a server holding something else, rather than moving the id', async () => {
    answering((path) => ({
      ok: true,
      bytes: path === '/images/icon.svg' ? new TextEncoder().encode('<svg/>') : ours(path),
    }));

    await expect(assertSnapServed(process.cwd(), PORT)).rejects.toThrow(
      /different \/images\/icon\.svg/,
    );
  });

  it('refuses a server that will not serve the Snap at all', async () => {
    answering(() => ({ ok: false, bytes: new Uint8Array() }));

    await expect(assertSnapServed(process.cwd(), PORT)).rejects.toThrow(
      new RegExp(`Port ${PORT} is taken`),
    );
  });
});
