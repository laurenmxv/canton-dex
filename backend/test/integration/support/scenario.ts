/**
 * The integration scenario that `scripts/test-backend.sh` selects with DEX_SCENARIO. A suite runs
 * for its own names or `all`, and nothing runs when DEX_SCENARIO is unset.
 */
export function scenario(...names: string[]): boolean {
  const selected = process.env.DEX_SCENARIO;
  return selected !== undefined && (selected === 'all' || names.includes(selected));
}
