// Build-time documentation extraction. TypeScript files are parsed, never imported.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function fail(nodeId, binding, message) {
  const location = binding && typeof binding.path === 'string' ? binding.path : 'invalid binding';
  throw new Error(`Architecture documentation ${nodeId} (${location}): ${message}`);
}

function sourcePath(repoRoot, nodeId, binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || typeof binding.path !== 'string' || !binding.path.trim()) {
    fail(nodeId, binding, 'expected { path, symbol? }.');
  }
  for (const key of Object.keys(binding)) {
    if (!['path', 'symbol'].includes(key)) fail(nodeId, binding, `unsupported binding field ${key}.`);
  }
  if (binding.symbol !== undefined
    && (typeof binding.symbol !== 'string' || !binding.symbol.trim() || binding.symbol.includes('.'))) {
    fail(nodeId, binding, 'symbol must name one top-level declaration, not a member path.');
  }
  if (!['.ts', '.tsx'].includes(path.extname(binding.path))) {
    fail(nodeId, binding, 'only .ts and .tsx documentation sources are supported.');
  }
  if (path.isAbsolute(binding.path) || binding.path.includes('\\')
    || binding.path.split('/').includes('..')) {
    fail(nodeId, binding, 'path must stay inside the repository and use forward slashes.');
  }
  const absolutePath = path.resolve(repoRoot, binding.path);
  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
    if (!fs.statSync(realPath).isFile()) fail(nodeId, binding, 'source is not a file.');
  } catch (error) {
    if (error.code === 'ENOENT') fail(nodeId, binding, 'source file does not exist.');
    throw error;
  }
  const relative = path.relative(repoRoot, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(nodeId, binding, 'source resolves outside the repository.');
  }
  return absolutePath;
}

// getChildren includes every attached JSDoc block. getJSDocCommentsAndTags can
// return only the last block, hiding duplicate package or symbol documentation.
function attachedDocs(node, source) {
  return node.getChildren(source).filter(ts.isJSDoc);
}

function tagsNamed(doc, name) {
  return (doc.tags || []).filter(tag => tag.tagName.text === name);
}

function isPackageDoc(doc) {
  return tagsNamed(doc, 'packageDocumentation').length > 0;
}

function findDocumentation(source, nodeId, binding) {
  let docs;
  if (binding.symbol === undefined) {
    docs = [...source.statements, source.endOfFileToken]
      .flatMap(statement => attachedDocs(statement, source))
      .filter(isPackageDoc);
  } else {
    const declarations = [];
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === binding.symbol) {
            const ownDocs = attachedDocs(declaration, source);
            declarations.push(ownDocs.length ? ownDocs : attachedDocs(statement, source));
          }
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
        || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        || ts.isEnumDeclaration(statement)) && statement.name?.text === binding.symbol) {
        declarations.push(attachedDocs(statement, source));
      }
    }
    if (declarations.length !== 1) {
      fail(nodeId, binding, declarations.length
        ? `multiple declarations named ${binding.symbol}; bind an unambiguous documented symbol.`
        : `no top-level declaration named ${binding.symbol}.`);
    }
    docs = declarations[0].filter(doc => !isPackageDoc(doc));
  }
  if (docs.length !== 1) {
    const kind = binding.symbol === undefined ? '@packageDocumentation' : 'TSDoc';
    const target = binding.symbol === undefined ? '' : ` for ${binding.symbol}`;
    fail(nodeId, binding, `${docs.length ? 'multiple' : 'missing'} ${kind} block${docs.length > 1 ? 's' : ''}${target}.`);
  }
  return docs[0];
}

function textOf(comment) {
  return (ts.getTextOfJSDocComment(comment) || '').replace(/\r\n?/g, '\n').trim();
}

function paragraphs(text) {
  return text.split(/\n\s*\n/).map(paragraph => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function extractDocumentation(source, nodeId, binding) {
  const doc = findDocumentation(source, nodeId, binding);
  for (const tag of ['packageDocumentation', 'remarks', 'privateRemarks']) {
    if (tagsNamed(doc, tag).length > 1) fail(nodeId, binding, `multiple @${tag} tags.`);
  }
  if (tagsNamed(doc, 'summary').length) {
    fail(nodeId, binding, 'use a summary paragraph before @remarks; @summary is not supported.');
  }
  const purpose = paragraphs(textOf(doc.comment))[0];
  if (!purpose) fail(nodeId, binding, 'the documentation summary is empty.');
  const remarks = tagsNamed(doc, 'remarks')[0];
  const note = remarks ? paragraphs(textOf(remarks.comment)).join('\n\n') : undefined;
  if (remarks && !note) fail(nodeId, binding, '@remarks is empty.');
  const line = source.getLineAndCharacterOfPosition(doc.getStart(source)).line + 1;
  return {
    purpose,
    ...(note ? { note } : {}),
    source: `${binding.path}:${line}`,
    documentation: { format: 'TSDoc', path: binding.path, line },
  };
}

/** Resolve explicit node bindings to public TSDoc text from local TS/TSX files. */
function extractArchitectureDocs({ repoRoot, documentationSources }) {
  if (!documentationSources || typeof documentationSources !== 'object' || Array.isArray(documentationSources)) {
    throw new Error('Architecture documentationSources must be an object of explicit node bindings.');
  }
  const root = fs.realpathSync(repoRoot);
  const sources = new Map();
  const extracted = {};
  for (const [nodeId, binding] of Object.entries(documentationSources)) {
    const absolutePath = sourcePath(root, nodeId, binding);
    if (!sources.has(absolutePath)) {
      const source = fs.readFileSync(absolutePath, 'utf8');
      sources.set(absolutePath, ts.createSourceFile(
        absolutePath, source, ts.ScriptTarget.Latest, true,
        path.extname(absolutePath) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ));
    }
    extracted[nodeId] = extractDocumentation(sources.get(absolutePath), nodeId, binding);
  }
  return extracted;
}

/** Enrich a fresh model without retaining a second, authored copy of source prose. */
function enrichArchitectureModel(model, { repoRoot }) {
  const documentationSources = model.documentationSources || {};
  const extracted = extractArchitectureDocs({ repoRoot, documentationSources });
  const nodes = { ...model.nodes };
  for (const [nodeId, documentation] of Object.entries(extracted)) {
    const node = nodes[nodeId];
    if (!node) throw new Error(`Architecture documentation binding refers to unknown node ${nodeId}.`);
    if (node.purpose || node.note) {
      throw new Error(`Architecture node ${nodeId} duplicates source documentation; remove its authored purpose and note.`);
    }
    const { purpose: _purpose, note: _note, ...metadata } = node;
    nodes[nodeId] = { ...metadata, ...documentation };
  }
  return { ...model, nodes };
}

module.exports = { extractArchitectureDocs, enrichArchitectureModel };
