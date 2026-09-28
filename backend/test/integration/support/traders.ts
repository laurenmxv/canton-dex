import { sign as signBytes } from 'node:crypto';
import { expect } from 'vitest';
import { compareDecimal, numericUnits, trimmedText } from '../../../src/platform/decimal.js';
import { at, items, text } from '../../support/json.js';
import { delay, ed25519KeyPair, publicKey, type BackendFixture, type KeyPair } from './backend.js';

const STATUS_TIMEOUT_MS = 55_000;
const STATUS_POLL_MS = 500;
const TERMINAL_FAILURES = new Set(['FAILED', 'REJECTED', 'CANCELLED', 'BLOCKED']);

export interface Trader {
  readonly name: string;
  readonly key: KeyPair;
  readonly party: string;
}

export interface Signed {
  readonly preparationId: string;
  readonly signature: string;
}

/** Polls until `done` holds; a failed assertion inside `done` fails at once. */
export async function until(done: () => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${String(timeoutMs)} ms`);
    await delay(pollMs);
  }
}

/** The wallet signature: raw Ed25519, or DER ECDSA over SHA-256 for a secp256k1 key. */
export function walletSignature(key: KeyPair, bytes: Buffer): string {
  const algorithm = key.privateKey.asymmetricKeyType === 'ed25519' ? null : 'sha256';
  return signBytes(algorithm, bytes, key.privateKey).toString('base64');
}

function signField(key: KeyPair, preparation: unknown, field: string): Signed {
  return {
    preparationId: text(preparation, 'preparationId'),
    signature: walletSignature(key, Buffer.from(text(preparation, field), 'base64')),
  };
}

/** The wallet's signature of a prepared transaction hash. */
export function sign(key: KeyPair, preparation: unknown): Signed {
  expect(at(preparation, 'hashEncoding')).toBe('base64');
  return signField(key, preparation, 'preparedTransactionHash');
}

/** The resource once its status is one of `expected`; a failed, rejected or blocked state fails. */
export async function status(test: BackendFixture, path: string, token: string, ...expected: string[]) {
  let value: unknown;
  await until(
    async () => {
      value = await test.request('GET', path, token, undefined, 200);
      const current = text(value, 'status');
      expect(TERMINAL_FAILURES.has(current), JSON.stringify(value)).toBe(false);
      return expected.includes(current);
    },
    STATUS_TIMEOUT_MS,
    STATUS_POLL_MS,
  );
  return value;
}

export async function swapStatus(test: BackendFixture, trader: Trader, id: string, ...expected: string[]) {
  return status(test, `/v1/swaps/${id}`, await test.token(trader.name), ...expected);
}

/** An onboarded external party with access to `pools`, registered with its own wallet key. */
export async function onboard(
  test: BackendFixture,
  name: string,
  pools: readonly string[],
  key: KeyPair = ed25519KeyPair(),
): Promise<Trader> {
  const username = await test.trader(name);
  const token = await test.token(username);
  const id = text(await test.create(token), 'id');
  await test.request(
    'POST',
    `/v1/admin/onboardings/${id}/review`,
    await test.token('operator'),
    { decision: 'APPROVED', approvedPoolIds: pools, partyHint: 'dex_swap_test' },
    200,
  );
  const prepared = await test.request(
    'POST',
    `/v1/onboardings/${id}/party/prepare`,
    token,
    { publicKey: publicKey(key) },
    200,
  );
  await test.request(
    'POST',
    `/v1/onboardings/${id}/party/submit`,
    token,
    signField(key, at(prepared, 'party'), 'multiHash'),
    200,
  );
  return { name: username, key, party: text(await test.completed(token), 'party', 'partyId') };
}

export async function balances(test: BackendFixture, token: string): Promise<unknown> {
  return test.request('GET', '/v1/balances', token, undefined, 200);
}

export function balance(value: unknown, symbol: string, field: string): string {
  const item = items(value, 'balances').find((candidate) => at(candidate, 'symbol') === symbol);
  if (item === undefined) throw new Error(`Balance missing: ${symbol}`);
  return text(item, field);
}

export function plus(left: string, right: string): string {
  return trimmedText(numericUnits(left) + numericUnits(right));
}

export function minus(left: string, right: string): string {
  return trimmedText(numericUnits(left) - numericUnits(right));
}

/** The UTC time `seconds` after now, truncated to whole seconds, with no fraction: `…T10:11:12Z`. */
export function secondsFromNow(seconds: number): string {
  return new Date(Math.floor(Date.now() / 1_000) * 1_000 + seconds * 1_000).toISOString().replace(/\.000Z$/, 'Z');
}

/** Exact decimal equality, whatever the number of fraction digits. */
export function expectAmount(actual: string, expected: string): void {
  expect(compareDecimal(actual, expected), `${actual} equals ${expected}`).toBe(0);
}

/** The development faucet grants the fixed amounts once; a wrong wallet key is refused. */
export async function faucet(test: BackendFixture, trader: Trader): Promise<void> {
  const token = await test.token(trader.name);
  const prepared = await test.request('POST', '/v1/dev/faucet/prepare', token, undefined, 200);
  await test.request('POST', '/v1/dev/faucet/submit', token, sign(ed25519KeyPair(), prepared), 400);
  await test.request('POST', '/v1/dev/faucet/submit', token, sign(trader.key, prepared), 202);
  await status(test, '/v1/dev/faucet', token, 'COMPLETED');
  const available = await balances(test, token);
  expectAmount(balance(available, 'USDC', 'available'), '10000');
  expectAmount(balance(available, 'BTC', 'available'), '0.1');
  expectAmount(balance(available, 'ETH', 'available'), '2');
  await test.request('POST', '/v1/dev/faucet/submit', token, sign(trader.key, prepared), 202);
  expect(at(await balances(test, token), 'balances')).toEqual(at(available, 'balances'));
}
