import { Callout } from './Badge';

/**
 * Says that the identifiers on this screen came from the demo. It is the one
 * place that wording lives, so it cannot drift between screens.
 */
export function SimulatedLedgerNotice() {
  return (
    <Callout tone="demo" title="Simulated ledger">
      Simulated data; no Canton transactions.
    </Callout>
  );
}
