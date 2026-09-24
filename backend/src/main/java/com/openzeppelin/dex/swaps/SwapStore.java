package com.openzeppelin.dex.swaps;

import static com.openzeppelin.dex.swaps.SwapModels.*;

import com.openzeppelin.dex.iam.Account;
import java.sql.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

@Repository
public class SwapStore {
  private final JdbcClient sql;
  private final ObjectMapper json;
  private final TransactionTemplate tx;
  private final int defaultBatchSize;

  public SwapStore(
      JdbcClient sql,
      ObjectMapper json,
      PlatformTransactionManager manager,
      @Value("${dex.settlements.max-batch-size:10}") int maxBatchSize) {
    if (maxBatchSize < 1) throw new IllegalArgumentException("Maximum batch size must be positive");
    defaultBatchSize = Math.min(5, maxBatchSize);
    this.sql = sql;
    this.json = json;
    this.tx = new TransactionTemplate(manager);
  }

  public void saveQuote(Quote quote, Account caller) {
    sql.sql("INSERT INTO swap_quotes(id,account_id,payload,expires_at) VALUES(?,?,?::jsonb,?)")
        .params(
            quote.quoteId(),
            caller.id(),
            json.writeValueAsString(quote),
            Timestamp.from(quote.quoteExpiresAt()))
        .update();
  }

  public Quote quote(UUID id, Account caller) {
    return sql.sql("SELECT payload FROM swap_quotes WHERE id=? AND account_id=?")
        .params(id, caller.id())
        .query((r, n) -> json.readValue(r.getString(1), Quote.class))
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Optional<Pending> preparedQuote(UUID quoteId, Account caller) {
    return sql.sql(
            "SELECT p.id FROM swap_preparations p JOIN swap_requests s ON s.id=p.swap_id WHERE"
                + " s.quote_id=? AND s.account_id=? AND p.action='SUBMIT'")
        .params(quoteId, caller.id())
        .query(UUID.class)
        .optional()
        .map(this::pending);
  }

  public Pending savePreparation(
      UUID swapId,
      UUID preparationId,
      UUID commandId,
      UUID quoteId,
      Account caller,
      Terms terms,
      SigningPayload signing) {
    return tx.execute(
        s -> {
          sql.sql(
                  "INSERT INTO swap_requests(id,account_id,quote_id,terms,status)"
                      + " VALUES(?,?,?,?::jsonb,'PREPARED') ON CONFLICT(quote_id) DO NOTHING")
              .params(swapId, caller.id(), quoteId, json.writeValueAsString(terms))
              .update();
          UUID actual =
              sql.sql("SELECT id FROM swap_requests WHERE quote_id=? AND account_id=? FOR UPDATE")
                  .params(quoteId, caller.id())
                  .query(UUID.class)
                  .single();
          if (actual.equals(swapId)) {
            insertPreparation(preparationId, swapId, commandId, Action.SUBMIT, signing);
          }
          return preparedQuote(quoteId, caller).orElseThrow();
        });
  }

  public Optional<Pending> latestWithdrawal(UUID swapId, Account caller) {
    owned(swapId, caller);
    return sql.sql(
            "SELECT id FROM swap_preparations WHERE swap_id=? AND action='WITHDRAW' AND"
                + " status<>'FAILED' ORDER BY created_at DESC,id DESC LIMIT 1")
        .param(swapId)
        .query(UUID.class)
        .optional()
        .map(this::pending);
  }

  public Pending saveWithdrawal(
      UUID swapId,
      UUID preparationId,
      UUID commandId,
      Account caller,
      SigningPayload signing,
      Instant now) {
    return tx.execute(
        s -> {
          ownedLocked(swapId, caller);
          var previous = latestWithdrawal(swapId, caller);
          if (previous.isPresent()) {
            var p = previous.get();
            if (p.signature() != null || p.signing().expiresAt().isAfter(now)) return p;
          }
          insertPreparation(preparationId, swapId, commandId, Action.WITHDRAW, signing);
          return pending(preparationId);
        });
  }

  private void insertPreparation(
      UUID id, UUID swapId, UUID commandId, Action action, SigningPayload signing) {
    sql.sql(
            "INSERT INTO swap_preparations(id,swap_id,command_id,action,signing,status)"
                + " VALUES(?,?,?,?,?::jsonb,'PREPARED')")
        .params(id, swapId, commandId, action.name(), json.writeValueAsString(signing))
        .update();
  }

  /** The queue row is locked before the request, matching settlement's lock order. */
  public boolean begin(
      UUID preparationId, Account caller, String signature, long offset, Instant now) {
    var p = pendingOwned(preparationId, caller);
    return Boolean.TRUE.equals(
        tx.execute(
            s -> {
              String poolId = p.swap().poolId();
              sql.sql("INSERT INTO pool_queues(pool_id) VALUES(?) ON CONFLICT DO" + " NOTHING")
                  .param(poolId)
                  .update();
              sql.sql("SELECT pool_id FROM pool_queues WHERE pool_id=? FOR UPDATE")
                  .param(poolId)
                  .query(String.class)
                  .single();
              String family = "swap";
              sql.sql(
                      "INSERT INTO pool_request_queues(pool_id,family,batch_size) VALUES(?,?,?) ON CONFLICT DO"
                          + " NOTHING")
                  .params(poolId, family, defaultBatchSize)
                  .update();
              ownedLocked(p.swap().swapId(), caller);
              String previousStatus =
                  sql.sql("SELECT status FROM swap_preparations WHERE id=? FOR UPDATE")
                      .param(preparationId)
                      .query(String.class)
                      .single();
              var current = pending(preparationId);
              if (current.signature() != null && !current.signature().equals(signature))
                throw SwapFailure.conflict(
                    "IDEMPOTENCY_CONFLICT", "This preparation already has a different signature");
              if (!previousStatus.equals("PREPARED")) return false;
              if (!current.signing().expiresAt().isAfter(now))
                throw SwapFailure.conflict(
                    "PREPARATION_EXPIRED", "Request a new quote and sign a new transaction");
              if (p.action() == Action.SUBMIT) {
                if (current.swap().status() != Status.PREPARED)
                  throw SwapFailure.conflict(
                      "INVALID_SWAP_STATE", "The swap is no longer awaiting submission");
                if (!current.swap().settlementDeadline().isAfter(now))
                  throw SwapFailure.conflict(
                      "DEADLINE_ELAPSED", "The settlement deadline has elapsed");
                long sequence =
                    sql.sql(
                            "UPDATE pool_request_queues SET next_sequence=next_sequence+1 WHERE"
                                + " pool_id=? AND family=? RETURNING next_sequence")
                        .params(poolId, family)
                        .query(Long.class)
                        .single();
                sql.sql(
                        "UPDATE swap_requests SET"
                            + " status='SUBMITTING',arrival_sequence=?,submitted_at=?,updated_at=?,error_code=NULL,error=NULL"
                            + " WHERE id=?")
                    .params(
                        sequence, Timestamp.from(now), Timestamp.from(now), current.swap().swapId())
                    .update();
              } else {
                if (!current.swap().canWithdraw())
                  throw SwapFailure.conflict(
                      "WITHDRAWAL_UNAVAILABLE", "This swap cannot be withdrawn now");
                sql.sql(
                        "UPDATE swap_requests SET"
                            + " status='WITHDRAWING',updated_at=?,error_code=NULL,error=NULL WHERE"
                            + " id=?")
                    .params(Timestamp.from(now), current.swap().swapId())
                    .update();
              }
              // Include any earlier direct wallet withdrawal of this request's allocations.
              long historyOffset =
                  p.action() == Action.WITHDRAW
                      ? sql.sql(
                              "SELECT begin_offset FROM swap_preparations WHERE swap_id=? AND"
                                  + " action='SUBMIT' AND status='CONFIRMED'")
                          .param(current.swap().swapId())
                          .query(Long.class)
                          .single()
                      : offset;
              sql.sql(
                      "UPDATE swap_preparations SET"
                          + " status='SUBMITTING',signature=?,begin_offset=?,updated_at=? WHERE"
                          + " id=?")
                  .params(signature, historyOffset, Timestamp.from(now), preparationId)
                  .update();
              return true;
            }));
  }

  public void confirm(UUID preparationId, Confirmation c) {
    if (!Set.of(Status.READY, Status.SETTLED, Status.WITHDRAWN, Status.EXPIRED)
        .contains(c.status()))
      throw new IllegalStateException("Unexpected ledger confirmation status");
    tx.executeWithoutResult(
        s -> {
          var p = pending(preparationId);
          lockQueue(p.swap().poolId());
          var current =
              sql.sql("SELECT status FROM swap_requests WHERE id=? FOR UPDATE")
                  .param(p.swap().swapId())
                  .query(String.class)
                  .single();
          if (Set.of("SETTLED", "WITHDRAWN").contains(current)
              && !current.equals(c.status().name())) {
            // A late TX1 observation must not undo a subsequent settlement or withdrawal.
            if (c.status() == Status.READY || c.status() == Status.EXPIRED) {
              finishPreparation(preparationId);
              return;
            }
            throw new IllegalStateException("Conflicting terminal ledger evidence");
          }
          if (c.status() == Status.READY
              && !Set.of("SUBMITTING", "UNRESOLVED", "READY").contains(current)) {
            finishPreparation(preparationId);
            return;
          }
          sql.sql(
                  "UPDATE swap_requests SET"
                      + " status=?,allocation_cids=?::jsonb,amount_out=COALESCE(?,amount_out),update_id=?,updated_at=?,error_code=NULL,error=NULL"
                      + " WHERE id=?")
              .params(
                  c.status().name(),
                  json.writeValueAsString(c.allocationCids()),
                  c.amountOut(),
                  c.updateId(),
                  Timestamp.from(c.confirmedAt()),
                  p.swap().swapId())
              .update();
          finishPreparation(preparationId);
          if (c.status() == Status.SETTLED || c.status() == Status.WITHDRAWN)
            sql.sql(
                    "UPDATE pool_request_queues SET blocked_version=NULL WHERE pool_id=? AND"
                        + " family='swap'")
                .param(p.swap().poolId())
                .update();
        });
  }

  private void finishPreparation(UUID id) {
    sql.sql("UPDATE swap_preparations SET status='CONFIRMED',updated_at=now() WHERE id=?")
        .param(id)
        .update();
  }

  public void uncertain(UUID preparationId) {
    tx.executeWithoutResult(
        s -> {
          var p = pending(preparationId);
          lockQueue(p.swap().poolId());
          sql.sql(
                  "UPDATE swap_preparations SET status='UNRESOLVED',updated_at=now() WHERE id=? AND"
                      + " status='SUBMITTING'")
              .param(preparationId)
              .update();
          sql.sql(
                  "UPDATE swap_requests SET"
                      + " status=?,error_code='CONFIRMATION_PENDING',error='Waiting for ledger"
                      + " confirmation',updated_at=now() WHERE id=? AND status=?")
              .params(
                  p.action() == Action.SUBMIT ? "UNRESOLVED" : "WITHDRAWAL_UNRESOLVED",
                  p.swap().swapId(),
                  p.action() == Action.SUBMIT ? "SUBMITTING" : "WITHDRAWING")
              .update();
        });
  }

  public void rejected(UUID preparationId, LedgerRejected failure) {
    tx.executeWithoutResult(
        s -> {
          var p = pending(preparationId);
          lockQueue(p.swap().poolId());
          int changed =
              sql.sql(
                      "UPDATE swap_preparations SET status='FAILED',updated_at=now() WHERE id=? AND"
                          + " status IN ('SUBMITTING','UNRESOLVED')")
                  .param(preparationId)
                  .update();
          if (changed == 0) return;
          sql.sql(
                  "UPDATE swap_requests SET status=?,error_code=?,error=?,updated_at=now() WHERE"
                      + " id=? AND status IN"
                      + " ('SUBMITTING','UNRESOLVED','WITHDRAWING','WITHDRAWAL_UNRESOLVED')")
              .params(
                  p.action() == Action.SUBMIT ? "FAILED" : "EXPIRED",
                  failure.code(),
                  failure.getMessage(),
                  p.swap().swapId())
              .update();
          sql.sql(
                  "UPDATE pool_request_queues SET blocked_version=NULL WHERE pool_id=? AND"
                      + " family='swap'")
              .param(p.swap().poolId())
              .update();
        });
  }

  public List<Pending> unresolved() {
    return sql
        .sql(
            "SELECT id FROM swap_preparations WHERE status IN ('SUBMITTING','UNRESOLVED') ORDER BY"
                + " created_at,id")
        .query(UUID.class)
        .list()
        .stream()
        .map(this::pending)
        .toList();
  }

  public List<Pending> tracked() {
    return sql
        .sql(
            "SELECT p.id FROM swap_preparations p JOIN swap_requests s ON s.id=p.swap_id WHERE"
                + " p.action='SUBMIT' AND p.status='CONFIRMED' AND s.status IN"
                + " ('READY','BLOCKED','EXPIRED','SETTLING','WITHDRAWING','WITHDRAWAL_UNRESOLVED')"
                + " ORDER BY s.submitted_at,s.id")
        .query(UUID.class)
        .list()
        .stream()
        .map(this::pending)
        .toList();
  }

  public Pending pendingOwned(UUID id, Account caller) {
    var p = pending(id);
    if (!p.accountId().equals(caller.id())) throw new NoSuchElementException();
    return p;
  }

  public Pending pending(UUID id) {
    return sql.sql(
            "SELECT p.*,s.account_id FROM swap_preparations p JOIN swap_requests s ON"
                + " s.id=p.swap_id WHERE p.id=?")
        .param(id)
        .query(
            (r, n) ->
                new Pending(
                    get(r.getObject("swap_id", UUID.class)),
                    r.getObject("account_id", UUID.class),
                    id,
                    r.getObject("command_id", UUID.class),
                    Action.valueOf(r.getString("action")),
                    json.readValue(r.getString("signing"), SigningPayload.class),
                    r.getString("signature"),
                    r.getLong("begin_offset")))
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Swap owned(UUID id, Account caller) {
    return sql.sql("SELECT * FROM swap_requests WHERE id=? AND account_id=?")
        .params(id, caller.id())
        .query((r, n) -> readSwap(r, json))
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  private void ownedLocked(UUID id, Account caller) {
    sql.sql("SELECT id FROM swap_requests WHERE id=? AND account_id=? FOR UPDATE")
        .params(id, caller.id())
        .query(UUID.class)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Swap get(UUID id) {
    return sql.sql("SELECT * FROM swap_requests WHERE id=?")
        .param(id)
        .query((r, n) -> readSwap(r, json))
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Activity activity(Account caller, int limit, String cursor, String status) {
    if (limit < 1 || limit > 100) throw new IllegalArgumentException("Invalid page size");
    UUID before = cursor == null ? null : UUID.fromString(cursor);
    if (status != null) Status.valueOf(status);
    // Cursor ownership is checked before it supplies the paging boundary.
    Instant time = before == null ? null : owned(before, caller).createdAt();
    return activityBefore(caller, limit, time, before, status);
  }

  public Activity activityBefore(
      Account caller, int limit, Instant time, UUID before, String status) {
    if (limit < 1 || limit > 100) throw new IllegalArgumentException("Invalid page size");
    var query = new StringBuilder("SELECT * FROM swap_requests WHERE account_id=?");
    var args = new ArrayList<Object>();
    args.add(caller.id());
    if (status != null) {
      query.append(" AND status=?");
      args.add(status);
    }
    if (before != null) {
      query.append(" AND (created_at,id)<(?,?)");
      args.add(Timestamp.from(time));
      args.add(before);
    }
    query.append(" ORDER BY created_at DESC,id DESC LIMIT ?");
    args.add(limit + 1);
    var rows = sql.sql(query.toString()).params(args).query((r, n) -> readSwap(r, json)).list();
    var items = rows.size() > limit ? rows.subList(0, limit) : rows;
    return new Activity(
        List.copyOf(items), rows.size() > limit ? items.getLast().swapId().toString() : null);
  }

  public static Swap readSwap(ResultSet r, ObjectMapper json) throws SQLException {
    var t = json.readValue(r.getString("terms"), Terms.class);
    var status = Status.valueOf(r.getString("status"));
    var allocations = List.of(json.readValue(r.getString("allocation_cids"), String[].class));
    boolean withdraw =
        !allocations.isEmpty()
            && !t.settlementDeadline().isAfter(Instant.now())
            && !Set.of(
                    Status.SETTLED,
                    Status.WITHDRAWN,
                    Status.WITHDRAWING,
                    Status.WITHDRAWAL_UNRESOLVED)
                .contains(status);
    return new Swap(
        r.getObject("id", UUID.class),
        r.getObject("quote_id", UUID.class),
        t.poolId(),
        t.poolName(),
        t.trader(),
        t.direction(),
        t.inputInstrument(),
        t.outputInstrument(),
        t.amountIn(),
        t.expectedOut(),
        t.feeAmount(),
        t.minOut(),
        t.settlementDeadline(),
        status,
        r.getObject("arrival_sequence", Long.class),
        r.getTimestamp("created_at").toInstant(),
        instant(r.getTimestamp("submitted_at")),
        r.getTimestamp("updated_at").toInstant(),
        r.getObject("settlement_id", UUID.class),
        r.getString("amount_out"),
        allocations,
        r.getString("update_id"),
        r.getString("error_code"),
        r.getString("error"),
        withdraw);
  }

  private static Instant instant(Timestamp timestamp) {
    return timestamp == null ? null : timestamp.toInstant();
  }

  private void lockQueue(String poolId) {
    sql.sql("SELECT pool_id FROM pool_queues WHERE pool_id=? FOR UPDATE")
        .param(poolId)
        .query(String.class)
        .single();
  }
}
