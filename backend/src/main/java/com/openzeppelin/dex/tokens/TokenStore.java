package com.openzeppelin.dex.tokens;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.onboarding.Onboarding;
import com.openzeppelin.dex.tokens.TokenModels.*;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class TokenStore {
  private final JdbcClient sql;

  public TokenStore(JdbcClient sql) {
    this.sql = sql;
  }

  public Registry registry() {
    return sql.sql(
            "SELECT"
                + " issuer_party_id,rules_id,package_id,faucet_factory_id,rules_created_event_blob,synchronizer_id"
                + " FROM test_token_configuration WHERE id=1")
        .query(
            (r, i) ->
                new Registry(
                    r.getString(1),
                    r.getString(2),
                    r.getString(3),
                    r.getString(4),
                    r.getString(5),
                    r.getString(6)))
        .optional()
        .orElseThrow(() -> new TokenConflict("Test token fixtures are not initialized"));
  }

  public List<Token> tokens() {
    return sql.sql(
            "SELECT symbol,instrument_id,decimals,initial_claim_amount FROM test_token_instruments"
                + " ORDER BY symbol")
        .query(
            (r, i) ->
                new Token(
                    r.getString(1),
                    r.getString(2),
                    r.getInt(3),
                    r.getBigDecimal(4).stripTrailingZeros().toPlainString()))
        .list();
  }

  public Signer signer(Account account) {
    account.requireRole(Account.Role.TRADER);
    return sql.sql(
            """
            SELECT a.subject,o.* FROM accounts a JOIN onboardings o ON o.account_id=a.id
            WHERE a.id=? AND a.party_id=o.prepared_party_id AND o.review_decision='APPROVED'
              AND o.party_mode='external' AND o.party_status='CONFIRMED'
              AND EXISTS (SELECT 1 FROM onboarding_steps s WHERE s.onboarding_id=o.id)
              AND NOT EXISTS (SELECT 1 FROM onboarding_steps s WHERE s.onboarding_id=o.id AND s.status<>'CONFIRMED')
            """)
        .param(account.id())
        .query(
            (r, i) ->
                new Signer(
                    r.getString("subject"),
                    new Onboarding.PartyPreparation(
                        r.getObject("preparation_id", UUID.class),
                        r.getString("prepared_party_id"),
                        true,
                        r.getString("public_key"),
                        r.getString("public_key_fingerprint"),
                        r.getString("multi_hash"),
                        r.getString("synchronizer_id"),
                        r.getString("party_status"),
                        r.getString("prepared_participant_id"),
                        List.of())))
        .optional()
        .orElseThrow(() -> new TokenConflict("Complete onboarding before using test tokens"));
  }

  public Claim initialize(UUID accountId, String partyId) {
    sql.sql(
            "INSERT INTO dev_faucet_claims(account_id,party_id,grant_id,grant_command_id)"
                + " VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
        .params(
            accountId,
            partyId,
            UUID.nameUUIDFromBytes(
                ("local-test-faucet:" + partyId).getBytes(java.nio.charset.StandardCharsets.UTF_8)),
            UUID.randomUUID())
        .update();
    return get(accountId)
        .orElseThrow(() -> new TokenConflict("This party already has a test token request"));
  }

  public Optional<Claim> get(UUID accountId) {
    return sql.sql("SELECT * FROM dev_faucet_claims WHERE account_id=?")
        .param(accountId)
        .query(this::map)
        .optional();
  }

  public boolean claimGrant(UUID accountId, long offset) {
    return sql.sql(
                """
                UPDATE dev_faucet_claims SET grant_status='SUBMITTING',grant_command_id=?,
                  grant_begin_offset=?,error_code=NULL,error=NULL,updated_at=now()
                WHERE account_id=? AND grant_status='PENDING'
                """)
            .params(UUID.randomUUID(), offset, accountId)
            .update()
        == 1;
  }

  public void confirmGrant(UUID accountId, UUID commandId, Confirmation confirmation) {
    sql.sql(
            """
            UPDATE dev_faucet_claims SET grant_status='CONFIRMED',grant_cid=?,error_code=NULL,error=NULL,updated_at=now()
            WHERE account_id=? AND grant_command_id=? AND grant_status IN ('SUBMITTING','UNRESOLVED')
            """)
        .params(confirmation.contractId(), accountId, commandId)
        .update();
  }

  public boolean beginGrantRecovery(UUID accountId, UUID commandId) {
    return sql.sql(
                """
                UPDATE dev_faucet_claims SET grant_status='UNRESOLVED',updated_at=now()
                WHERE account_id=? AND grant_command_id=? AND grant_status IN ('SUBMITTING','UNRESOLVED')
                """)
            .params(accountId, commandId)
            .update()
        == 1;
  }

  public void unresolvedGrant(UUID accountId, UUID commandId) {
    sql.sql(
            """
            UPDATE dev_faucet_claims SET grant_status='UNRESOLVED',error_code='GRANT_UNRESOLVED',
              error='Checking whether the test token grant was created',updated_at=now()
            WHERE account_id=? AND grant_command_id=? AND grant_status='SUBMITTING'
            """)
        .params(accountId, commandId)
        .update();
  }

  public boolean savePreparation(UUID accountId, UUID preparationId, Prepared prepared) {
    return sql.sql(
                """
                UPDATE dev_faucet_claims SET preparation_id=?,prepared_transaction=?,prepared_hash=?,
                  hashing_scheme_version=?,expires_at=?,status='PREPARED',error_code=NULL,error=NULL,updated_at=now()
                WHERE account_id=? AND grant_status='CONFIRMED'
                  AND (status='AVAILABLE' OR (status='PREPARED' AND expires_at<=now()))
                """)
            .params(
                preparationId,
                prepared.preparedTransaction(),
                prepared.preparedTransactionHash(),
                prepared.hashingSchemeVersion(),
                Timestamp.from(prepared.expiresAt()),
                accountId)
            .update()
        == 1;
  }

  public boolean claimSubmission(UUID accountId, UUID preparationId, long offset) {
    return sql.sql(
                "UPDATE dev_faucet_claims SET"
                    + " status='SUBMITTING',claim_begin_offset=?,updated_at=now() WHERE"
                    + " account_id=? AND preparation_id=? AND status='PREPARED' AND"
                    + " expires_at>now()")
            .params(offset, accountId, preparationId)
            .update()
        == 1;
  }

  public void complete(UUID accountId, UUID preparationId, Confirmation confirmation) {
    sql.sql(
            """
            UPDATE dev_faucet_claims SET status='COMPLETED',update_id=?,error_code=NULL,error=NULL,updated_at=now()
            WHERE account_id=? AND preparation_id=? AND status IN ('SUBMITTING','UNRESOLVED')
            """)
        .params(confirmation.updateId(), accountId, preparationId)
        .update();
  }

  public void rejected(UUID accountId, UUID preparationId) {
    sql.sql(
            """
            UPDATE dev_faucet_claims SET status='AVAILABLE',prepared_transaction=NULL,prepared_hash=NULL,
              hashing_scheme_version=NULL,expires_at=NULL,error_code='CLAIM_REJECTED',
              error='The previous claim did not commit; prepare a new signing request',updated_at=now()
            WHERE account_id=? AND preparation_id=? AND status IN ('SUBMITTING','UNRESOLVED')
            """)
        .params(accountId, preparationId)
        .update();
  }

  public void rejectedGrant(UUID accountId, UUID commandId) {
    sql.sql(
            """
            UPDATE dev_faucet_claims SET grant_status='PENDING',error_code='GRANT_REJECTED',
              error='The previous grant attempt did not commit; retry the request',updated_at=now()
            WHERE account_id=? AND grant_command_id=? AND grant_status='SUBMITTING'
            """)
        .params(accountId, commandId)
        .update();
  }

  public void unresolved(UUID accountId, UUID preparationId) {
    sql.sql(
            """
            UPDATE dev_faucet_claims SET status='UNRESOLVED',error_code='CLAIM_UNRESOLVED',
              error='Checking whether the signed test token claim committed',updated_at=now()
            WHERE account_id=? AND preparation_id=? AND status='SUBMITTING'
            """)
        .params(accountId, preparationId)
        .update();
  }

  private Claim map(ResultSet r, int index) throws SQLException {
    var expiresAt = r.getTimestamp("expires_at");
    var prepared =
        expiresAt == null
            ? null
            : new Prepared(
                r.getString("prepared_transaction"),
                r.getString("prepared_hash"),
                r.getInt("hashing_scheme_version"),
                expiresAt.toInstant());
    return new Claim(
        r.getObject("account_id", UUID.class),
        r.getObject("grant_id", UUID.class),
        r.getObject("grant_command_id", UUID.class),
        r.getString("grant_cid"),
        r.getObject("grant_begin_offset", Long.class),
        GrantStatus.valueOf(r.getString("grant_status")),
        r.getObject("preparation_id", UUID.class),
        prepared,
        r.getObject("claim_begin_offset", Long.class),
        Status.valueOf(r.getString("status")),
        r.getString("update_id"),
        r.getString("error_code"),
        r.getString("error"));
  }
}
