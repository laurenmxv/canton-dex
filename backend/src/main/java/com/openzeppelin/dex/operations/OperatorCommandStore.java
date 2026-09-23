package com.openzeppelin.dex.operations;

import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Immutable preparation outcomes for batch and faucet-grant commands. */
@Repository
public class OperatorCommandStore {
  public record Prepared(String payload, String error) {
    public Prepared {
      if ((payload == null) == (error == null))
        throw new IllegalArgumentException(
            "An operator command needs a payload or a preparation error");
    }
  }

  private final JdbcClient sql;

  public OperatorCommandStore(JdbcClient sql) {
    this.sql = sql;
  }

  /** Concurrent builders share the first outcome, including proof that nothing can be sent. */
  public Prepared storeOnce(UUID id, String kind, Prepared prepared) {
    Objects.requireNonNull(id);
    Objects.requireNonNull(kind);
    Objects.requireNonNull(prepared);
    sql.sql(
            "INSERT INTO operator_commands(id,kind,payload,error) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING")
        .params(id, kind, prepared.payload(), prepared.error())
        .update();
    return find(id, kind)
        .orElseThrow(() -> new IllegalStateException("Stored operator command is missing"));
  }

  public Optional<Prepared> find(UUID id, String kind) {
    Objects.requireNonNull(id);
    Objects.requireNonNull(kind);
    return sql.sql("SELECT kind,payload,error FROM operator_commands WHERE id=?")
        .param(id)
        .query(
            (row, ignored) -> {
              if (!kind.equals(row.getString("kind")))
                throw new IllegalStateException(
                    "Operator command id belongs to another operation kind");
              return new Prepared(row.getString("payload"), row.getString("error"));
            })
        .optional();
  }
}
