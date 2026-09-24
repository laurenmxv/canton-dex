import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DECISION_TIMEOUT_MS = 120_000;

/**
 * Runs the DVO decision command with the arguments of `scripts/decide-pool.sh`, in this
 * environment. A non-zero exit fails the calling test with the command's output.
 */
export async function decidePool(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', 'src/cli/decide-pool.ts', ...args], {
    env: process.env,
    timeout: DECISION_TIMEOUT_MS,
  });
  return stdout;
}
