import type { FastifyBaseLogger } from 'fastify';

export interface Worker {
  /** Stops scheduling and waits for the pass in progress. */
  stop(): Promise<void>;
}

/**
 * A periodic task with a fixed delay: the first pass starts at once, and each next pass
 * starts `delayMs` after the previous one ends, so passes never overlap. A failed pass is logged
 * and the loop continues.
 */
export function startWorker(
  name: string,
  delayMs: number,
  task: () => Promise<void>,
  log: Pick<FastifyBaseLogger, 'error'>,
): Worker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  function run(): void {
    running = task()
      .catch((error: unknown) => {
        log.error({ err: error, worker: name }, 'Worker pass failed');
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(run, delayMs);
      });
  }

  run();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
