package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;

import java.util.*;

public interface SettlementLedger {
  Snapshot snapshot(String poolId);

  /**
   * Sequential preflight. Return outputs in request order; fail with Blocked for a known bad
   * request.
   */
  List<Fill> preflight(Snapshot snapshot, List<QueueRequest> requests);

  /** The same preflight, retaining each valid state and stopping at the first blocked request. */
  List<PreviewStep> preview(Snapshot snapshot, List<QueueRequest> requests);

  Confirmation submit(Pending pending);

  Optional<Confirmation> recover(Pending pending);

  /** Ledger evidence or a durable preparation failure proves this command cannot commit. */
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
    private final RequestRef request;
    private final String code;

    public Blocked(RequestRef request, String code, String message) {
      super(message);
      this.request = request;
      this.code = code;
    }

    public RequestRef request() {
      return request;
    }

    public String code() {
      return code;
    }
  }
}
