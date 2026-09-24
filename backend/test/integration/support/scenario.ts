/**
 * The integration scenario that `scripts/test-backend.sh` selects with DEX_SCENARIO. As in the
 * baseline suites, a suite runs for its own names or `all`, and nothing runs unset.
 */
export function scenario(...names: string[]): boolean {
  const selected = process.env.DEX_SCENARIO;
  return selected !== undefined && (selected === 'all' || names.includes(selected));
}
