// Validate architecture entities and generate source-documented viewer content.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { enrichArchitectureModel } = require('./architecture-docs.cjs');

function generateArchitectureModel({
  repoRoot = path.resolve(__dirname, '../..'),
  outputPath = path.join(repoRoot, 'frontend/src/features/docs/architecture/model.generated.json'),
  verify,
} = {}) {
  const modelPath = path.join(repoRoot, 'docs/architecture-map/model.cjs');
  delete require.cache[require.resolve(modelPath)];
  const authoredModel = require(modelPath);
  const model = {
    ...enrichArchitectureModel(authoredModel, { repoRoot }),
    sourceRoot: 'https://github.com/OpenZeppelin/canton-dex/blob/c36dd63249cd36e6665e6fd41bb2f43800a37c4f/',
  };
  const validate = verify || require(path.join(repoRoot, 'docs/architecture-map/verify.cjs')).verifyArchitectureModel;
  if (typeof validate !== 'function') throw new Error('Architecture model validator must export verifyArchitectureModel(model, root).');
  validate(model, repoRoot);
  const serialized = `${JSON.stringify(model, null, 2)}\n`;
  const previous = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : undefined;
  if (previous !== serialized) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized);
  }
  return {
    model,
    outputPath,
    sourcePaths: [modelPath, ...new Set(Object.values(authoredModel.documentationSources || {})
      .map(binding => path.resolve(repoRoot, binding.path)))],
  };
}

if (require.main === module) {
  generateArchitectureModel();
  console.log('Generated architecture viewer content from source documentation.');
}

module.exports = { generateArchitectureModel };
