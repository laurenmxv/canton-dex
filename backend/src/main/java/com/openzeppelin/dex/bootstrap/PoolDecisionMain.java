package com.openzeppelin.dex.bootstrap;

import com.openzeppelin.dex.canton.*;
import com.openzeppelin.dex.pools.PoolModels;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.json.JsonMapper;

/** Local development approver. Uses the existing dvv identity, never the web operator. */
public final class PoolDecisionMain {
  private PoolDecisionMain() {}

  public static void main(String[] args) {
    if (args.length != 2 || !Set.of("accept", "reject").contains(args[0]))
      throw new IllegalArgumentException("Usage: decide-pool.sh accept|reject PROPOSAL_UUID");
    var id = UUID.fromString(args[1]);
    var sql = JdbcClient.create(DevelopmentFixtures.dataSource());
    var row = sql.sql("SELECT * FROM pool_proposals WHERE id=?").param(id).query().singleRow();
    String expected = args[0].equals("accept") ? "CREATED" : "REJECTED";
    if (expected.equals(row.get("status"))) {
      System.out.println("Proposal already " + expected.toLowerCase() + ": " + id);
      return;
    }
    if (!"PENDING".equals(row.get("status")))
      throw new IllegalStateException(
          "Proposal must be confirmed pending; current status: " + row.get("status"));
    var actor = sql.sql("SELECT * FROM fixture_parties WHERE name='dvv'").query().singleRow();
    var identity =
        new LedgerIdentity(
            (String) actor.get("ledger_user_id"),
            (String) actor.get("ledger_client_id"),
            System.getenv().getOrDefault("DEX_DVV_CLIENT_SECRET", "local-fixture-dvv"));
    try (var ledger = DevelopmentFixtures.connection(identity)) {
      String party = ledger.primaryParty();
      if (!party.equals(actor.get("party_id")))
        throw new IllegalStateException("dvv identity mismatch");
      var terms =
          JsonMapper.builder()
              .build()
              .readValue(row.get("settings").toString(), PoolModels.Terms.class);
      String update =
          CantonPoolLedger.decide(
              ledger,
              (String) row.get("proposal_cid"),
              (String) row.get("factory_id"),
              terms,
              id,
              args[0].equals("accept"));
      System.out.println("Confirmed " + args[0] + " for " + id + "; ledger update: " + update);
      System.out.println("The dashboard will refresh automatically.");
    }
  }
}
