#!/usr/bin/env node
// Replays the framework cases against a running backend and compares every answer with
// golden/framework.json, the baseline's recorded behavior.
//
//   DEX_BOOTSTRAP_KEYCLOAK_USERNAME=... DEX_BOOTSTRAP_KEYCLOAK_PASSWORD=... \
//   node backend/test/compatibility/check.mjs --api URL --keycloak URL --issuer URL [--partial]
//
// The default is strict: every status, header and body is compared, which needs the fresh
// bootstrap state the golden set was captured from. `--partial` compares state-dependent
// bodies by JSON kind only, and the report then says `"mode": "partial"` and names each body
// it did not compare. A partial result is never evidence of full compatibility.
// Exit 0 means everything compared matched; exit 1 lists each difference.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { apiHeaders } from './exchange.mjs';
import { runFrameworkCases } from './framework-cases.mjs';
import { endpoints } from './http.mjs';
import { differences } from './normalize.mjs';

const { values } = parseArgs({
  options: { api: { type: 'string' }, keycloak: { type: 'string' }, issuer: { type: 'string' }, partial: { type: 'boolean', default: false } },
});
if (!values.api || !values.keycloak || !values.issuer) {
  console.error('Usage: check.mjs --api URL --keycloak URL --issuer URL [--partial]');
  process.exit(2);
}
const credentials = { username: process.env.DEX_BOOTSTRAP_KEYCLOAK_USERNAME, password: process.env.DEX_BOOTSTRAP_KEYCLOAK_PASSWORD };
if (!credentials.username || !credentials.password) {
  console.error('Set DEX_BOOTSTRAP_KEYCLOAK_USERNAME and DEX_BOOTSTRAP_KEYCLOAK_PASSWORD.');
  process.exit(2);
}

const golden = goldenByName(JSON.parse(readFileSync(new URL('./golden/framework.json', import.meta.url))).exchanges);
const results = await runFrameworkCases(endpoints(values), credentials, { issuer: values.issuer });
const bindings = new Map();
const mismatches = [];
const bodiesNotCompared = [];
for (const result of results) {
  const expected = golden.get(result.name);
  if (!expected) {
    mismatches.push({ name: result.name, problems: ['no golden exchange'] });
    continue;
  }
  const problems = [];
  if (result.response.status !== expected.response.status) problems.push(`status: expected ${expected.response.status}, got ${result.response.status}`);
  problems.push(...differences(apiHeaders(result.response.headers), expected.response.headers, bindings, 'headers'));
  problems.push(...bodyDifferences(result, expected.response.body));
  if (problems.length > 0) mismatches.push({ name: result.name, problems });
}
const replayed = new Set(results.map((result) => result.name));
for (const name of golden.keys()) {
  if (!replayed.has(name)) mismatches.push({ name, problems: ['golden exchange has no case'] });
}
if (values.partial) console.error(`PARTIAL: ${bodiesNotCompared.length} state-dependent bodies were not compared.`);
console.log(JSON.stringify({
  mode: values.partial ? 'partial' : 'strict',
  cases: results.length,
  golden: golden.size,
  matched: results.length - mismatches.filter((mismatch) => replayed.has(mismatch.name)).length,
  bodiesNotCompared,
  mismatches,
}, null, 2));
process.exit(mismatches.length === 0 ? 0 : 1);

function goldenByName(exchanges) {
  const byName = new Map();
  for (const exchange of exchanges) {
    if (byName.has(exchange.name)) {
      console.error(`golden/framework.json has two exchanges named ${exchange.name}`);
      process.exit(2);
    }
    byName.set(exchange.name, exchange);
  }
  return byName;
}

function bodyDifferences(result, expected) {
  const text = result.response.text;
  if ('empty' in expected) return text === '' ? [] : ['body: expected no body'];
  if ('omitted' in expected) return ['body: the golden body was omitted, so it cannot be compared'];
  if ('text' in expected) return differences(text, expected.text, bindings, 'body');
  if (result.response.json === undefined) return ['body: expected JSON'];
  if (result.state && values.partial) {
    bodiesNotCompared.push(result.name);
    return Array.isArray(result.response.json) === Array.isArray(expected.json) ? [] : ['body: JSON kind changed'];
  }
  return differences(result.response.json, expected.json, bindings, 'body');
}
