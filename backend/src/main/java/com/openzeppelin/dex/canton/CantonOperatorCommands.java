package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.CommandsOuterClass.Commands;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.google.protobuf.InvalidProtocolBufferException;
import com.openzeppelin.dex.operations.OperatorCommandStore;
import com.openzeppelin.dex.operations.OperatorCommandStore.Prepared;
import java.util.Base64;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Persists the command or its construction failure before any worker may send it. */
@Component
final class CantonOperatorCommands {
  private static final Logger LOG = LoggerFactory.getLogger(CantonOperatorCommands.class);

  /** A durable preparation failure excludes every attempt, including concurrent replays. */
  static final class PreparationFailed extends RuntimeException {
    PreparationFailed(String message) {
      super(message);
    }
  }

  private final LedgerConnection ledger;
  private final OperatorCommandStore store;

  CantonOperatorCommands(LedgerConnection ledger, OperatorCommandStore store) {
    this.ledger = ledger;
    this.store = store;
  }

  Transaction submit(UUID id, String kind, Supplier<Commands> build) {
    var prepared =
        store.find(id, kind).orElseGet(() -> store.storeOnce(id, kind, prepare(id, build)));
    if (prepared.error() != null) throw new PreparationFailed(prepared.error());
    return ledger.submitStored(decode(prepared.payload()));
  }

  private static Prepared prepare(UUID id, Supplier<Commands> build) {
    try {
      var command = build.get();
      if (!command.getCommandId().equals(id.toString()))
        throw new IllegalArgumentException(
            "Operator command identity differs from its durable request");
      return new Prepared(Base64.getEncoder().encodeToString(command.toByteArray()), null);
    } catch (RuntimeException failure) {
      LOG.warn("Operator command {} could not be prepared", id, failure);
      return new Prepared(
          null, "The operator command could not be prepared; no transaction was sent");
    }
  }

  private static Commands decode(String encoded) {
    try {
      return Commands.parseFrom(Base64.getDecoder().decode(encoded));
    } catch (InvalidProtocolBufferException failure) {
      throw new IllegalStateException("Stored operator command is invalid", failure);
    }
  }
}
