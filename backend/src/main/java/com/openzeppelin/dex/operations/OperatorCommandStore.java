package com.openzeppelin.dex.operations;

import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Immutable prepared commands for batch and faucet-grant operations. */
@Repository
public class OperatorCommandStore {
  private final JdbcClient sql;

  public OperatorCommandStore(JdbcClient sql) {
    this.sql = sql;
  }

  /** Concurrent preparations share the first persisted payload for this command id. */
  public String storeOnce(UUID id, String kind, String encodedPayload) {
    Objects.requireNonNull(id);
    Objects.requireNonNull(kind);
    Objects.requireNonNull(encodedPayload);
    sql.sql(
            "INSERT INTO operator_commands(id,kind,payload) VALUES(?,?,?) ON CONFLICT(id) DO"
                + " NOTHING")
        .params(id, kind, encodedPayload)
        .update();
    return find(id, kind)
        .orElseThrow(() -> new IllegalStateException("Stored operator command is missing"));
  }

  public Optional<String> find(UUID id, String kind) {
    Objects.requireNonNull(id);
    Objects.requireNonNull(kind);
    return sql.sql("SELECT kind,payload FROM operator_commands WHERE id=?")
        .param(id)
        .query(
            (row, ignored) -> {
              if (!kind.equals(row.getString("kind")))
                throw new IllegalStateException(
                    "Operator command id belongs to another operation kind");
              return row.getString("payload");
            })
        .optional();
  }
}
