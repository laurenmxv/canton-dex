import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the seam mechanically. Comments describing a boundary rot; this
 * fails the build instead.
 */
// jsdom gives `import.meta.url` an http base, so resolve from the project root.
const SRC = join(process.cwd(), 'src');

function sourcesUnder(...directories: string[]): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  directories.forEach((directory) => walk(join(SRC, directory)));
  return files;
}

function read(path: string): { name: string; text: string } {
  return { name: relative(SRC, path), text: readFileSync(path, 'utf8') };
}

describe('webapp and client boundary', () => {
  // A colocated test is not a screen; its fixtures may quote URLs a screen must not fetch.
  const screens = sourcesUnder('features', 'ui')
    .filter((path) => !/\.test\.tsx?$/.test(path))
    .map(read);
  screens.push(read(join(SRC, 'App.tsx')));

  it('keeps transport, credentials and Canton out of every screen', () => {
    const forbidden = [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /XMLHttpRequest/,
      /new WebSocket/,
      /https?:\/\//,
      /\bBearer\b/,
      /localStorage/,
      // The header, not the words "Authorization Code" in sign-in copy.
      /Authorization\s*:/,
    ];
    const offenders = screens.flatMap(({ name, text }) =>
      forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${name} ${pattern}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never lets a screen reach the venue through the SDK either', () => {
    const offenders = screens
      .filter(({ text }) => /from '@canton-dex\/client'/.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('keeps the simulated surfaces out of the sections real mode serves', () => {
    const real = ['features/onboarding', 'features/dashboard/AttestationReceipt.tsx'];
    const offenders = sourcesUnder('features')
      .filter((file) => real.some((prefix) => file.includes(prefix)))
      .map(read)
      .filter(({ text }) => text.includes('requireDemoApi'))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('asks no screen to handle a private key', () => {
    const forbidden = [/privateKey/, /secretKey/, /mnemonic/i, /seedPhrase/i, /readText\(/];
    const offenders = screens.flatMap(({ name, text }) =>
      forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${name} ${pattern}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never builds the HTTP client outside the composition point', () => {
    const offenders = sourcesUnder('features', 'ui', 'app', 'lib', 'auth', 'mocks')
      .map(read)
      .filter(({ text }) => text.includes('createDexClient'))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('never lets a screen import the fixture', () => {
    const offenders = screens
      .filter(({ text }) => /from '[^']*mocks\//.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('constructs the backend only at the composition point', () => {
    const offenders = sourcesUnder('features', 'ui', 'app', 'lib', 'auth')
      .map(read)
      .filter(({ text }) => text.includes('createFixtureBackend'))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('reads environment configuration in one place', () => {
    const offenders = sourcesUnder('features', 'ui', 'app', 'lib', 'mocks')
      .map(read)
      .filter(({ text }) => text.includes('import.meta.env'))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('keeps the fixture out of the runtime wiring', () => {
    const wiring = sourcesUnder('app').map(read);
    const offenders = wiring
      .filter(({ text }) => /from '[^']*mocks\//.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('asks no screen to supply the acting account', () => {
    const port = readFileSync(join(SRC, 'lib/api/port.ts'), 'utf8');
    expect(port).not.toMatch(/accountId\s*:/);
    expect(port).not.toMatch(/walletApproval/);
  });
});
