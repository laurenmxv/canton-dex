package com.openzeppelin.dex.canton;

import com.openzeppelin.dex.canton.generated.pool.Pool;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.stereotype.Component;

@Component("canton")
public final class CantonHealthIndicator implements HealthIndicator {
  private final LedgerConnection ledger;

  public CantonHealthIndicator(LedgerConnection ledger) {
    this.ledger = ledger;
  }

  @Override
  public Health health() {
    try {
      ledger.ledgerEnd();
      if (!ledger.connected())
        return Health.down().withDetail("reason", "No connected synchronizer").build();
      if (!ledger.hasPackage(Pool.PACKAGE_ID))
        return Health.down().withDetail("reason", "Application package is missing").build();
      return Health.up().build();
    } catch (RuntimeException e) {
      return Health.down(e).build();
    }
  }
}
