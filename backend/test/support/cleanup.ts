/** Runs every cleanup even when one fails, then reports all failures together. */
export async function independently(heading: string, ...tasks: (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, heading);
}
