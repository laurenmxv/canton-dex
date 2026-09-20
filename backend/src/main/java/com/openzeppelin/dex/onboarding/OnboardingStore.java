package com.openzeppelin.dex.onboarding;

import com.openzeppelin.dex.iam.*;
import java.sql.*;
import java.text.Normalizer;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

@Repository
public class OnboardingStore {
  private static final String SELECT =
      """
 SELECT o.*, COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'key',step_key,'commandId',command_id,'status',status,'contractId',contract_id,'updateId',update_id,'issuer',issuer)
 ORDER BY CASE WHEN step_key='attestation' THEN 0 ELSE 1 END,step_key)
 FROM onboarding_steps WHERE onboarding_id=o.id),'[]'::jsonb) AS ledger_steps FROM onboardings o
 """;
  private final JdbcClient sql;
  private final ObjectMapper json;
  private final AccountDirectory accounts;
  private final TransactionTemplate transaction;
  private final ExternalParties parties;
  private final OnboardingLedger ledger;

  public OnboardingStore(
      JdbcClient sql,
      ObjectMapper json,
      AccountDirectory accounts,
      PlatformTransactionManager transactions,
      ExternalParties parties,
      OnboardingLedger ledger) {
    this.sql = sql;
    this.json = json;
    this.accounts = accounts;
    this.transaction = new TransactionTemplate(transactions);
    this.parties = parties;
    this.ledger = ledger;
  }

  public Onboarding create(Account caller, OnboardingApplication application) {
    caller.requireRole(Account.Role.TRADER);
    if (accounts.profile(caller).partyId() != null)
      throw new OnboardingConflict("This account already has a party");
    UUID id = UUID.randomUUID();
    sql.sql(
            "INSERT INTO onboardings(id,account_id,application,party_mode) VALUES(?,?,?::jsonb,'external')")
        .params(id, caller.id(), json.writeValueAsString(application))
        .update();
    return getOwned(id, caller);
  }

  public Onboarding getOwned(UUID id, Account caller) {
    caller.requireRole(Account.Role.TRADER);
    return sql.sql(SELECT + " WHERE o.id=? AND o.account_id=?")
        .params(id, caller.id())
        .query(this::map)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public Onboarding mine(Account caller) {
    caller.requireRole(Account.Role.TRADER);
    return sql.sql(SELECT + " WHERE o.account_id=?")
        .param(caller.id())
        .query(this::map)
        .optional()
        .orElse(null);
  }

  Onboarding get(UUID id) {
    return sql.sql(SELECT + " WHERE o.id=?")
        .param(id)
        .query(this::map)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  public List<Onboarding> list(Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return sql.sql(SELECT + " ORDER BY o.created_at,o.id").query(this::map).list();
  }

  public record PoolSummary(String poolId, String name) {}

  public List<PoolSummary> pools() {
    return sql.sql(
            "SELECT pool_id,name FROM pools WHERE package_id=:packageId AND active ORDER BY name,pool_id")
        .param("packageId", ledger.packageId())
        .query((r, i) -> new PoolSummary(r.getString(1), r.getString(2)))
        .list();
  }

  void review(UUID id, Account caller, ReviewDecision decision, String accessToken) {
    caller.requireRole(Account.Role.OPERATOR);
    decision.validate();
    var approved = decision.approvedPoolIds().stream().distinct().sorted().toList();
    transaction.executeWithoutResult(
        tx -> {
          lock(id);
          var current = get(id);
          external(current);
          if (current.review() != null) {
            if (current.review().decision() != decision.decision()
                || !current.review().approvedPoolIds().equals(approved)
                || !Objects.equals(current.review().partyHint(), decision.partyHint()))
              throw new OnboardingConflict("This request already has a different review");
            if (decision.decision() == ReviewDecision.Decision.APPROVED)
              parties.enableUser(caller, accessToken, accounts.get(current.accountId()));
            return;
          }
          var available = pools().stream().map(PoolSummary::poolId).toList();
          if (!available.containsAll(approved))
            throw new IllegalArgumentException("Unknown or incompatible pool");
          if (decision.decision() == ReviewDecision.Decision.APPROVED)
            parties.enableUser(caller, accessToken, accounts.get(current.accountId()));
          sql.sql(
                  "UPDATE onboardings SET review_decision=?,reviewed_by=?,reviewed_at=now(),approved_pools=?::jsonb,party_hint=? WHERE id=?")
              .params(
                  decision.decision().name(),
                  caller.id(),
                  json.writeValueAsString(approved),
                  decision.partyHint(),
                  id)
              .update();
        });
  }

  public Onboarding prepare(UUID id, Account caller, String key, String accessToken) {
    PartySignatures.publicKey(key);
    return transaction.execute(
        tx -> {
          lockOwned(id, caller);
          var current = get(id);
          approved(current);
          if (current.party() != null) {
            if (!current.party().publicKey().equals(key))
              throw new OnboardingConflict("A different key is already prepared");
            return current;
          }
          String synchronizer =
              sql.sql("SELECT synchronizer_id FROM venue_configuration WHERE id=1")
                  .query(String.class)
                  .single();
          String participantId =
              sql.sql("SELECT participant_id FROM venue_configuration WHERE id=1")
                  .query(String.class)
                  .single();
          var prepared =
              parties.prepare(
                  accessToken, current.review().partyHint(), key, synchronizer, participantId);
          sql.sql(
                  """
    UPDATE onboardings SET preparation_id=?,prepared_party_id=?,public_key=?,public_key_fingerprint=?,
      multi_hash=?,synchronizer_id=?,topology_transactions=?::jsonb,prepared_participant_id=?,party_status='PREPARED' WHERE id=?
    """)
              .params(
                  UUID.randomUUID(),
                  prepared.partyId(),
                  key,
                  prepared.fingerprint(),
                  prepared.multiHash(),
                  synchronizer,
                  json.writeValueAsString(prepared.transactions()),
                  prepared.participantId(),
                  id)
              .update();
          return get(id);
        });
  }

  boolean claimParty(UUID id, Account caller, PartySubmission submission) {
    return transaction.execute(
        tx -> {
          lockOwned(id, caller);
          var current = get(id);
          approved(current);
          if (current.party() == null
              || !current.party().preparationId().equals(submission.preparationId()))
            throw new OnboardingConflict("Preparation does not belong to this onboarding");
          PartySignatures.verify(current.party(), submission.signature());
          return sql.sql(
                      "UPDATE onboardings SET party_status='SUBMITTING' WHERE id=? AND party_status='PREPARED'")
                  .param(id)
                  .update()
              == 1;
        });
  }

  List<String> topology(UUID id) {
    return List.of(
        json.readValue(
            sql.sql("SELECT topology_transactions::text FROM onboardings WHERE id=?")
                .param(id)
                .query(String.class)
                .single(),
            String[].class));
  }

  void confirmParty(UUID id) {
    transaction.executeWithoutResult(
        tx -> {
          lock(id);
          var current = get(id);
          approved(current);
          if (current.party().confirmed()) return;
          if (!Set.of("SUBMITTING", "UNRESOLVED").contains(current.party().status()))
            throw new OnboardingConflict("Party was not submitted");
          accounts.bindParty(current.accountId(), current.party().partyId());
          sql.sql(
                  "UPDATE onboardings SET party_confirmed_at=now(),party_status='CONFIRMED' WHERE id=?")
              .param(id)
              .update();
        });
  }

  void deniedParty(UUID id) {
    sql.sql(
            "UPDATE onboardings SET party_status='PREPARED' WHERE id=? AND party_status='SUBMITTING'")
        .param(id)
        .update();
  }

  void unresolvedParty(UUID id) {
    sql.sql(
            "UPDATE onboardings SET party_status='UNRESOLVED' WHERE id=? AND party_status='SUBMITTING'")
        .param(id)
        .update();
  }

  List<UUID> pending() {
    return sql.sql(
            """
   SELECT o.id FROM onboardings o WHERE party_mode='external' AND review_decision='APPROVED'
    AND (party_status IN ('SUBMITTING','UNRESOLVED') OR
      (party_status='CONFIRMED' AND (NOT EXISTS(SELECT 1 FROM onboarding_steps s WHERE s.onboarding_id=o.id)
       OR EXISTS(SELECT 1 FROM onboarding_steps s WHERE s.onboarding_id=o.id AND s.status<>'CONFIRMED'))))
   ORDER BY created_at LIMIT 100
   """)
        .query(UUID.class)
        .list();
  }

  void initializeLedgerSteps(UUID id) {
    transaction.executeWithoutResult(
        tx -> {
          lock(id);
          var current = get(id);
          if (current.review() == null
              || current.review().decision() != ReviewDecision.Decision.APPROVED
              || current.party() == null
              || !current.party().confirmed()
              || !current.partyMode().equals("external")) return;
          insertStep(id, "attestation");
          for (String pool : current.review().approvedPoolIds()) insertStep(id, "access:" + pool);
        });
  }

  private void insertStep(UUID id, String key) {
    sql.sql(
            "INSERT INTO onboarding_steps(onboarding_id,step_key,command_id,status) VALUES(?,?,?,'PENDING') ON CONFLICT(onboarding_id,step_key) DO NOTHING")
        .params(id, key, UUID.randomUUID())
        .update();
  }

  boolean claim(UUID id, LedgerStep step, long beginOffset) {
    return sql.sql(
                "UPDATE onboarding_steps SET status='SUBMITTING',begin_offset=? WHERE onboarding_id=? AND step_key=? AND status='PENDING'")
            .params(beginOffset, id, step.key())
            .update()
        == 1;
  }

  Long beginOffset(UUID id, LedgerStep step) {
    return sql.sql("SELECT begin_offset FROM onboarding_steps WHERE onboarding_id=? AND step_key=?")
        .params(id, step.key())
        .query((r, i) -> r.getObject(1, Long.class))
        .single();
  }

  void confirmed(UUID id, LedgerStep step, OnboardingLedger.Confirmation result) {
    sql.sql(
            "UPDATE onboarding_steps SET status='CONFIRMED',contract_id=?,update_id=?,issuer=? WHERE onboarding_id=? AND step_key=? AND status IN ('SUBMITTING','UNRESOLVED')")
        .params(result.contractId(), result.updateId(), result.issuer(), id, step.key())
        .update();
  }

  void unresolved(UUID id, LedgerStep step) {
    sql.sql(
            "UPDATE onboarding_steps SET status='UNRESOLVED' WHERE onboarding_id=? AND step_key=? AND status='SUBMITTING'")
        .params(id, step.key())
        .update();
  }

  private void lock(UUID id) {
    sql.sql("SELECT id FROM onboardings WHERE id=? FOR UPDATE")
        .param(id)
        .query(UUID.class)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  private void lockOwned(UUID id, Account caller) {
    caller.requireRole(Account.Role.TRADER);
    sql.sql("SELECT id FROM onboardings WHERE id=? AND account_id=? FOR UPDATE")
        .params(id, caller.id())
        .query(UUID.class)
        .optional()
        .orElseThrow(NoSuchElementException::new);
  }

  private static void external(Onboarding current) {
    if (!current.partyMode().equals("external"))
      throw new OnboardingConflict("Historical participant-test requests are read-only");
  }

  private static void approved(Onboarding current) {
    external(current);
    if (current.review() == null || current.review().decision() != ReviewDecision.Decision.APPROVED)
      throw new OnboardingConflict("Approval is required before external party registration");
  }

  static String suggestHint(String name) {
    String hint =
        Normalizer.normalize(name, Normalizer.Form.NFD)
            .replaceAll("\\p{M}", "")
            .toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "_")
            .replaceAll("^_+|_+$", "");
    if (hint.isEmpty() || !Character.isLetter(hint.charAt(0))) hint = "trader_" + hint;
    return hint.substring(0, Math.min(64, hint.length()));
  }

  private Onboarding map(ResultSet row, int index) throws SQLException {
    var application = json.readValue(row.getString("application"), OnboardingApplication.class);
    var steps = List.of(json.readValue(row.getString("ledger_steps"), LedgerStep[].class));
    var review =
        row.getString("review_decision") == null
            ? null
            : new Onboarding.Review(
                ReviewDecision.Decision.valueOf(row.getString("review_decision")),
                List.of(json.readValue(row.getString("approved_pools"), String[].class)),
                row.getObject("reviewed_by", UUID.class),
                row.getTimestamp("reviewed_at").toInstant(),
                row.getString("party_hint"));
    var preparationId = row.getObject("preparation_id", UUID.class);
    var party =
        preparationId == null
            ? null
            : new Onboarding.PartyPreparation(
                preparationId,
                row.getString("prepared_party_id"),
                row.getTimestamp("party_confirmed_at") != null,
                row.getString("public_key"),
                row.getString("public_key_fingerprint"),
                row.getString("multi_hash"),
                row.getString("synchronizer_id"),
                row.getString("party_status"),
                row.getString("prepared_participant_id"),
                row.getString("topology_transactions") == null
                    ? List.of()
                    : List.of(
                        json.readValue(row.getString("topology_transactions"), String[].class)));
    return new Onboarding(
        row.getObject("id", UUID.class),
        row.getObject("account_id", UUID.class),
        application,
        status(review, party, steps),
        row.getString("party_mode"),
        row.getTimestamp("created_at").toInstant(),
        review,
        party,
        steps,
        suggestHint(application.legalName()));
  }

  private static String status(
      Onboarding.Review review, Onboarding.PartyPreparation party, List<LedgerStep> steps) {
    if (review != null && review.decision() == ReviewDecision.Decision.REJECTED) return "REJECTED";
    boolean bound = party != null && party.confirmed();
    if (review == null) return bound ? "AWAITING_REVIEW" : "AWAITING_REVIEW_AND_PARTY";
    if (!bound)
      return party == null
          ? "AWAITING_PARTY"
          : switch (party.status()) {
            case "SUBMITTING" -> "PARTY_SUBMITTING";
            case "UNRESOLVED" -> "PARTY_UNRESOLVED";
            default -> "AWAITING_PARTY";
          };
    if (steps.stream().anyMatch(s -> s.status() == LedgerStep.Status.UNRESOLVED))
      return "LEDGER_UNRESOLVED";
    if (steps.stream().anyMatch(s -> s.status() == LedgerStep.Status.SUBMITTING))
      return "LEDGER_SUBMITTING";
    return !steps.isEmpty()
            && steps.stream().allMatch(s -> s.status() == LedgerStep.Status.CONFIRMED)
        ? "COMPLETED"
        : "LEDGER_PENDING";
  }
}
