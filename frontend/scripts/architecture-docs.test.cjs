'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { extractArchitectureDocs, enrichArchitectureModel } = require('./architecture-docs.cjs');
const { generateArchitectureModel } = require('./architecture-model.cjs');

function fixture(t, source, filename = 'module.ts') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-docs-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const sourcePath = path.join(repoRoot, filename);
  fs.writeFileSync(sourcePath, source);
  const binding = { path: filename };
  return {
    repoRoot, sourcePath, binding,
    extract: (override = {}) => extractArchitectureDocs({
      repoRoot,
      documentationSources: { 'backend.module': { ...binding, ...override } },
    })['backend.module'],
  };
}

test('module summary, public remarks and exact source anchor come from parsed TSDoc', t => {
  const f = fixture(t, `// License header.\n\n/**
 * Coordinates durable settlement
 * batches and their outcomes.
 *
 * This second summary paragraph is not a node title.
 * @packageDocumentation
 * @remarks
 * Reads ready requests from module-owned records.
 *
 * The worker records confirmed ledger results.
 * @privateRemarks
 * Internal-only review material must never be published.
 */
import { missing } from './not-installed';
throw new Error('Documentation extraction must never execute source');
`);
  assert.deepEqual(f.extract(), {
    purpose: 'Coordinates durable settlement batches and their outcomes.',
    note: 'Reads ready requests from module-owned records.\n\nThe worker records confirmed ledger results.',
    source: 'module.ts:3',
    documentation: { format: 'TSDoc', path: 'module.ts', line: 3 },
  });
  assert.doesNotMatch(JSON.stringify(f.extract()), /Internal-only|second summary|not-installed/);
});

test('privateRemarks never becomes public notes when there is no remarks section', t => {
  const f = fixture(t, `/** Public responsibility.
 * @packageDocumentation
 * @privateRemarks Secret implementation commentary.
 */
export {};
`);
  assert.equal(f.extract().purpose, 'Public responsibility.');
  assert.equal(f.extract().note, undefined);
  assert.doesNotMatch(JSON.stringify(f.extract()), /Secret implementation/);
});

test('TSX module documentation is parsed without importing React or running JSX', t => {
  const f = fixture(t, `/** Renders the trader workspace.
 * @packageDocumentation
 * @remarks Shows request outcomes.
 */
export const Workspace = () => <main><span>Trade</span></main>;
`, 'workspace.tsx');
  assert.equal(f.extract().purpose, 'Renders the trader workspace.');
  assert.equal(f.extract().note, 'Shows request outcomes.');
});

test('source changes are re-read for every extraction', t => {
  const f = fixture(t, '/** First responsibility. @packageDocumentation */\nexport {};');
  assert.equal(f.extract().purpose, 'First responsibility.');
  fs.writeFileSync(f.sourcePath, '\n\n/** Updated responsibility. @packageDocumentation */\nexport {};');
  assert.equal(f.extract().purpose, 'Updated responsibility.');
  assert.equal(f.extract().documentation.line, 3);
});

test('explicit symbol bindings select their own documentation, excluding module docs', t => {
  const f = fixture(t, `/** Module overview. @packageDocumentation */
/** Sends typed requests.
 * @remarks Does not retry or sign.
 * @param url Destination.
 * @returns A response.
 */
export function send(url: string): string { return url; }
/** Represents a request. */
export interface Request { id: string }
/** Opens the client. */
export const createClient = () => ({});
`);
  assert.equal(f.extract().purpose, 'Module overview.');
  assert.deepEqual(f.extract({ symbol: 'send' }), {
    purpose: 'Sends typed requests.', note: 'Does not retry or sign.', source: 'module.ts:2',
    documentation: { format: 'TSDoc', path: 'module.ts', line: 2 },
  });
  assert.equal(f.extract({ symbol: 'Request' }).purpose, 'Represents a request.');
  assert.equal(f.extract({ symbol: 'createClient' }).purpose, 'Opens the client.');
});

test('ordinary comments and comment-shaped strings do not become module documentation', t => {
  const f = fixture(t, `// @packageDocumentation Not TSDoc.
const sample = '/** Fake summary. @packageDocumentation */';
/** Function documentation. */
function work() { return sample; }
`);
  assert.throws(() => f.extract(), /missing @packageDocumentation block/);
});

test('missing, empty and duplicate documentation fail rather than reuse unrelated prose', async t => {
  const cases = [
    ['missing block', 'export {};', /missing @packageDocumentation block/],
    ['empty summary', '/** @packageDocumentation\n * @remarks Notes only. */\nexport {};', /summary is empty/],
    ['empty remarks', '/** Public summary.\n * @packageDocumentation\n * @remarks */\nexport {};', /@remarks is empty/],
    ['two attached package blocks', '/** One. @packageDocumentation */\n/** Two. @packageDocumentation */\nexport {};', /multiple @packageDocumentation blocks/],
    ['two separate package blocks', '/** One. @packageDocumentation */\nexport const a=1;\n/** Two. @packageDocumentation */\nexport const b=2;', /multiple @packageDocumentation blocks/],
    ['duplicate remarks tags', '/** Public.\n * @packageDocumentation\n * @remarks First.\n * @remarks Second. */\nexport {};', /multiple @remarks tags/],
    ['duplicate package tags', '/** Public.\n * @packageDocumentation\n * @packageDocumentation */\nexport {};', /multiple @packageDocumentation tags/],
    ['nonstandard summary tag', '/** @summary Public.\n * @packageDocumentation */\nexport {};', /@summary is not supported/],
  ];
  for (const [name, source, error] of cases) {
    await t.test(name, child => {
      const f = fixture(child, source);
      assert.throws(() => f.extract(), error);
    });
  }
});

test('ambiguous or missing symbol documentation is rejected', async t => {
  const cases = [
    ['missing declaration', '/** Package. @packageDocumentation */\nexport {};', 'missing', /no top-level declaration named missing/],
    ['undocumented declaration', 'export const value = 1;', 'value', /missing TSDoc block for value/],
    ['package block is not symbol documentation', '/** Module. @packageDocumentation */\nexport const value = 1;', 'value', /missing TSDoc block for value/],
    ['multiple symbol blocks', '/** One. */\n/** Two. */\nexport const value = 1;', 'value', /multiple TSDoc blocks for value/],
    ['overloaded declarations', '/** One. */\nexport function value(x: string): string;\n/** Two. */\nexport function value(x: string) { return x; }', 'value', /multiple declarations named value/],
  ];
  for (const [name, source, symbol, error] of cases) {
    await t.test(name, child => {
      const f = fixture(child, source);
      assert.throws(() => f.extract({ symbol }), error);
    });
  }
});

test('unsupported sources and bindings fail explicitly', t => {
  const f = fixture(t, '/** Public. @packageDocumentation */\nexport {};');
  assert.throws(() => f.extract({ path: 'module.js' }), /only .ts and .tsx/);
  assert.throws(() => f.extract({ path: 'missing.ts' }), /does not exist/);
  assert.throws(() => f.extract({ path: '../module.ts' }), /stay inside the repository/);
  assert.throws(() => f.extract({ symbol: 'Namespace.member' }), /not a member path/);
  assert.throws(() => f.extract({ name: 'guess' }), /unsupported binding field name/);
});

test('enrichment uses source prose without mutating the authored graph', t => {
  const f = fixture(t, '/** Public responsibility. @packageDocumentation */\nexport {};');
  const original = {
    nodes: { 'backend.module': { id: 'backend.module', title: 'Module', source: 'module.ts:2' } },
    documentationSources: { 'backend.module': f.binding },
    edges: [['relationship']],
  };
  const enriched = enrichArchitectureModel(original, { repoRoot: f.repoRoot });
  assert.equal(enriched.nodes['backend.module'].purpose, 'Public responsibility.');
  assert.equal(enriched.nodes['backend.module'].source, 'module.ts:1');
  assert.equal(original.nodes['backend.module'].purpose, undefined);
  assert.equal(original.nodes['backend.module'].source, 'module.ts:2');
  assert.equal(enriched.edges, original.edges);
});

test('duplicate authored prose and unknown graph bindings are rejected', t => {
  const f = fixture(t, '/** Public responsibility. @packageDocumentation */\nexport {};');
  const model = { nodes: {}, documentationSources: { 'backend.module': f.binding } };
  assert.throws(() => enrichArchitectureModel(model, { repoRoot: f.repoRoot }), /unknown node backend.module/);
  model.nodes['backend.module'] = { purpose: 'A second copy.' };
  assert.throws(() => enrichArchitectureModel(model, { repoRoot: f.repoRoot }), /duplicates source documentation/);
  model.nodes['backend.module'] = { note: 'A second copy.' };
  assert.throws(() => enrichArchitectureModel(model, { repoRoot: f.repoRoot }), /duplicates source documentation/);
});

test('generator validates enriched content and reloads changed model and source files', t => {
  const f = fixture(t, '/** First responsibility. @packageDocumentation */\nexport {};');
  const modelDir = path.join(f.repoRoot, 'docs/architecture-map');
  fs.mkdirSync(modelDir, { recursive: true });
  const modelPath = path.join(modelDir, 'model.cjs');
  const model = {
    nodes: { 'backend.module': { id: 'backend.module', title: 'First title' } },
    documentationSources: { 'backend.module': f.binding },
  };
  const saveModel = () => fs.writeFileSync(modelPath, `module.exports = ${JSON.stringify(model)};\n`);
  saveModel();
  const verified = [];
  const verify = (enriched, root) => {
    assert.equal(root, f.repoRoot);
    verified.push(enriched.nodes['backend.module'].purpose);
  };
  const first = generateArchitectureModel({ repoRoot: f.repoRoot, verify });
  assert.deepEqual(first.sourcePaths, [modelPath, f.sourcePath]);
  assert.equal(JSON.parse(fs.readFileSync(first.outputPath, 'utf8')).nodes['backend.module'].purpose, 'First responsibility.');
  model.nodes['backend.module'].title = 'Updated title';
  saveModel();
  fs.writeFileSync(f.sourcePath, '/** Updated responsibility. @packageDocumentation */\nexport {};');
  const second = generateArchitectureModel({ repoRoot: f.repoRoot, verify });
  assert.equal(second.model.nodes['backend.module'].title, 'Updated title');
  assert.deepEqual(verified, ['First responsibility.', 'Updated responsibility.']);
  fs.writeFileSync(f.sourcePath, '/** Unvalidated change. @packageDocumentation */\nexport {};');
  assert.throws(() => generateArchitectureModel({ repoRoot: f.repoRoot, verify: () => { throw new Error('Invalid graph'); } }), /Invalid graph/);
  assert.equal(JSON.parse(fs.readFileSync(first.outputPath, 'utf8')).nodes['backend.module'].purpose, 'Updated responsibility.');
});
