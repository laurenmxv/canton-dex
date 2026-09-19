package com.openzeppelin.dex.bootstrap;

import com.openzeppelin.dex.canton.*;
import java.net.URI;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Shared fixture setup for bootstrap and integration scripts, outside the runtime API. */
public final class DevelopmentFixtures implements AutoCloseable {
  private final JdbcClient sql;
  private final KeycloakFixtures keycloak;
  private final LedgerConnection adminConnection;
  private final CantonAdmin admin;

  public DevelopmentFixtures() {
    sql = JdbcClient.create(dataSource());
    keycloak =
        new KeycloakFixtures(
            env("DEX_BOOTSTRAP_KEYCLOAK_URL"),
            env("DEX_BOOTSTRAP_KEYCLOAK_USERNAME"),
            env("DEX_BOOTSTRAP_KEYCLOAK_PASSWORD"));
    adminConnection =
        connection(
            new LedgerIdentity(
                env("DEX_BOOTSTRAP_LEDGER_USER_ID"),
                env("DEX_BOOTSTRAP_LEDGER_CLIENT_ID"),
                env("DEX_BOOTSTRAP_LEDGER_CLIENT_SECRET")));
    admin = new CantonAdmin(adminConnection);
  }

  public static String env(String key) {
    String value = System.getenv(key);
    if (value == null || value.isBlank())
      throw new IllegalStateException("Missing configuration: " + key);
    return value;
  }

  public static DriverManagerDataSource dataSource() {
    return new DriverManagerDataSource(
        env("SPRING_DATASOURCE_URL"),
        env("SPRING_DATASOURCE_USERNAME"),
        env("SPRING_DATASOURCE_PASSWORD"));
  }

  public static LedgerConnection connection(LedgerIdentity identity) {
    return new LedgerConnection(
        env("DEX_CANTON_HOST"),
        Integer.parseInt(env("DEX_CANTON_PORT")),
        URI.create(env("DEX_CANTON_TOKEN_URL")),
        identity);
  }

  public static LedgerIdentity operatorIdentity() {
    return new LedgerIdentity(
        env("DEX_CANTON_USER_ID"), env("DEX_CANTON_CLIENT_ID"), env("DEX_CANTON_CLIENT_SECRET"));
  }

  public record Actor(String name, String party, LedgerIdentity identity) {}

  public Actor actor(String name) {
    return actor(name, keycloak.ledgerIdentity(name), List.of());
  }

  public Actor actor(String name, LedgerIdentity identity, List<String> readers) {
    String party = admin.ensureParty("dex-" + name);
    admin.ensureUser(identity.userId(), party, readers);
    sql.sql(
            "INSERT INTO fixture_parties (name, party_id, ledger_user_id, ledger_client_id) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING")
        .params(name, party, identity.userId(), identity.clientId())
        .update();
    return new Actor(name, party, identity);
  }

  public void account(String name, String subject, String role) {
    sql.sql(
            "INSERT INTO accounts (id, issuer, subject, display_name, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT (issuer, subject) DO NOTHING")
        .params(UUID.randomUUID(), env("DEX_IAM_ISSUER"), subject, name, role)
        .update();
  }

  public JdbcClient sql() {
    return sql;
  }

  public KeycloakFixtures keycloak() {
    return keycloak;
  }

  public CantonAdmin admin() {
    return admin;
  }

  @Override
  public void close() {
    adminConnection.close();
    keycloak.close();
  }
}
