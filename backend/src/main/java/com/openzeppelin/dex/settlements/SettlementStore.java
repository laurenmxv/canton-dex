package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;

import com.openzeppelin.dex.swaps.SwapFailure;
import com.openzeppelin.dex.swaps.SwapModels.Swap;
import com.openzeppelin.dex.swaps.SwapStore;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

@Repository
public class SettlementStore {
  private final JdbcClient sql;
  private final ObjectMapper json;
  private final TransactionTemplate tx;
  private final int maxBatchSize;

  public SettlementStore(
      JdbcClient sql,
      ObjectMapper json,
      PlatformTransactionManager manager,
      @Value("${dex.settlements.max-batch-size:10}") int maxBatchSize) {
    if (maxBatchSize < 1 || maxBatchSize > 20)
      throw new IllegalArgumentException("Maximum batch size must be between 1 and 20");
    this.sql = sql;
    this.json = json;
    this.tx = new TransactionTemplate(manager);
    this.maxBatchSize = maxBatchSize;
  }

  public Policy policy(String poolId) {
    ensureQueue(poolId);
    return sql.sql("SELECT * FROM pool_swap_queues WHERE pool_id=?")
        .param(poolId)
        .query(this::readPolicy)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Policy updatePolicy(String poolId, UpdatePolicy input, Instant now) {
    if (input.batchSize() < 1 || input.batchSize() > maxBatchSize)
      throw new SwapFailure("INVALID_BATCH_SIZE", "Batch size exceeds the configured limit", 400);
    return tx.execute(
        s -> {
          lockQueue(poolId);
          int changed =
              sql.sql(
                      """
                      UPDATE pool_swap_queues SET automatic_enabled=?,batch_size=?,
                        policy_version=policy_version+1,blocked_version=NULL,updated_at=?
                      WHERE pool_id=? AND policy_version=?
                      """)
                  .params(
                      input.automaticEnabled(),
                      input.batchSize(),
                      Timestamp.from(now),
                      poolId,
                      input.expectedVersion())
                  .update();
          if (changed != 1)
            throw SwapFailure.conflict(
                "POLICY_CHANGED", "The settlement policy changed. Refresh it before saving.");
          return policy(poolId);
        });
  }

  public Optional<Settlement> find(UUID id) {
    return sql.sql("SELECT * FROM settlement_batches WHERE id=?")
        .param(id)
        .query(this::readSettlement)
        .optional();
  }

  public Settlement get(UUID id) {
    return find(id).orElseThrow(NoSuchElementException::new);
  }

  public List<Settlement> list(String poolId) {
    return sql.sql(
            """
            SELECT * FROM settlement_batches WHERE (?::text IS NULL OR pool_id=?)
            ORDER BY created_at DESC,id DESC LIMIT 100
            """)
        .params(poolId, poolId)
        .query(this::readSettlement)
        .list();
  }

  public List<String> automaticPools() {
    return sql.sql("SELECT pool_id FROM pool_swap_queues WHERE automatic_enabled ORDER BY pool_id")
        .query(String.class)
        .list();
  }

  public List<Pending> pending() {
    return sql.sql(
            """
            SELECT * FROM settlement_batches WHERE status IN ('PREPARING','SUBMITTING','UNRESOLVED')
            ORDER BY created_at,id
            """)
        .query(this::readPending)
        .list();
  }

  /** The queue row serializes admission, policy changes, withdrawal claims and dispatch. */
  public Optional<Pending> claim(
      String poolId, UUID id, Trigger trigger, Snapshot snapshot, Instant now) {
    try {
      return tx.execute(
          s -> {
            QueueState queue = lockQueue(poolId);
            var previous = find(id);
            if (previous.isPresent()) {
              if (!previous.get().poolId().equals(poolId))
                throw SwapFailure.conflict(
                    "IDEMPOTENCY_CONFLICT", "This settlement key belongs to another pool");
              return Optional.empty();
            }
            if (queue.activeId() != null) {
              if (trigger == Trigger.MANUAL)
                throw SwapFailure.conflict(
                    "BATCH_IN_FLIGHT", "This pool already has a settlement in flight");
              return Optional.empty();
            }
            String policyLimit = policyLimitReason(queue.policy());
            if (policyLimit != null)
              throw SwapFailure.conflict("POLICY_LIMIT_EXCEEDED", policyLimit);
            expireReady(poolId, now);
            queue = lockQueue(poolId);
            if (trigger == Trigger.AUTOMATIC
                && (!queue.policy().automaticEnabled()
                    || Objects.equals(queue.blockedVersion(), snapshot.version())))
              return Optional.empty();

            List<Swap> selected = prefix(queue(poolId), queue.policy().batchSize());
            if (selected.isEmpty()
                || (trigger == Trigger.AUTOMATIC && selected.size() != queue.policy().batchSize()))
              return Optional.empty();

            List<UUID> ids = selected.stream().map(Swap::swapId).toList();
            sql.sql(
                    """
                    INSERT INTO settlement_batches(id,pool_id,trigger,status,swap_ids,policy_version,
                      command_id,begin_offset,state_version,reserves_before,created_at,updated_at)
                    VALUES(?,?,?,'PREPARING',?::jsonb,?,?,?,?,?::jsonb,?,?)
                    """)
                .params(
                    id,
                    poolId,
                    trigger.name(),
                    json.writeValueAsString(ids),
                    queue.policy().version(),
                    id,
                    snapshot.ledgerOffset(),
                    snapshot.version(),
                    json.writeValueAsString(snapshot.reserves()),
                    Timestamp.from(now),
                    Timestamp.from(now))
                .update();
            for (UUID swapId : ids)
              sql.sql(
                      """
                      UPDATE swap_requests SET status='SETTLING',settlement_id=?,error_code=NULL,error=NULL,updated_at=?
                      WHERE id=? AND status IN ('READY','BLOCKED')
                      """)
                  .params(id, Timestamp.from(now), swapId)
                  .update();
            sql.sql(
                    "UPDATE pool_swap_queues SET active_settlement_id=?,updated_at=? WHERE"
                        + " pool_id=?")
                .params(id, Timestamp.from(now), poolId)
                .update();
            return Optional.of(pending(id));
          });
    } catch (DuplicateKeyException collision) {
      // The same operator key can race on two independent pool rows.
      var existing = find(id);
      if (existing.isEmpty()) throw collision;
      if (!existing.get().poolId().equals(poolId))
        throw SwapFailure.conflict(
            "IDEMPOTENCY_CONFLICT", "This settlement key belongs to another pool");
      return Optional.empty();
    }
  }

  static List<Swap> prefix(List<Swap> queue, int limit) {
    List<Swap> result = new ArrayList<>();
    for (Swap swap : queue) {
      if (result.size() == limit) break;
      if (swap.status() != com.openzeppelin.dex.swaps.SwapModels.Status.READY
          && swap.status() != com.openzeppelin.dex.swaps.SwapModels.Status.BLOCKED) break;
      result.add(swap);
    }
    return List.copyOf(result);
  }

  public List<Swap> queue(String poolId) {
    return sql.sql(
            """
            SELECT * FROM swap_requests WHERE terms->>'poolId'=? AND arrival_sequence IS NOT NULL
              AND status IN ('SUBMITTING','UNRESOLVED','READY','BLOCKED','SETTLING',
                'WITHDRAWING','WITHDRAWAL_UNRESOLVED')
            ORDER BY arrival_sequence,id
            """)
        .param(poolId)
        .query((r, n) -> SwapStore.readSwap(r, json))
        .list();
  }

  public Pending pending(UUID id) {
    return sql.sql("SELECT * FROM settlement_batches WHERE id=?")
        .param(id)
        .query(this::readPending)
        .single();
  }

  /** Drop only a suffix; later requests never jump a blocked request. */
  public boolean keepPrefix(
      UUID id,
      List<UUID> prefix,
      UUID blockedId,
      String code,
      String reason,
      String stateVersion,
      Instant now) {
    return tx.execute(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.PREPARING) return false;
          int blockedIndex = batch.swapIds().indexOf(blockedId);
          if (blockedIndex < 0 || !batch.swapIds().subList(0, blockedIndex).equals(prefix))
            return false;
          release(
              batch,
              batch.swapIds().subList(blockedIndex, batch.swapIds().size()),
              blockedId,
              code,
              reason,
              now);
          sql.sql("UPDATE pool_swap_queues SET blocked_version=?,updated_at=? WHERE pool_id=?")
              .params(stateVersion, Timestamp.from(now), batch.poolId())
              .update();
          if (prefix.isEmpty()) {
            finishAttempt(batch, Status.REJECTED, code, reason, now);
          } else {
            sql.sql("UPDATE settlement_batches SET swap_ids=?::jsonb,updated_at=? WHERE id=?")
                .params(json.writeValueAsString(prefix), Timestamp.from(now), id)
                .update();
          }
          return true;
        });
  }

  public void rejectPreparation(
      UUID id, UUID blockedId, String code, String reason, String stateVersion, Instant now) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.PREPARING) return;
          release(batch, batch.swapIds(), blockedId, code, reason, now);
          sql.sql("UPDATE pool_swap_queues SET blocked_version=?,updated_at=? WHERE pool_id=?")
              .params(stateVersion, Timestamp.from(now), batch.poolId())
              .update();
          finishAttempt(batch, Status.REJECTED, code, reason, now);
        });
  }

  public void cancelPreparation(UUID id, String code, String reason, Instant now) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.PREPARING) return;
          release(batch, batch.swapIds(), null, null, null, now);
          finishAttempt(batch, Status.CANCELLED, code, reason, now);
        });
  }

  /** Commit the right to submit before touching the network. Disabling serializes on this row. */
  public Optional<Pending> authorizeDispatch(
      UUID id, List<Fill> fills, Snapshot snapshot, Instant now) {
    return tx.execute(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.PREPARING) return Optional.empty();
          QueueState queue = lockQueue(batch.poolId());
          String policyLimit = policyLimitReason(queue.policy());
          if (policyLimit != null) {
            release(batch, batch.swapIds(), null, null, null, now);
            finishAttempt(batch, Status.CANCELLED, "POLICY_LIMIT_EXCEEDED", policyLimit, now);
            return Optional.empty();
          }
          if (batch.trigger() == Trigger.AUTOMATIC
              && (!queue.policy().automaticEnabled()
                  || queue.policy().version() != batch.policyVersion())) {
            release(batch, batch.swapIds(), null, null, null, now);
            finishAttempt(
                batch,
                Status.CANCELLED,
                "POLICY_CHANGED",
                "Automatic policy changed before dispatch",
                now);
            return Optional.empty();
          }
          if (!batch.swapIds().equals(fills.stream().map(Fill::swapId).toList()))
            return Optional.empty();
          Pending pending = pending(id);
          if (pending.swaps().stream().anyMatch(swap -> !swap.settlementDeadline().isAfter(now))) {
            release(batch, batch.swapIds(), null, null, null, now);
            finishAttempt(
                batch,
                Status.CANCELLED,
                "DEADLINE_PASSED",
                "A request expired before dispatch",
                now);
            return Optional.empty();
          }
          sql.sql(
                  """
                  UPDATE settlement_batches SET status='SUBMITTING',fills=?::jsonb,reserves_before=?::jsonb,
                    state_version=?,begin_offset=?,updated_at=? WHERE id=? AND status='PREPARING'
                  """)
              .params(
                  json.writeValueAsString(fills),
                  json.writeValueAsString(snapshot.reserves()),
                  snapshot.version(),
                  snapshot.ledgerOffset(),
                  Timestamp.from(now),
                  id)
              .update();
          return Optional.of(pending(id));
        });
  }

  public void unresolved(UUID id, Instant now) {
    sql.sql(
            """
            UPDATE settlement_batches SET status='UNRESOLVED',error_code='CONFIRMATION_PENDING',
              error='Settlement confirmation is pending',updated_at=? WHERE id=? AND status='SUBMITTING'
            """)
        .params(Timestamp.from(now), id)
        .update();
  }

  public boolean beginRecovery(UUID id, Instant now) {
    return sql.sql(
                """
                UPDATE settlement_batches SET status='UNRESOLVED',error_code='CONFIRMATION_PENDING',
                  error='Settlement confirmation is pending',updated_at=?
                WHERE id=? AND status IN ('SUBMITTING','UNRESOLVED')
                """)
            .params(Timestamp.from(now), id)
            .update()
        == 1;
  }

  public void rejectSubmission(UUID id, String code, String reason, Instant now) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          // Recovery may already have replayed the immutable command. A late first-attempt
          // rejection cannot prove that replay did not commit.
          if (batch.status() != Status.SUBMITTING) return;
          release(batch, batch.swapIds(), batch.swapIds().getFirst(), code, reason, now);
          sql.sql(
                  """
                  UPDATE pool_swap_queues SET blocked_version=(SELECT state_version FROM settlement_batches WHERE id=?),
                    updated_at=? WHERE pool_id=?
                  """)
              .params(id, Timestamp.from(now), batch.poolId())
              .update();
          finishAttempt(batch, Status.REJECTED, code, reason, now);
        });
  }

  /** Apply ledger evidence that excludes this batch, without inferring a withdrawal. */
  public void excludeSubmission(UUID id, String code, String reason, Instant now) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.SUBMITTING && batch.status() != Status.UNRESOLVED) return;
          release(batch, batch.swapIds(), null, null, null, now);
          finishAttempt(batch, Status.REJECTED, code, reason, now);
          sql.sql("UPDATE pool_swap_queues SET blocked_version=NULL,updated_at=? WHERE pool_id=?")
              .params(Timestamp.from(now), batch.poolId())
              .update();
        });
  }

  public void confirm(UUID id, Confirmation confirmation) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() == Status.CONFIRMED) return;
          if (batch.status() != Status.SUBMITTING && batch.status() != Status.UNRESOLVED)
            throw new IllegalStateException("Settlement confirmation has no authorized submission");
          if (!batch.swapIds().equals(confirmation.fills().stream().map(Fill::swapId).toList()))
            throw new IllegalStateException(
                "Settlement confirmation does not match the frozen batch");
          Timestamp now = Timestamp.from(confirmation.confirmedAt());
          sql.sql(
                  """
                  UPDATE settlement_batches SET status='CONFIRMED',fills=?::jsonb,reserves_before=?::jsonb,
                    reserves_after=?::jsonb,update_id=?,error_code=NULL,error=NULL,updated_at=? WHERE id=?
                  """)
              .params(
                  json.writeValueAsString(confirmation.fills()),
                  json.writeValueAsString(confirmation.before()),
                  json.writeValueAsString(confirmation.after()),
                  confirmation.updateId(),
                  now,
                  id)
              .update();
          for (Fill fill : confirmation.fills()) {
            int changed =
                sql.sql(
                        """
                        UPDATE swap_requests SET status='SETTLED',amount_out=?,update_id=?,error_code=NULL,error=NULL,updated_at=?
                        WHERE id=? AND settlement_id=?
                          AND status IN ('SETTLING','WITHDRAWING','WITHDRAWAL_UNRESOLVED','EXPIRED','SETTLED')
                        """)
                    .params(fill.amountOut(), confirmation.updateId(), now, fill.swapId(), id)
                    .update();
            if (changed != 1) throw new IllegalStateException("Conflicting terminal swap evidence");
          }
          sql.sql(
                  """
                  UPDATE pool_swap_queues SET active_settlement_id=NULL,blocked_version=NULL,updated_at=?
                  WHERE pool_id=? AND active_settlement_id=?
                  """)
              .params(now, batch.poolId(), id)
              .update();
        });
  }

  public Monitoring monitoring(String poolId, Snapshot snapshot, Instant now) {
    return tx.execute(
        s -> {
          QueueState state = lockQueue(poolId);
          expireReady(poolId, now);
          List<Swap> swaps = queue(poolId);
          Swap blocked =
              swaps.stream()
                  .filter(
                      swap -> swap.status() == com.openzeppelin.dex.swaps.SwapModels.Status.BLOCKED)
                  .findFirst()
                  .orElse(null);
          int ready =
              (int)
                  swaps.stream()
                      .filter(
                          swap ->
                              swap.status() == com.openzeppelin.dex.swaps.SwapModels.Status.READY)
                      .count();
          int pending =
              (int)
                  swaps.stream()
                      .filter(
                          swap ->
                              switch (swap.status()) {
                                case SUBMITTING, UNRESOLVED, WITHDRAWING, WITHDRAWAL_UNRESOLVED ->
                                    true;
                                default -> false;
                              })
                      .count();
          String policyLimit = policyLimitReason(state.policy());
          return new Monitoring(
              poolId,
              state.policy(),
              ready,
              pending,
              policyLimit != null || blocked == null ? null : blocked.swapId(),
              policyLimit != null ? policyLimit : blocked == null ? null : blocked.error(),
              swaps.stream()
                  .map(Swap::submittedAt)
                  .filter(Objects::nonNull)
                  .min(Instant::compareTo)
                  .orElse(null),
              swaps.stream().map(Swap::settlementDeadline).min(Instant::compareTo).orElse(null),
              state.activeId() == null ? null : get(state.activeId()),
              snapshot);
        });
  }

  private String policyLimitReason(Policy policy) {
    return policy.batchSize() > maxBatchSize
        ? "Saved batch size "
            + policy.batchSize()
            + " exceeds the current maximum "
            + maxBatchSize
            + ". Update this pool's settlement policy before dispatching."
        : null;
  }

  private void ensureQueue(String poolId) {
    sql.sql(
            """
            INSERT INTO pool_swap_queues(pool_id,batch_size)
            SELECT pool_id,? FROM pools WHERE pool_id=? ON CONFLICT(pool_id) DO NOTHING
            """)
        .params(Math.min(5, maxBatchSize), poolId)
        .update();
  }

  private record QueueState(Policy policy, UUID activeId, String blockedVersion) {}

  private QueueState lockQueue(String poolId) {
    ensureQueue(poolId);
    return sql.sql("SELECT * FROM pool_swap_queues WHERE pool_id=? FOR UPDATE")
        .param(poolId)
        .query(
            (r, n) ->
                new QueueState(
                    readPolicy(r, n),
                    r.getObject("active_settlement_id", UUID.class),
                    r.getString("blocked_version")))
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  private Settlement lockBatch(UUID id) {
    Settlement batch = get(id);
    lockQueue(batch.poolId());
    return sql.sql("SELECT * FROM settlement_batches WHERE id=? FOR UPDATE")
        .param(id)
        .query(this::readSettlement)
        .single();
  }

  private void expireReady(String poolId, Instant now) {
    int changed =
        sql.sql(
                """
                UPDATE swap_requests SET status='EXPIRED',error_code='DEADLINE_PASSED',
                  error='Settlement deadline passed. Withdraw the locked allocation.',updated_at=?
                WHERE terms->>'poolId'=? AND status IN ('READY','BLOCKED')
                  AND (terms->>'settlementDeadline')::timestamptz<=?
                """)
            .params(Timestamp.from(now), poolId, Timestamp.from(now))
            .update();
    if (changed > 0)
      sql.sql("UPDATE pool_swap_queues SET blocked_version=NULL,updated_at=? WHERE pool_id=?")
          .params(Timestamp.from(now), poolId)
          .update();
  }

  private void release(
      Settlement batch, List<UUID> ids, UUID blockedId, String code, String reason, Instant now) {
    for (UUID swapId : ids)
      sql.sql(
              """
              UPDATE swap_requests SET
                status=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=? THEN 'EXPIRED'
                  WHEN id=? THEN 'BLOCKED' ELSE 'READY' END,
                error_code=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=? THEN 'DEADLINE_PASSED'
                  WHEN id=? THEN ? ELSE NULL END,
                error=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=?
                  THEN 'Settlement deadline passed. Withdraw the locked allocation.'
                  WHEN id=? THEN ? ELSE NULL END,
                settlement_id=NULL,updated_at=?
              WHERE id=? AND settlement_id=? AND status='SETTLING'
              """)
          .params(
              Timestamp.from(now),
              blockedId,
              Timestamp.from(now),
              blockedId,
              code,
              Timestamp.from(now),
              blockedId,
              reason,
              Timestamp.from(now),
              swapId,
              batch.settlementId())
          .update();
  }

  private void finishAttempt(
      Settlement batch, Status status, String code, String reason, Instant now) {
    sql.sql("UPDATE settlement_batches SET status=?,error_code=?,error=?,updated_at=? WHERE id=?")
        .params(status.name(), code, reason, Timestamp.from(now), batch.settlementId())
        .update();
    sql.sql(
            """
            UPDATE pool_swap_queues SET active_settlement_id=NULL,updated_at=?
            WHERE pool_id=? AND active_settlement_id=?
            """)
        .params(Timestamp.from(now), batch.poolId(), batch.settlementId())
        .update();
  }

  private Policy readPolicy(ResultSet r, int ignored) throws SQLException {
    return new Policy(
        r.getString("pool_id"),
        r.getBoolean("automatic_enabled"),
        r.getInt("batch_size"),
        maxBatchSize,
        r.getLong("policy_version"),
        r.getTimestamp("updated_at").toInstant());
  }

  private Settlement readSettlement(ResultSet r, int ignored) throws SQLException {
    return new Settlement(
        r.getObject("id", UUID.class),
        r.getString("pool_id"),
        Trigger.valueOf(r.getString("trigger")),
        Status.valueOf(r.getString("status")),
        Arrays.asList(json.readValue(r.getString("swap_ids"), UUID[].class)),
        Arrays.asList(json.readValue(r.getString("fills"), Fill[].class)),
        reserves(r.getString("reserves_before")),
        reserves(r.getString("reserves_after")),
        r.getLong("policy_version"),
        r.getTimestamp("created_at").toInstant(),
        r.getTimestamp("updated_at").toInstant(),
        r.getString("update_id"),
        r.getString("error_code"),
        r.getString("error"));
  }

  private Reserves reserves(String value) {
    return value == null ? null : json.readValue(value, Reserves.class);
  }

  private Pending readPending(ResultSet r, int ignored) throws SQLException {
    Settlement batch = readSettlement(r, ignored);
    List<Swap> swaps =
        batch.swapIds().stream()
            .map(
                id ->
                    sql.sql("SELECT * FROM swap_requests WHERE id=?")
                        .param(id)
                        .query((row, n) -> SwapStore.readSwap(row, json))
                        .single())
            .toList();
    return new Pending(
        batch,
        swaps,
        r.getObject("command_id", UUID.class),
        r.getLong("begin_offset"),
        r.getString("state_version"));
  }
}
