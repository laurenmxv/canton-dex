package com.openzeppelin.dex.iam;

import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class AccountDirectory {
  private final JdbcClient sql;

  public AccountDirectory(JdbcClient sql) {
    this.sql = sql;
  }

  public Account authenticate(String issuer, String subject, String displayName) {
    // Only called after JWT signature, issuer, expiry and audience validation. Roles are never
    // imported.
    sql.sql(
            "INSERT INTO accounts (id,issuer,subject,display_name,role) VALUES (?,?,?,?,'TRADER') ON CONFLICT (issuer,subject) DO NOTHING")
        .params(
            UUID.randomUUID(),
            issuer,
            subject,
            displayName == null || displayName.isBlank() ? subject : displayName)
        .update();
    return sql.sql(
            "SELECT id,issuer,subject,display_name,role FROM accounts WHERE issuer=? AND subject=?")
        .params(issuer, subject)
        .query(
            (r, i) ->
                new Account(
                    r.getObject("id", UUID.class),
                    r.getString("issuer"),
                    r.getString("subject"),
                    r.getString("display_name"),
                    Account.Role.valueOf(r.getString("role"))))
        .single();
  }

  public Account get(UUID id) {
    return sql.sql("SELECT id,issuer,subject,display_name,role FROM accounts WHERE id=?")
        .param(id)
        .query(
            (r, i) ->
                new Account(
                    r.getObject("id", UUID.class),
                    r.getString("issuer"),
                    r.getString("subject"),
                    r.getString("display_name"),
                    Account.Role.valueOf(r.getString("role"))))
        .single();
  }

  public Profile profile(Account caller) {
    return sql.sql("SELECT party_id FROM accounts WHERE id=?")
        .param(caller.id())
        .query(
            (r, i) ->
                new Profile(
                    caller.id(), caller.displayName(), caller.role(), r.getString("party_id")))
        .single();
  }

  public void bindParty(UUID accountId, String party) {
    if (sql.sql("UPDATE accounts SET party_id=? WHERE id=? AND (party_id IS NULL OR party_id=?)")
            .params(party, accountId, party)
            .update()
        != 1) throw new IllegalStateException("Account already has another party");
  }
}
