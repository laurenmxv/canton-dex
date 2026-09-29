/* Architecture structure integrity checks; run with a repository root argument. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
function verifyArchitectureModel(atlas,root) {
const {nodes,choices,layers,documentationSources}=atlas;
const fileCache=new Map();
const read=file=>{if(!fileCache.has(file))fileCache.set(file,fs.readFileSync(path.join(root,file),'utf8'));return fileCache.get(file);};
const sourceCheck=source=>{const [file,line]=source.split(':');assert.ok(read(file).split('\n').length>=Number(line),`Bad source line: ${source}`);};
assert.equal(Object.keys(layers).length,5);
assert.equal(Object.keys(choices).length,17);
assert.equal(layers.contracts.nodes.length,10);
for(const n of Object.values(nodes))sourceCheck(n.source);
for(const c of Object.values(choices)) {
  sourceCheck(c.source);
  const [file,line]=c.source.split(':');
  const code=read(file);
  assert.match(code.split('\n')[Number(line)-1],new RegExp(`choice ${c.id}\\b`),`Choice anchor changed: ${c.id}`);
  const prefix=code.split('\n').slice(0,Number(line)).join('\n');
  const declarations=[...prefix.matchAll(/^template\s+(\w+)/gm)];
  assert.equal(declarations.at(-1)[1],nodes[c.owner].exact,`Wrong template owner: ${c.id}`);
  assert.ok(nodes[c.owner].choices.includes(c.id),`Choice not listed by its template: ${c.id}`);
}
// Every layer lists known nodes, and each node belongs to at most one layer.
const owners=new Map();
for(const [layerId,layer] of Object.entries(layers)) {
  for(const id of [...layer.nodes,...layer.context])assert.ok(nodes[id],`Unknown node in layer ${layerId}: ${id}`);
  for(const id of layer.nodes) {
    assert.ok(!owners.has(id),`Node in two layers: ${id} (${owners.get(id)}, ${layerId})`);
    owners.set(id,layerId);
    assert.equal(nodes[id].layer,layerId,`Layer prefix differs from its layer: ${id}`);
  }
}
for(const id of Object.keys(documentationSources))assert.ok(nodes[id],`Documentation bound to an unknown node: ${id}`);
const templates=Object.values(nodes).filter(n=>n.exact).length;
console.log(`PASS: ${Object.keys(layers).length} layers, ${Object.keys(nodes).length} nodes, ${templates} templates, ${Object.keys(choices).length} exact choice anchors/owners, ${fileCache.size} source files.`);
console.log('Browser rendering, keyboard navigation and human readability require separate visual review.');
}
if(require.main===module) {
  const root=path.resolve(process.argv[2]||path.join(__dirname,'../..'));
  const {enrichArchitectureModel}=require('../../frontend/scripts/architecture-docs.cjs');
  verifyArchitectureModel(enrichArchitectureModel(require('./model.cjs'),{repoRoot:root}),root);
}
module.exports={verifyArchitectureModel};
