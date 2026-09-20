package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.CommandsOuterClass.Commands;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.google.protobuf.InvalidProtocolBufferException;
import com.openzeppelin.dex.operations.OperatorCommandStore;
import java.util.Base64;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;

/** Persists the complete operator command before sending it, including its deduplication offset. */
@Component
final class CantonOperatorCommands {
  private final LedgerConnection ledger;
  private final OperatorCommandStore store;

  CantonOperatorCommands(LedgerConnection ledger, OperatorCommandStore store) {
    this.ledger = ledger;
    this.store = store;
  }

  Transaction submit(UUID id, String kind, Supplier<Commands> build) {
    String encoded =
        store
            .find(id, kind)
            .orElseGet(
                () -> {
                  var command = build.get();
                  if (!command.getCommandId().equals(id.toString()))
                    throw new IllegalArgumentException(
                        "Operator command identity differs from its durable request");
                  return store.storeOnce(
                      id, kind, Base64.getEncoder().encodeToString(command.toByteArray()));
                });
    return ledger.submitStored(decode(encoded));
  }

  private static Commands decode(String encoded) {
    try {
      return Commands.parseFrom(Base64.getDecoder().decode(encoded));
    } catch (InvalidProtocolBufferException failure) {
      throw new IllegalStateException("Stored operator command is invalid", failure);
    }
  }
}
