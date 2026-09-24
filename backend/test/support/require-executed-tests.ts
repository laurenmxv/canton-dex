import type { Reporter, TestModule } from 'vitest/node';

/** Fails a run in which no test executed, as the baseline integration task did. */
export default class RequireExecutedTests implements Reporter {
  onTestRunEnd(testModules: readonly TestModule[]): void {
    const executed = testModules.some((module) =>
      [...module.children.allTests()].some((test) => test.result().state !== 'skipped'),
    );
    if (!executed) {
      console.error('No test executed');
      process.exitCode = 1;
    }
  }
}
