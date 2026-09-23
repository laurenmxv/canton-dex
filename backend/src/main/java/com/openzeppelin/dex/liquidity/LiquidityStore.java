package com.openzeppelin.dex.liquidity;

import static com.openzeppelin.dex.liquidity.LiquidityModels.*;

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
public class LiquidityStore {
  private final JdbcClient sql;
  private final ObjectMapper json;
  private final TransactionTemplate tx;
  private final int defaultBatchSize;

  public LiquidityStore(
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

  public void saveQuote(DepositQuote quote, Account caller) {
    saveQuote(quote.quoteId(), Kind.DEPOSIT, quote, quote.quoteExpiresAt(), caller);
  }

  public void saveQuote(WithdrawalQuote quote, Account caller) {
    saveQuote(quote.quoteId(), Kind.WITHDRAW, quote, quote.quoteExpiresAt(), caller);
  }

  private void saveQuote(UUID id, Kind kind, Object quote, Instant expiry, Account caller) {
    sql.sql(
            "INSERT INTO liquidity_quotes(id,account_id,kind,payload,expires_at)"
                + " VALUES(?,?,?,?::jsonb,?)")
        .params(
            id, caller.id(), kind.name(), json.writeValueAsString(quote), Timestamp.from(expiry))
        .update();
  }

  public DepositQuote depositQuote(UUID id, Account caller) {
    return json.readValue(quote(id, caller, Kind.DEPOSIT), DepositQuote.class);
  }

  public WithdrawalQuote withdrawalQuote(UUID id, Account caller) {
    return json.readValue(quote(id, caller, Kind.WITHDRAW), WithdrawalQuote.class);
  }

  private String quote(UUID id, Account caller, Kind kind) {
    return sql.sql("SELECT payload FROM liquidity_quotes WHERE id=? AND account_id=? AND kind=?")
        .params(id, caller.id(), kind.name())
        .query(String.class)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Optional<Pending> preparedQuote(UUID quoteId, Account caller) {
    return sql.sql(
            "SELECT p.id FROM liquidity_preparations p JOIN liquidity_requests s ON"
                + " s.id=p.request_id WHERE s.quote_id=? AND s.account_id=? AND p.action='SUBMIT'")
        .params(quoteId, caller.id())
        .query(UUID.class)
        .optional()
        .map(this::pending);
  }

  public Pending savePreparation(
      UUID requestId,
      UUID preparationId,
      UUID commandId,
      UUID quoteId,
      Account caller,
      Terms terms,
      SigningPayload signing) {
    return tx.execute(
        s -> {
          sql.sql(
                  "INSERT INTO liquidity_requests(id,account_id,quote_id,kind,terms,status)"
                      + " VALUES(?,?,?,?,?::jsonb,'PREPARED') ON CONFLICT(quote_id) DO NOTHING")
              .params(
                  requestId,
                  caller.id(),
                  quoteId,
                  kind(terms).name(),
                  json.writeValueAsString(terms))
              .update();
          UUID actual =
              sql.sql(
                      "SELECT id FROM liquidity_requests WHERE quote_id=? AND account_id=? FOR"
                          + " UPDATE")
                  .params(quoteId, caller.id())
                  .query(UUID.class)
                  .single();
          if (actual.equals(requestId)) {
            insertPreparation(preparationId, requestId, commandId, Action.SUBMIT, signing);
          }
          return preparedQuote(quoteId, caller).orElseThrow();
        });
  }

  public Optional<Pending> latestRecovery(UUID requestId, Account caller) {
    owned(requestId, caller);
    return sql.sql(
            "SELECT id FROM liquidity_preparations WHERE request_id=? AND action='RECOVER' AND"
                + " status<>'FAILED' ORDER BY created_at DESC,id DESC LIMIT 1")
        .param(requestId)
        .query(UUID.class)
        .optional()
        .map(this::pending);
  }

  public Pending saveRecovery(
      UUID requestId,
      UUID preparationId,
      UUID commandId,
      Account caller,
      SigningPayload signing,
      Instant now) {
    return tx.execute(
        s -> {
          ownedLocked(requestId, caller);
          var previous = latestRecovery(requestId, caller);
          if (previous.isPresent()) {
            var p = previous.get();
            if (p.signature() != null || p.signing().expiresAt().isAfter(now)) return p;
          }
          insertPreparation(preparationId, requestId, commandId, Action.RECOVER, signing);
          return pending(preparationId);
        });
  }

  private void insertPreparation(
      UUID id, UUID requestId, UUID commandId, Action action, SigningPayload signing) {
    sql.sql(
            "INSERT INTO liquidity_preparations(id,request_id,command_id,action,signing,status)"
                + " VALUES(?,?,?,?,?::jsonb,'PREPARED')")
        .params(id, requestId, commandId, action.name(), json.writeValueAsString(signing))
        .update();
  }

  /** The queue row is locked before the request, matching settlement's lock order. */
  public boolean begin(
      UUID preparationId, Account caller, String signature, long offset, Instant now) {
    var p = pendingOwned(preparationId, caller);
    return Boolean.TRUE.equals(
        tx.execute(
            s -> {
              String poolId = p.request().terms().poolId();
              sql.sql(
                      "INSERT INTO pool_queues(pool_id,batch_size) VALUES(?,?) ON CONFLICT DO"
                          + " NOTHING")
                  .params(poolId, defaultBatchSize)
                  .update();
              sql.sql("SELECT pool_id FROM pool_queues WHERE pool_id=? FOR UPDATE")
                  .param(poolId)
                  .query(String.class)
                  .single();
              String family = p.request().kind() == Kind.DEPOSIT ? "deposit" : "withdraw";
              sql.sql(
                      "INSERT INTO pool_request_queues(pool_id,family) VALUES(?,?) ON CONFLICT DO"
                          + " NOTHING")
                  .params(poolId, family)
                  .update();
              ownedLocked(p.request().requestId(), caller);
              String previousStatus =
                  sql.sql("SELECT status FROM liquidity_preparations WHERE id=? FOR UPDATE")
                      .param(preparationId)
                      .query(String.class)
                      .single();
              var current = pending(preparationId);
              if (current.signature() != null && !current.signature().equals(signature))
                throw new LiquidityFailure(
                    "IDEMPOTENCY_CONFLICT", "This preparation already has a different signature");
              if (!previousStatus.equals("PREPARED")) return false;
              if (!current.signing().expiresAt().isAfter(now))
                throw new LiquidityFailure(
                    "PREPARATION_EXPIRED", "Request a new quote and sign a new transaction");
              if (p.action() == Action.SUBMIT) {
                if (current.request().status() != Status.PREPARED)
                  throw new LiquidityFailure(
                      "INVALID_REQUEST_STATE", "The request is no longer awaiting submission");
                if (!current.request().terms().settlementDeadline().isAfter(now))
                  throw new LiquidityFailure(
                      "DEADLINE_ELAPSED", "The settlement deadline has elapsed");
                long sequence =
                    sql.sql(
                            "UPDATE pool_request_queues SET next_sequence=next_sequence+1 WHERE"
                                + " pool_id=? AND family=? RETURNING next_sequence")
                        .params(poolId, family)
                        .query(Long.class)
                        .single();
                sql.sql(
                        "UPDATE liquidity_requests SET"
                            + " status='SUBMITTING',arrival_sequence=?,submitted_at=?,updated_at=?,error_code=NULL,error=NULL"
                            + " WHERE id=?")
                    .params(
                        sequence,
                        Timestamp.from(now),
                        Timestamp.from(now),
                        current.request().requestId())
                    .update();
              } else {
                if (!current.request().canRecover())
                  throw new LiquidityFailure(
                      "RECOVERY_UNAVAILABLE", "This request cannot be withdrawn now");
                sql.sql(
                        "UPDATE liquidity_requests SET"
                            + " status='RECOVERING',updated_at=?,error_code=NULL,error=NULL WHERE"
                            + " id=?")
                    .params(Timestamp.from(now), current.request().requestId())
                    .update();
              }
              // Include any earlier direct wallet withdrawal of this request's allocations.
              long historyOffset =
                  p.action() == Action.RECOVER
                      ? sql.sql(
                              "SELECT begin_offset FROM liquidity_preparations WHERE request_id=?"
                                  + " AND action='SUBMIT' AND status='CONFIRMED'")
                          .param(current.request().requestId())
                          .query(Long.class)
                          .single()
                      : offset;
              sql.sql(
                      "UPDATE liquidity_preparations SET"
                          + " status='SUBMITTING',signature=?,begin_offset=?,updated_at=? WHERE"
                          + " id=?")
                  .params(signature, historyOffset, Timestamp.from(now), preparationId)
                  .update();
              return true;
            }));
  }

  public void confirm(UUID preparationId, Confirmation c) {
    if (!Set.of(Status.READY, Status.SETTLED, Status.RECOVERED, Status.EXPIRED)
        .contains(c.status()))
      throw new IllegalStateException("Unexpected ledger confirmation status");
    tx.executeWithoutResult(
        s -> {
          var p = pending(preparationId);
          lockQueue(p.request().terms().poolId());
          var current =
              sql.sql("SELECT status FROM liquidity_requests WHERE id=? FOR UPDATE")
                  .param(p.request().requestId())
                  .query(String.class)
                  .single();
          if (Set.of("SETTLED", "RECOVERED").contains(current)
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
                  "UPDATE liquidity_requests SET"
                      + " status=?,allocation_cids=?::jsonb,result=COALESCE(?::jsonb,result),update_id=?,updated_at=?,error_code=NULL,error=NULL"
                      + " WHERE id=?")
              .params(
                  c.status().name(),
                  json.writeValueAsString(c.allocationCids()),
                  c.result() == null ? null : json.writeValueAsString(c.result()),
                  c.updateId(),
                  Timestamp.from(c.confirmedAt()),
                  p.request().requestId())
              .update();
          finishPreparation(preparationId);
          if (c.status() == Status.SETTLED || c.status() == Status.RECOVERED)
            sql.sql(
                    "UPDATE pool_request_queues SET blocked_version=NULL WHERE pool_id=? AND"
                        + " family=?")
                .params(
                    p.request().terms().poolId(),
                    p.request().kind() == Kind.DEPOSIT ? "deposit" : "withdraw")
                .update();
        });
  }

  private void finishPreparation(UUID id) {
    sql.sql("UPDATE liquidity_preparations SET status='CONFIRMED',updated_at=now() WHERE id=?")
        .param(id)
        .update();
  }

  public void uncertain(UUID preparationId) {
    tx.executeWithoutResult(
        s -> {
          var p = pending(preparationId);
          lockQueue(p.request().terms().poolId());
          sql.sql(
                  "UPDATE liquidity_preparations SET status='UNRESOLVED',updated_at=now() WHERE"
                      + " id=? AND status='SUBMITTING'")
              .param(preparationId)
              .update();
          sql.sql(
                  "UPDATE liquidity_requests SET"
                      + " status=?,error_code='CONFIRMATION_PENDING',error='Waiting for ledger"
                      + " confirmation',updated_at=now() WHERE id=? AND status=?")
              .params(
                  p.action() == Action.SUBMIT ? "UNRESOLVED" : "RECOVERY_UNRESOLVED",
                  p.request().requestId(),
                  p.action() == Action.SUBMIT ? "SUBMITTING" : "RECOVERING")
              .update();
        });
  }

  public void rejected(UUID preparationId, LiquidityLedger.Rejected failure) {
    tx.executeWithoutResult(
        s -> {
          var p = pending(preparationId);
          lockQueue(p.request().terms().poolId());
          int changed =
              sql.sql(
                      "UPDATE liquidity_preparations SET status='FAILED',updated_at=now() WHERE"
                          + " id=? AND status IN ('SUBMITTING','UNRESOLVED')")
                  .param(preparationId)
                  .update();
          if (changed == 0) return;
          sql.sql(
                  "UPDATE liquidity_requests SET status=?,error_code=?,error=?,updated_at=now()"
                      + " WHERE id=? AND status IN"
                      + " ('SUBMITTING','UNRESOLVED','RECOVERING','RECOVERY_UNRESOLVED')")
              .params(
                  p.action() == Action.SUBMIT ? "FAILED" : "EXPIRED",
                  failure.code(),
                  failure.getMessage(),
                  p.request().requestId())
              .update();
          sql.sql(
                  "UPDATE pool_request_queues SET blocked_version=NULL WHERE pool_id=? AND"
                      + " family=?")
              .params(
                  p.request().terms().poolId(),
                  p.request().kind() == Kind.DEPOSIT ? "deposit" : "withdraw")
              .update();
        });
  }

  public List<Pending> unresolved() {
    return sql
        .sql(
            "SELECT id FROM liquidity_preparations WHERE status IN ('SUBMITTING','UNRESOLVED')"
                + " ORDER BY created_at,id")
        .query(UUID.class)
        .list()
        .stream()
        .map(this::pending)
        .toList();
  }

  public List<Pending> tracked() {
    return sql
        .sql(
            "SELECT p.id FROM liquidity_preparations p JOIN liquidity_requests s ON"
                + " s.id=p.request_id WHERE p.action='SUBMIT' AND p.status='CONFIRMED' AND s.status"
                + " IN ('READY','BLOCKED','EXPIRED','SETTLING','RECOVERING','RECOVERY_UNRESOLVED')"
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
            "SELECT p.*,s.account_id FROM liquidity_preparations p JOIN liquidity_requests s ON"
                + " s.id=p.request_id WHERE p.id=?")
        .param(id)
        .query(
            (r, n) ->
                new Pending(
                    get(r.getObject("request_id", UUID.class)),
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

  public Request owned(UUID id, Account caller) {
    return sql.sql("SELECT * FROM liquidity_requests WHERE id=? AND account_id=?")
        .params(id, caller.id())
        .query((r, n) -> readRequest(r, json))
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  private void ownedLocked(UUID id, Account caller) {
    sql.sql("SELECT id FROM liquidity_requests WHERE id=? AND account_id=? FOR UPDATE")
        .params(id, caller.id())
        .query(UUID.class)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Request get(UUID id) {
    return sql.sql("SELECT * FROM liquidity_requests WHERE id=?")
        .param(id)
        .query((r, n) -> readRequest(r, json))
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Activity activity(Account caller, Kind kind, int limit, String cursor, String status) {
    if (limit < 1 || limit > 100) throw new IllegalArgumentException("Invalid page size");
    UUID before = cursor == null ? null : UUID.fromString(cursor);
    if (status != null) Status.valueOf(status);
    // Cursor ownership is checked before it supplies the paging boundary.
    Instant time = before == null ? null : owned(before, caller).createdAt();
    return activityBefore(caller, kind, limit, time, before, status);
  }

  public Activity activityBefore(
      Account caller, Kind kind, int limit, Instant time, UUID before, String status) {
    if (limit < 1 || limit > 100) throw new IllegalArgumentException("Invalid page size");
    var query = new StringBuilder("SELECT * FROM liquidity_requests WHERE account_id=?");
    var args = new ArrayList<Object>();
    args.add(caller.id());
    if (kind != null) {
      query.append(" AND kind=?");
      args.add(kind.name());
    }
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
    var rows = sql.sql(query.toString()).params(args).query((r, n) -> readRequest(r, json)).list();
    var items = rows.size() > limit ? rows.subList(0, limit) : rows;
    return new Activity(
        List.copyOf(items), rows.size() > limit ? items.getLast().requestId().toString() : null);
  }

  public static Request readRequest(ResultSet r, ObjectMapper json) throws SQLException {
    var kind = Kind.valueOf(r.getString("kind"));
    Terms terms =
        kind == Kind.DEPOSIT
            ? json.readValue(r.getString("terms"), DepositTerms.class)
            : json.readValue(r.getString("terms"), WithdrawalTerms.class);
    String resultJson = r.getString("result");
    Result result =
        resultJson == null
            ? null
            : kind == Kind.DEPOSIT
                ? json.readValue(resultJson, DepositResult.class)
                : json.readValue(resultJson, WithdrawalResult.class);
    var status = Status.valueOf(r.getString("status"));
    var allocations = List.of(json.readValue(r.getString("allocation_cids"), String[].class));
    boolean canRecover =
        !allocations.isEmpty()
            && !terms.settlementDeadline().isAfter(Instant.now())
            && Set.of(Status.READY, Status.BLOCKED, Status.SETTLING, Status.EXPIRED)
                .contains(status);
    return new Request(
        r.getObject("id", UUID.class),
        r.getObject("quote_id", UUID.class),
        kind,
        terms,
        status,
        r.getObject("arrival_sequence", Long.class),
        r.getTimestamp("created_at").toInstant(),
        instant(r.getTimestamp("submitted_at")),
        r.getTimestamp("updated_at").toInstant(),
        r.getObject("settlement_id", UUID.class),
        result,
        allocations,
        r.getString("update_id"),
        r.getString("error_code"),
        r.getString("error"),
        canRecover);
  }

  static Kind kind(Terms terms) {
    return terms instanceof DepositTerms ? Kind.DEPOSIT : Kind.WITHDRAW;
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
