package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;

import com.openzeppelin.dex.swaps.SwapModels.Swap;
import java.util.*;

public interface SettlementLedger {
  Snapshot snapshot(String poolId);

  /**
   * Sequential preflight. Return outputs in request order; fail with Blocked for a known bad
   * request.
   */
  List<Fill> preflight(Snapshot snapshot, List<Swap> swaps);

  Confirmation submit(Pending pending);

  Optional<Confirmation> recover(Pending pending);

  /**
   * Positive ledger evidence proves the immutable command cannot have committed or commit later.
   */
  final class Excluded extends RuntimeException {
    private final String code;

    public Excluded(String code, String message) {
      super(message);
      this.code = code;
    }

    public String code() {
      return code;
    }
  }

  final class Blocked extends RuntimeException {
    private final UUID swapId;
    private final String code;

    public Blocked(UUID swapId, String code, String message) {
      super(message);
      this.swapId = swapId;
      this.code = code;
    }

    public UUID swapId() {
      return swapId;
    }

    public String code() {
      return code;
    }
  }
}
