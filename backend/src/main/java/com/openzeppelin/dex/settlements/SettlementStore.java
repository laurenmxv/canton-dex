package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;

import com.openzeppelin.dex.liquidity.LiquidityModels;
import com.openzeppelin.dex.liquidity.LiquidityStore;
import com.openzeppelin.dex.swaps.SwapFailure;
import com.openzeppelin.dex.swaps.SwapStore;
import java.nio.charset.StandardCharsets;
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
  private static final Set<String> SELECTABLE_STATUSES = Set.of("READY", "BLOCKED");
  private static final String INVALID_HISTORY_CURSOR = "Invalid history cursor";

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
    return sql.sql("SELECT * FROM pool_queues WHERE pool_id=?")
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
                      UPDATE pool_queues SET automatic_enabled=?,batch_size=?,
                        policy_version=policy_version+1,updated_at=?
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
                POLICY_CHANGED, "The settlement policy changed. Refresh it before saving.");
          sql.sql("UPDATE pool_request_queues SET blocked_version=NULL WHERE pool_id=?")
              .param(poolId)
              .update();
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

  public Optional<Settlement> findIntent(String poolId, UUID id, Selection selection) {
    var existing = find(id);
    if (existing.isEmpty()) return existing;
    String stored =
        sql.sql("SELECT selection::text FROM settlement_batches WHERE id=?")
            .param(id)
            .query((r, n) -> r.getString(1))
            .optional()
            .orElse(null);
    Selection intent = stored == null ? null : json.readValue(stored, Selection.class);
    if (!existing.get().poolId().equals(poolId) || !Objects.equals(intent, selection))
      throw SwapFailure.conflict(
          IDEMPOTENCY_CONFLICT, "This key belongs to a different settlement intent");
    return existing;
  }

  public Plan plan(String poolId, String family, UUID retryOf, Snapshot snapshot, Instant now) {
    requireFamily(family);
    return tx.execute(
        s -> {
          var state = lockQueue(poolId);
          expireReady(poolId, now);
          var requests = candidates(poolId, family, retryOf, state.policy().batchSize());
          var selection =
              new Selection(
                  family,
                  retryOf,
                  snapshot.version(),
                  state.policy().version(),
                  requests.stream().map(QueueRequest::reference).toList());
          return new Plan(selection, requests, state.activeId());
        });
  }

  private List<QueueRequest> candidates(String poolId, String family, UUID retryOf, int limit) {
    var requests = queue(poolId).stream().filter(r -> r.type().equals(family)).toList();
    if (retryOf == null) return prefix(requests, limit);
    var previous = get(retryOf);
    if (!previous.poolId().equals(poolId)
        || !Set.of(Status.REJECTED, Status.CANCELLED).contains(previous.status())
        || previous.requests().stream().anyMatch(r -> !r.type().equals(family)))
      throw SwapFailure.conflict(
          RETRY_NOT_ALLOWED,
          "Only a rejected or cancelled batch from this pool and queue can be retried");
    var byId = new HashMap<RequestRef, QueueRequest>();
    requests.forEach(r -> byId.put(r.reference(), r));
    return prefix(
        previous.requests().stream()
            .map(byId::get)
            .filter(Objects::nonNull)
            .filter(r -> SELECTABLE_STATUSES.contains(r.status()))
            .toList(),
        limit);
  }

  private List<QueueRequest> selected(
      String poolId, Policy policy, Snapshot snapshot, Selection selection) {
    if (!snapshot.version().equals(selection.stateVersion()))
      throw SwapFailure.conflict(POOL_CHANGED, "Pool changed. Refresh the preview.");
    if (policy.version() != selection.policyVersion())
      throw SwapFailure.conflict(POLICY_CHANGED, "Policy changed. Refresh the preview.");
    var requests = candidates(poolId, selection.type(), selection.retryOf(), policy.batchSize());
    if (!requests.stream().map(QueueRequest::reference).toList().equals(selection.requests()))
      throw SwapFailure.conflict(QUEUE_CHANGED, "Queue changed. Refresh the preview.");
    return requests;
  }

  public void setDeferred(String poolId, RequestRef reference, boolean deferred, Instant now) {
    tx.executeWithoutResult(
        s -> {
          var state = lockQueue(poolId);
          if (state.activeId() != null)
            throw SwapFailure.conflict(
                BATCH_IN_FLIGHT, "Wait for this pool's active settlement to finish");
          var request = findRequest(reference).orElseThrow(NoSuchElementException::new);
          if (!request.poolId().equals(poolId)) throw new NoSuchElementException();
          if (!SELECTABLE_STATUSES.contains(request.status())
              || !now.isBefore(request.settlementDeadline()))
            throw SwapFailure.conflict(
                REQUEST_NOT_READY,
                "Only unexpired ready or blocked requests can be deferred or returned");
          if (deferred) {
            int inserted =
                sql.sql(
                        "INSERT INTO settlement_deferred_requests(pool_id,family,request_id,deferred_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
                    .params(poolId, reference.type(), reference.requestId(), Timestamp.from(now))
                    .update();
            if (inserted == 0) return;
          } else {
            int removed =
                sql.sql(
                        "DELETE FROM settlement_deferred_requests WHERE pool_id=? AND family=? AND request_id=?")
                    .params(poolId, reference.type(), reference.requestId())
                    .update();
            if (removed == 0) return;
            long sequence =
                sql.sql(
                        "UPDATE pool_request_queues SET next_sequence=next_sequence+1 WHERE pool_id=? AND family=? RETURNING next_sequence")
                    .params(poolId, reference.type())
                    .query(Long.class)
                    .single();
            sql.sql(
                    "UPDATE "
                        + requestTable(reference)
                        + " SET arrival_sequence=?,status='READY',error_code=NULL,error=NULL,updated_at=? WHERE id=?")
                .params(sequence, Timestamp.from(now), reference.requestId())
                .update();
          }
          sql.sql(
                  "UPDATE pool_request_queues SET blocked_version=NULL,updated_at=? WHERE pool_id=? AND family=?")
              .params(Timestamp.from(now), poolId, reference.type())
              .update();
        });
  }

  public History history(String poolId, String type, Status status, String before, int limit) {
    if (type != null) requireFamily(type);
    if (limit < 1 || limit > 100) throw new IllegalArgumentException("Invalid history limit");
    Instant time = null;
    UUID id = null;
    if (before != null) {
      String[] cursor =
          new String(Base64.getUrlDecoder().decode(before), StandardCharsets.UTF_8)
              .split("\\|", -1);
      if (cursor.length != 2) throw new IllegalArgumentException(INVALID_HISTORY_CURSOR);
      try {
        time = Instant.parse(cursor[0]);
      } catch (java.time.format.DateTimeParseException invalid) {
        throw new IllegalArgumentException(INVALID_HISTORY_CURSOR, invalid);
      }
      id = UUID.fromString(cursor[1]);
    }
    var items =
        sql.sql(
                """
        SELECT * FROM settlement_batches WHERE pool_id=?
          AND (?::text IS NULL OR requests->0->>'type'=?)
          AND (?::text IS NULL OR status=?)
          AND (?::timestamptz IS NULL OR (created_at,id) < (?,?))
        ORDER BY created_at DESC,id DESC LIMIT ?
        """)
            .params(
                poolId,
                type,
                type,
                status == null ? null : status.name(),
                status == null ? null : status.name(),
                time == null ? null : Timestamp.from(time),
                time == null ? null : Timestamp.from(time),
                id,
                limit + 1)
            .query(this::readSettlement)
            .list();
    if (items.size() <= limit) return new History(items, null);
    var last = items.get(limit - 1);
    String cursor =
        Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(
                (last.createdAt() + "|" + last.settlementId()).getBytes(StandardCharsets.UTF_8));
    return new History(List.copyOf(items.subList(0, limit)), cursor);
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
    return sql.sql("SELECT pool_id FROM pool_queues WHERE automatic_enabled ORDER BY pool_id")
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
    return claim(poolId, id, trigger, snapshot, now, null);
  }

  public Optional<Pending> claim(
      String poolId,
      UUID id,
      Trigger trigger,
      Snapshot snapshot,
      Instant now,
      Selection selection) {
    try {
      return tx.execute(
          s -> {
            QueueState queue = lockQueue(poolId);
            var previous = findIntent(poolId, id, selection);
            if (previous.isPresent()) {
              if (!previous.get().poolId().equals(poolId))
                throw SwapFailure.conflict(
                    IDEMPOTENCY_CONFLICT, "This settlement key belongs to another pool");
              return Optional.empty();
            }
            if (queue.activeId() != null) {
              if (trigger == Trigger.MANUAL)
                throw SwapFailure.conflict(
                    BATCH_IN_FLIGHT, "This pool already has a settlement in flight");
              return Optional.empty();
            }
            String policyLimit = policyLimitReason(queue.policy());
            if (policyLimit != null)
              throw SwapFailure.conflict("POLICY_LIMIT_EXCEEDED", policyLimit);
            expireReady(poolId, now);
            queue = lockQueue(poolId);
            if (trigger == Trigger.AUTOMATIC && !queue.policy().automaticEnabled())
              return Optional.empty();
            Set<String> blockedFamilies =
                trigger == Trigger.AUTOMATIC
                    ? new HashSet<>(
                        sql.sql(
                                "SELECT family FROM pool_request_queues WHERE pool_id=? AND"
                                    + " blocked_version=?")
                            .params(poolId, snapshot.version())
                            .query(String.class)
                            .list())
                    : Set.of();
            List<QueueRequest> selected =
                selection == null
                    ? select(
                        queue(poolId),
                        queue.policy().batchSize(),
                        queue.lastProcessedFamily(),
                        blockedFamilies,
                        trigger == Trigger.AUTOMATIC)
                    : selected(poolId, queue.policy(), snapshot, selection);
            if (selected.isEmpty()) return Optional.empty();

            List<RequestRef> ids = selected.stream().map(QueueRequest::reference).toList();
            sql.sql(
                    """
                    INSERT INTO settlement_batches(id,pool_id,trigger,status,requests,policy_version,
                      command_id,begin_offset,state_version,reserves_before,created_at,updated_at,retry_of,selection)
                    VALUES(?,?,?,'PREPARING',?::jsonb,?,?,?,?,?::jsonb,?,?,?,?::jsonb)
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
                    Timestamp.from(now),
                    selection == null ? null : selection.retryOf(),
                    selection == null ? null : json.writeValueAsString(selection))
                .update();
            for (RequestRef request : ids)
              sql.sql(
                      """
                      UPDATE %s SET status='SETTLING',settlement_id=?,error_code=NULL,error=NULL,updated_at=?
                      WHERE id=? AND status IN ('READY','BLOCKED')
                      """
                          .formatted(requestTable(request)))
                  .params(id, Timestamp.from(now), request.requestId())
                  .update();
            sql.sql(
                    "UPDATE pool_queues SET"
                        + " active_settlement_id=?,last_processed_family=?,updated_at=? WHERE"
                        + " pool_id=?")
                .params(id, selected.getFirst().type(), Timestamp.from(now), poolId)
                .update();
            return Optional.of(pending(id));
          });
    } catch (DuplicateKeyException collision) {
      // The same operator key can race on two independent pool rows.
      var existing = findIntent(poolId, id, selection);
      if (existing.isEmpty()) throw collision;
      if (!existing.get().poolId().equals(poolId))
        throw SwapFailure.conflict(
            IDEMPOTENCY_CONFLICT, "This settlement key belongs to another pool");
      return Optional.empty();
    }
  }

  static List<QueueRequest> prefix(List<QueueRequest> queue, int limit) {
    List<QueueRequest> selected = new ArrayList<>();
    for (var request : queue) {
      if (request.deferred()) continue;
      if (selected.size() == limit || !SELECTABLE_STATUSES.contains(request.status())) break;
      boolean individual =
          request instanceof LiquidityRequest liquidity
              && liquidity.request().terms() instanceof LiquidityModels.DepositTerms deposit
              && deposit.mode() == LiquidityModels.Mode.INITIAL;
      if (!selected.isEmpty() && (individual || !request.type().equals(selected.getFirst().type())))
        break;
      selected.add(request);
      if (individual) break;
    }
    return List.copyOf(selected);
  }

  static List<QueueRequest> select(
      List<QueueRequest> requests,
      int batchSize,
      String lastProcessedFamily,
      Set<String> blockedFamilies,
      boolean automatic) {
    List<String> families = FAMILIES;
    Map<String, List<QueueRequest>> ready = new HashMap<>();
    for (String family : families) {
      if (blockedFamilies.contains(family)) continue;
      var queue =
          requests.stream()
              .filter(r -> r.type().equals(family))
              .sorted(Comparator.comparing(QueueRequest::arrivalSequence))
              .toList();
      var candidates = prefix(queue, batchSize);
      if (!candidates.isEmpty()) ready.put(family, candidates);
    }
    int start = lastProcessedFamily == null ? 0 : families.indexOf(lastProcessedFamily) + 1;
    for (int n = 0; n < families.size(); n++) {
      String family = families.get((start + n) % families.size());
      var selected = ready.get(family);
      if (selected == null) continue;
      if (automatic && family.equals("swap") && selected.size() < batchSize && ready.size() == 1)
        continue;
      return selected;
    }
    return List.of();
  }

  public List<QueueRequest> queue(String poolId) {
    List<QueueRequest> requests = new ArrayList<>();
    requests.addAll(
        sql.sql(
                """
                SELECT * FROM swap_requests WHERE terms->>'poolId'=? AND arrival_sequence IS NOT NULL
                  AND status IN ('SUBMITTING','UNRESOLVED','READY','BLOCKED','SETTLING',
                                'WITHDRAWING','WITHDRAWAL_UNRESOLVED')
                  OR terms->>'poolId'=? AND status='EXPIRED' AND id IN
                    (SELECT request_id FROM settlement_deferred_requests WHERE pool_id=? AND family='swap')
                """)
            .params(poolId, poolId, poolId)
            .query((r, n) -> new SwapRequest(SwapStore.readSwap(r, json)))
            .list());
    requests.addAll(
        sql.sql(
                """
                SELECT * FROM liquidity_requests WHERE terms->>'poolId'=? AND arrival_sequence IS NOT NULL
                  AND status IN ('SUBMITTING','UNRESOLVED','READY','BLOCKED','SETTLING',
                                'RECOVERING','RECOVERY_UNRESOLVED')
                  OR terms->>'poolId'=? AND status='EXPIRED' AND id IN
                    (SELECT request_id FROM settlement_deferred_requests WHERE pool_id=? AND family IN ('deposit','withdraw'))
                """)
            .params(poolId, poolId, poolId)
            .query((r, n) -> new LiquidityRequest(LiquidityStore.readRequest(r, json)))
            .list());
    Set<RequestRef> deferred =
        new HashSet<>(
            sql.sql("SELECT family,request_id FROM settlement_deferred_requests WHERE pool_id=?")
                .param(poolId)
                .query(
                    (r, n) ->
                        new RequestRef(
                            r.getString("family"), r.getObject("request_id", UUID.class)))
                .list());
    return requests.stream()
        .map(
            request ->
                switch (request) {
                  case SwapRequest swap ->
                      (QueueRequest)
                          new SwapRequest(swap.request(), deferred.contains(swap.reference()));
                  case LiquidityRequest liquidity ->
                      new LiquidityRequest(
                          liquidity.request(), deferred.contains(liquidity.reference()));
                })
        .sorted(
            Comparator.comparing(QueueRequest::type).thenComparing(QueueRequest::arrivalSequence))
        .toList();
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
      List<RequestRef> prefix,
      RequestRef blockedId,
      String code,
      String reason,
      String stateVersion,
      Instant now) {
    return tx.execute(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.PREPARING) return false;
          int blockedIndex = batch.requests().indexOf(blockedId);
          if (blockedIndex < 0 || !batch.requests().subList(0, blockedIndex).equals(prefix))
            return false;
          release(
              batch,
              batch.requests().subList(blockedIndex, batch.requests().size()),
              blockedId,
              code,
              reason,
              now);
          blockFamily(batch, stateVersion, now);
          if (prefix.isEmpty()) {
            finishAttempt(batch, Status.REJECTED, code, reason, now);
          } else {
            sql.sql("UPDATE settlement_batches SET requests=?::jsonb,updated_at=? WHERE id=?")
                .params(json.writeValueAsString(prefix), Timestamp.from(now), id)
                .update();
          }
          return true;
        });
  }

  public void rejectPreparation(
      UUID id, RequestRef blockedId, String code, String reason, String stateVersion, Instant now) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.PREPARING) return;
          release(batch, batch.requests(), blockedId, code, reason, now);
          blockFamily(batch, stateVersion, now);
          finishAttempt(batch, Status.REJECTED, code, reason, now);
        });
  }

  public void cancelPreparation(UUID id, String code, String reason, Instant now) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.PREPARING) return;
          release(batch, batch.requests(), null, null, null, now);
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
            release(batch, batch.requests(), null, null, null, now);
            finishAttempt(batch, Status.CANCELLED, "POLICY_LIMIT_EXCEEDED", policyLimit, now);
            return Optional.empty();
          }
          if (batch.trigger() == Trigger.AUTOMATIC
              && (!queue.policy().automaticEnabled()
                  || queue.policy().version() != batch.policyVersion())) {
            release(batch, batch.requests(), null, null, null, now);
            finishAttempt(
                batch,
                Status.CANCELLED,
                POLICY_CHANGED,
                "Automatic policy changed before dispatch",
                now);
            return Optional.empty();
          }
          if (!batch.requests().equals(fills.stream().map(Fill::reference).toList()))
            return Optional.empty();
          Pending pending = pending(id);
          var selection = pending.selection();
          if (selection != null
              && (!selection.stateVersion().equals(snapshot.version())
                  || selection.policyVersion() != queue.policy().version())) {
            release(batch, batch.requests(), null, null, null, now);
            boolean changedPool = !selection.stateVersion().equals(snapshot.version());
            finishAttempt(
                batch,
                Status.CANCELLED,
                changedPool ? POOL_CHANGED : POLICY_CHANGED,
                "The preview changed before dispatch. Refresh it before trying again.",
                now);
            return Optional.empty();
          }
          if (pending.requests().stream()
              .anyMatch(request -> !request.settlementDeadline().isAfter(now))) {
            release(batch, batch.requests(), null, null, null, now);
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
          release(batch, batch.requests(), batch.requests().getFirst(), code, reason, now);
          String version =
              sql.sql("SELECT state_version FROM settlement_batches WHERE id=?")
                  .param(id)
                  .query(String.class)
                  .single();
          blockFamily(batch, version, now);
          finishAttempt(batch, Status.REJECTED, code, reason, now);
        });
  }

  /** Apply proof that this batch cannot commit, without inferring a withdrawal. */
  public void excludeSubmission(UUID id, String code, String reason, Instant now) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() != Status.SUBMITTING && batch.status() != Status.UNRESOLVED) return;
          release(batch, batch.requests(), null, null, null, now);
          finishAttempt(batch, Status.REJECTED, code, reason, now);
          clearFamily(batch, now);
        });
  }

  public void confirm(UUID id, Confirmation confirmation) {
    tx.executeWithoutResult(
        s -> {
          Settlement batch = lockBatch(id);
          if (batch.status() == Status.CONFIRMED) return;
          if (batch.status() != Status.SUBMITTING && batch.status() != Status.UNRESOLVED)
            throw new IllegalStateException("Settlement confirmation has no authorized submission");
          if (!batch.requests().equals(confirmation.fills().stream().map(Fill::reference).toList()))
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
          for (Fill fill : confirmation.fills())
            confirmRequest(fill, id, confirmation.updateId(), now);
          clearFamily(batch, confirmation.confirmedAt());
          sql.sql(
                  """
                  UPDATE pool_queues SET active_settlement_id=NULL,updated_at=?
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
          List<QueueRequest> requests = queue(poolId);
          var blocked =
              requests.stream()
                  .filter(r -> !r.deferred() && r.status().equals("BLOCKED"))
                  .findFirst()
                  .orElse(null);
          int ready =
              (int)
                  requests.stream()
                      .filter(r -> !r.deferred() && r.status().equals("READY"))
                      .count();
          int pending =
              (int)
                  requests.stream()
                      .filter(
                          r ->
                              Set.of(
                                      "SUBMITTING",
                                      "UNRESOLVED",
                                      "WITHDRAWING",
                                      "WITHDRAWAL_UNRESOLVED",
                                      "RECOVERING",
                                      "RECOVERY_UNRESOLVED")
                                  .contains(r.status()))
                      .count();
          String policyLimit = policyLimitReason(state.policy());
          return new Monitoring(
              poolId,
              state.policy(),
              ready,
              pending,
              policyLimit != null || blocked == null ? null : blocked.reference(),
              policyLimit != null ? policyLimit : blocked == null ? null : blocked.error(),
              requests.stream()
                  .map(QueueRequest::submittedAt)
                  .filter(Objects::nonNull)
                  .min(Instant::compareTo)
                  .orElse(null),
              requests.stream()
                  .map(QueueRequest::settlementDeadline)
                  .min(Instant::compareTo)
                  .orElse(null),
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
            INSERT INTO pool_queues(pool_id,batch_size)
            SELECT pool_id,? FROM pools WHERE pool_id=? ON CONFLICT(pool_id) DO NOTHING
            """)
        .params(Math.min(5, maxBatchSize), poolId)
        .update();
  }

  private record QueueState(Policy policy, UUID activeId, String lastProcessedFamily) {}

  private QueueState lockQueue(String poolId) {
    ensureQueue(poolId);
    var state =
        sql.sql("SELECT * FROM pool_queues WHERE pool_id=? FOR UPDATE")
            .param(poolId)
            .query(
                (r, n) ->
                    new QueueState(
                        readPolicy(r, n),
                        r.getObject("active_settlement_id", UUID.class),
                        r.getString("last_processed_family")))
            .optional()
            .orElseThrow(NoSuchElementException::new);
    for (String family : FAMILIES) {
      sql.sql(
              "INSERT INTO pool_request_queues(pool_id,family) SELECT pool_id,? FROM pools WHERE"
                  + " pool_id=? ON CONFLICT DO NOTHING")
          .params(family, poolId)
          .update();
    }
    return state;
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
    for (String family : FAMILIES) {
      String table = family.equals("swap") ? "swap_requests" : "liquidity_requests";
      String kind =
          family.equals("swap") ? "" : " AND kind='" + family.toUpperCase(Locale.ROOT) + "'";
      int changed =
          sql.sql(
                  """
                  UPDATE %s SET status='EXPIRED',error_code='DEADLINE_PASSED',
                    error='Settlement deadline passed. Recover the locked allocations.',updated_at=?
                  WHERE terms->>'poolId'=? AND status IN ('READY','BLOCKED')
                    AND (terms->>'settlementDeadline')::timestamptz<=?
                  """
                          .formatted(table)
                      + kind)
              .params(Timestamp.from(now), poolId, Timestamp.from(now))
              .update();
      if (changed > 0)
        sql.sql(
                "UPDATE pool_request_queues SET blocked_version=NULL,updated_at=? WHERE pool_id=?"
                    + " AND family=?")
            .params(Timestamp.from(now), poolId, family)
            .update();
    }
  }

  private void blockFamily(Settlement batch, String version, Instant now) {
    sql.sql(
            "UPDATE pool_request_queues SET blocked_version=?,updated_at=? WHERE pool_id=? AND"
                + " family=?")
        .params(version, Timestamp.from(now), batch.poolId(), batch.requests().getFirst().type())
        .update();
  }

  private void clearFamily(Settlement batch, Instant now) {
    sql.sql(
            "UPDATE pool_request_queues SET blocked_version=NULL,updated_at=? WHERE pool_id=? AND"
                + " family=?")
        .params(Timestamp.from(now), batch.poolId(), batch.requests().getFirst().type())
        .update();
  }

  private void release(
      Settlement batch,
      List<RequestRef> ids,
      RequestRef blockedId,
      String code,
      String reason,
      Instant now) {
    for (RequestRef request : ids)
      sql.sql(
              """
              UPDATE %s SET
                status=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=? THEN 'EXPIRED'
                  WHEN id=? THEN 'BLOCKED' ELSE 'READY' END,
                error_code=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=? THEN 'DEADLINE_PASSED'
                  WHEN id=? THEN ? ELSE NULL END,
                error=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=?
                  THEN 'Settlement deadline passed. Withdraw the locked allocation.'
                  WHEN id=? THEN ? ELSE NULL END,
                settlement_id=NULL,updated_at=?
              WHERE id=? AND settlement_id=? AND status='SETTLING'
              """
                  .formatted(requestTable(request)))
          .params(
              Timestamp.from(now),
              blockedId == null ? null : blockedId.requestId(),
              Timestamp.from(now),
              blockedId == null ? null : blockedId.requestId(),
              code,
              Timestamp.from(now),
              blockedId == null ? null : blockedId.requestId(),
              reason,
              Timestamp.from(now),
              request.requestId(),
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
            UPDATE pool_queues SET active_settlement_id=NULL,updated_at=?
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
        Arrays.asList(json.readValue(r.getString("requests"), RequestRef[].class)),
        Arrays.asList(json.readValue(r.getString("fills"), Fill[].class)),
        reserves(r.getString("reserves_before")),
        reserves(r.getString("reserves_after")),
        r.getLong("policy_version"),
        r.getTimestamp("created_at").toInstant(),
        r.getTimestamp("updated_at").toInstant(),
        r.getString("update_id"),
        r.getString("error_code"),
        r.getString("error"),
        r.getObject("retry_of", UUID.class));
  }

  private Reserves reserves(String value) {
    return value == null ? null : json.readValue(value, Reserves.class);
  }

  private Pending readPending(ResultSet r, int ignored) throws SQLException {
    Settlement batch = readSettlement(r, ignored);
    List<QueueRequest> requests = batch.requests().stream().map(this::readRequest).toList();
    return new Pending(
        batch,
        requests,
        r.getObject("command_id", UUID.class),
        r.getLong("begin_offset"),
        r.getString("state_version"),
        r.getString("selection") == null
            ? null
            : json.readValue(r.getString("selection"), Selection.class));
  }

  private QueueRequest readRequest(RequestRef ref) {
    return findRequest(ref)
        .orElseThrow(
            () -> new IllegalStateException("Stored settlement request is missing or mismatched"));
  }

  private Optional<QueueRequest> findRequest(RequestRef ref) {
    return sql.sql("SELECT * FROM " + requestTable(ref) + " WHERE id=?")
        .param(ref.requestId())
        .query(
            (r, n) ->
                ref.type().equals("swap")
                    ? (QueueRequest) new SwapRequest(SwapStore.readSwap(r, json))
                    : new LiquidityRequest(LiquidityStore.readRequest(r, json)))
        .optional()
        .filter(request -> request.reference().equals(ref));
  }

  private static String requestTable(RequestRef request) {
    return request.type().equals("swap") ? "swap_requests" : "liquidity_requests";
  }

  private void confirmRequest(Fill fill, UUID settlementId, String updateId, Timestamp now) {
    int changed;
    if (fill instanceof SwapFill swap) {
      changed =
          sql.sql(
                  """
                  UPDATE swap_requests SET status='SETTLED',amount_out=?,update_id=?,error_code=NULL,error=NULL,updated_at=?
                  WHERE id=? AND settlement_id=? AND status IN ('SETTLING','WITHDRAWING','WITHDRAWAL_UNRESOLVED','EXPIRED','SETTLED')
                  """)
              .params(swap.amountOut(), updateId, now, swap.requestId(), settlementId)
              .update();
    } else {
      LiquidityModels.Result result =
          switch (fill) {
            case DepositFill deposit ->
                new LiquidityModels.DepositResult(
                    deposit.actualBaseIn(),
                    deposit.actualQuoteIn(),
                    deposit.actualBaseRefund(),
                    deposit.actualQuoteRefund(),
                    deposit.actualLpOut());
            case WithdrawalFill withdrawal ->
                new LiquidityModels.WithdrawalResult(
                    withdrawal.actualLpBurned(),
                    withdrawal.actualBaseOut(),
                    withdrawal.actualQuoteOut());
            case SwapFill ignored -> throw new IllegalStateException("Unexpected swap fill");
          };
      changed =
          sql.sql(
                  """
                  UPDATE liquidity_requests SET status='SETTLED',result=?::jsonb,update_id=?,error_code=NULL,error=NULL,updated_at=?
                  WHERE id=? AND settlement_id=? AND status IN ('SETTLING','RECOVERING','RECOVERY_UNRESOLVED','EXPIRED','SETTLED')
                  """)
              .params(
                  json.writeValueAsString(result), updateId, now, fill.requestId(), settlementId)
              .update();
    }
    if (changed != 1) throw new IllegalStateException("Conflicting terminal request evidence");
  }
}
