import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const { generateArchitectureModel } = require('../scripts/architecture-model.cjs') as {
  generateArchitectureModel(options: { repoRoot: string }): { sourcePaths: string[] };
};

/** Rebuild hover documentation from the explicitly bound local source comments. */
export function architectureContent(): Plugin {
  let serving = false;
  return {
    name: 'architecture-source-documentation',
    configResolved(config) { serving = config.command === 'serve'; },
    buildStart() {
      if (!serving) generateArchitectureModel({ repoRoot });
    },
    configureServer(server) {
      let sources = new Set<string>();
      let hadError = false;
      const regenerate = () => {
        const result = generateArchitectureModel({ repoRoot });
        sources = new Set(result.sourcePaths.map(path => resolve(path)));
        server.watcher.add([...sources]);
      };
      regenerate();
      const changed = (path: string) => {
        if (!sources.has(resolve(path))) return;
        try {
          regenerate();
          // Restoring the previous valid comment may leave generated JSON unchanged.
          // Clear the error overlay even when Vite has no content update to send.
          if (hadError) server.ws.send({ type: 'full-reload' });
          hadError = false;
        }
        catch (error) {
          hadError = true;
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(message);
          server.ws.send({ type: 'error', err: { message, stack: '' } });
        }
      };
      for (const event of ['change', 'add', 'unlink'] as const) server.watcher.on(event, changed);
      server.httpServer?.once('close', () => {
        for (const event of ['change', 'add', 'unlink'] as const) server.watcher.off(event, changed);
      });
    },
  };
}
