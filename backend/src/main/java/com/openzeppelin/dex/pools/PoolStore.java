package com.openzeppelin.dex.pools;

import static com.openzeppelin.dex.pools.PoolModels.*;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.*;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

@Repository
public class PoolStore {
  private final JdbcClient sql;
  private final ObjectMapper json;
  private final TransactionTemplate tx;

  public PoolStore(
      JdbcClient sql,
      ObjectMapper json,
      org.springframework.transaction.PlatformTransactionManager manager) {
    this.sql = sql;
    this.json = json;
    this.tx = new TransactionTemplate(manager);
  }

  public String dvo() {
    return sql.sql("SELECT party_id FROM fixture_parties WHERE name='dvo'")
        .query(String.class)
        .single();
  }

  public Proposal get(UUID id) {
    return sql.sql(
            "SELECT p.*,a.display_name FROM pool_proposals p JOIN accounts a ON a.id=p.proposed_by"
                + " WHERE p.id=?")
        .param(id)
        .query(this::proposal)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public List<Proposal> proposals() {
    return sql.sql(
            "SELECT p.*,a.display_name FROM pool_proposals p JOIN accounts a ON a.id=p.proposed_by"
                + " ORDER BY created_at DESC,id")
        .query(this::proposal)
        .list();
  }

  public List<Pending> pending() {
    return sql.sql(
            "SELECT p.*,a.display_name FROM pool_proposals p JOIN accounts a ON a.id=p.proposed_by"
                + " WHERE status IN ('SUBMITTING','PENDING','UNRESOLVED') ORDER BY created_at")
        .query(
            (r, n) ->
                new Pending(
                    proposal(r, n),
                    r.getObject("command_id", UUID.class),
                    r.getLong("begin_offset")))
        .list();
  }

  public Proposal reserve(
      UUID id, Create input, Terms terms, String factoryId, UUID account, long offset) {
    try {
      return tx.execute(
          s -> {
            sql.sql(
                    "INSERT INTO"
                        + " pool_proposals(id,name,settings,factory_id,proposed_by,status,command_id,begin_offset)"
                        + " VALUES(?,?,?::jsonb,?,?,'SUBMITTING',?,?)")
                .params(
                    id,
                    input.name(),
                    json.writeValueAsString(terms),
                    factoryId,
                    account,
                    id,
                    offset)
                .update();
            sql.sql("INSERT INTO pool_pair_claims(pair_key,proposal_id) VALUES(?,?)")
                .params(terms.pairKey(), id)
                .update();
            return get(id);
          });
    } catch (DuplicateKeyException e) {
      throw new PoolConflict("A pool or pending proposal already exists for this pair");
    }
  }

  public void proposed(UUID id, String cid, String updateId) {
    sql.sql(
            "UPDATE pool_proposals SET"
                + " proposal_cid=?,update_id=?,status='PENDING',error=NULL,updated_at=now() WHERE"
                + " id=? AND proposal_cid IS NULL AND status IN ('SUBMITTING','UNRESOLVED')")
        .params(cid, updateId, id)
        .update();
  }

  public void unresolved(UUID id) {
    sql.sql(
            "UPDATE pool_proposals SET status='UNRESOLVED',error='Confirmation"
                + " pending',updated_at=now() WHERE id=? AND status='SUBMITTING'")
        .param(id)
        .update();
  }

  public void failedSubmission(UUID id, boolean withdrawal) {
    tx.executeWithoutResult(
        s -> {
          int changed =
              sql.sql(
                      "UPDATE pool_proposals SET status=?,error=?,updated_at=now() WHERE id=? AND"
                          + " status='SUBMITTING'")
                  .params(
                      withdrawal ? "PENDING" : "FAILED",
                      withdrawal
                          ? "Withdrawal was rejected. Try again."
                          : "Canton rejected the proposal. Create a new proposal.",
                      id)
                  .update();
          if (changed == 1 && !withdrawal)
            sql.sql("DELETE FROM pool_pair_claims WHERE proposal_id=?").param(id).update();
        });
  }

  public void reconciliationError(UUID id, boolean failed) {
    String message = "Status could not be refreshed. Retrying.";
    if (failed)
      sql.sql(
              "UPDATE pool_proposals SET error=? WHERE id=? AND status IN"
                  + " ('SUBMITTING','PENDING','UNRESOLVED') AND error IS DISTINCT FROM ?")
          .params(message, id, message)
          .update();
    else
      sql.sql("UPDATE pool_proposals SET error=NULL WHERE id=? AND error=?")
          .params(id, message)
          .update();
  }

  public void finish(UUID id, Status status, String updateId, Detail pool) {
    tx.executeWithoutResult(
        s -> {
          String current =
              sql.sql("SELECT status FROM pool_proposals WHERE id=? FOR UPDATE")
                  .param(id)
                  .query(String.class)
                  .single();
          if (Set.of("CREATED", "REJECTED", "WITHDRAWN", "FAILED").contains(current)) return;
          if (pool != null) {
            save(pool);
            sql.sql("UPDATE pools SET name=?,created_at=COALESCE(created_at,?) WHERE pool_id=?")
                .params(pool.name(), java.sql.Timestamp.from(pool.createdAt()), pool.poolId())
                .update();
          }
          sql.sql(
                  "UPDATE pool_proposals SET"
                      + " status=?,pool_id=?,update_id=?,error=NULL,updated_at=now() WHERE id=?")
              .params(status.name(), pool == null ? null : pool.poolId(), updateId, id)
              .update();
          if (pool == null)
            sql.sql("DELETE FROM pool_pair_claims WHERE proposal_id=?").param(id).update();
          else
            sql.sql("UPDATE pool_pair_claims SET pool_id=? WHERE proposal_id=?")
                .params(pool.poolId(), id)
                .update();
        });
  }

  public boolean claimWithdrawal(UUID id, UUID command) {
    return sql.sql(
                "UPDATE pool_proposals SET"
                    + " status='SUBMITTING',command_id=?,error=NULL,updated_at=now() WHERE id=? AND"
                    + " status='PENDING'")
            .params(command, id)
            .update()
        == 1;
  }

  public void save(Detail p) {
    sql.sql(
            "INSERT INTO"
                + " pools(pool_id,config_id,state_id,package_id,name,active,settings,created_at,updated_at)"
                + " VALUES(?,?,?,?,?,true,?::jsonb,?,?) ON CONFLICT(pool_id) DO UPDATE SET"
                + " config_id=EXCLUDED.config_id,state_id=EXCLUDED.state_id,settings=EXCLUDED.settings,active=true,created_at=COALESCE(pools.created_at,EXCLUDED.created_at),updated_at=EXCLUDED.updated_at")
        .params(
            p.poolId(),
            p.configId(),
            p.stateId(),
            p.packageId(),
            p.name(),
            json.writeValueAsString(p.settings()),
            p.createdAt() == null ? null : java.sql.Timestamp.from(p.createdAt()),
            java.sql.Timestamp.from(p.updatedAt()))
        .update();
    sql.sql(
            "INSERT INTO pool_pair_claims(pair_key,pool_id) VALUES(?,?) ON CONFLICT(pair_key) DO"
                + " NOTHING")
        .params(p.settings().pairKey(), p.poolId())
        .update();
  }

  public Map<String, String> names() {
    var map = new HashMap<String, String>();
    sql.sql("SELECT pool_id,name FROM pools")
        .query((r, n) -> Map.entry(r.getString(1), r.getString(2)))
        .list()
        .forEach(e -> map.put(e.getKey(), e.getValue()));
    return map;
  }

  public List<Detail> pools(String packageId) {
    return sql.sql(
            "SELECT * FROM pools WHERE active AND package_id=:packageId AND settings IS NOT"
                + " NULL ORDER BY name,pool_id")
        .param("packageId", packageId)
        .query(this::detail)
        .list();
  }

  public Detail pool(String id, String packageId) {
    return sql.sql(
            "SELECT * FROM pools WHERE pool_id=:id AND package_id=:packageId AND active AND"
                + " settings IS NOT NULL")
        .param("id", id)
        .param("packageId", packageId)
        .query(this::detail)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  private Proposal proposal(ResultSet r, int n) throws SQLException {
    return new Proposal(
        r.getObject("id", UUID.class),
        r.getString("name"),
        json.readValue(r.getString("settings"), Terms.class),
        Status.valueOf(r.getString("status")),
        r.getTimestamp("created_at").toInstant(),
        r.getTimestamp("updated_at").toInstant(),
        r.getString("display_name"),
        r.getString("proposal_cid"),
        r.getString("factory_id"),
        r.getString("pool_id"),
        r.getString("update_id"),
        r.getString("error"));
  }

  private Detail detail(ResultSet r, int n) throws SQLException {
    var created = r.getTimestamp("created_at");
    return new Detail(
        r.getString("pool_id"),
        r.getString("name"),
        json.readValue(r.getString("settings"), Terms.class),
        r.getString("config_id"),
        r.getString("state_id"),
        r.getString("package_id"),
        created == null ? null : created.toInstant(),
        r.getTimestamp("updated_at").toInstant());
  }
}
