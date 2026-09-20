package com.openzeppelin.dex.pools;

import static com.openzeppelin.dex.pools.PoolModels.*;

import java.util.*;

public interface PoolLedger {
  final class Rejected extends RuntimeException {
    public Rejected(Throwable cause) {
      super("Canton rejected the command", cause);
    }
  }

  record Confirmation(String proposalCid, Status status, String updateId, Detail pool) {}

  String operator();

  String packageId();

  long offset();

  String factory(String dvo);

  Confirmation propose(Proposal proposal, UUID command);

  Confirmation withdraw(Proposal proposal, UUID command);

  List<Confirmation> recover(Pending pending);

  List<Detail> pools(Map<String, String> names, String dvo);
}
