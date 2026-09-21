import { Note } from './Note';

/**
 * Says that the identifiers on this screen came from the demo. It is the one
 * place that wording lives, so it cannot drift between screens.
 */
export function SimulatedLedgerNotice() {
  return <Note tone="demo">Simulated ledger</Note>;
}
