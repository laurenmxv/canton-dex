package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.daml.ledger.api.v2.CommandsOuterClass.Commands;
import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.google.protobuf.ByteString;
import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.registry.TokenRules;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationinstructionv2.AllocationFactory;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "environment|swaps|all")
class StoredSubmissionIT {
  @Test
  void persistedOperatorCommandReplaysWithoutASecondLedgerChange() throws Exception {
    try (var fixtures = new DevelopmentFixtures();
        var ledger = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
      var config =
          fixtures
              .sql()
              .sql(
                  "SELECT rules_id,rules_created_event_blob,synchronizer_id FROM"
                      + " test_token_configuration WHERE id=1")
              .query()
              .singleRow();
      var disclosure =
          DisclosedContract.newBuilder()
              .setTemplateId(TokenRules.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
              .setContractId((String) config.get("rules_id"))
              .setCreatedEventBlob(
                  ByteString.copyFrom(
                      Base64.getDecoder().decode((String) config.get("rules_created_event_blob"))))
              .setSynchronizerId((String) config.get("synchronizer_id"))
              .build();
      String operator = ledger.primaryParty();
      long before = ledger.ledgerEnd();
      var commands =
          ledger.storedCommands(
              UUID.randomUUID().toString(),
              operator,
              List.of(),
              new AllocationFactory.ContractId((String) config.get("rules_id"))
                  .exerciseAllocationFactory_PublicFetch(List.of(operator)),
              before,
              List.of(disclosure));
      // Rehydrate exactly the envelope a durable operation stores before its first dispatch.
      var stored = Commands.parseFrom(commands.toByteArray());
      var first = ledger.submitStored(stored);
      assertThat(first.getOffset()).isGreaterThan(before);
      assertThat(first.getUpdateId()).isNotBlank();
      assertThatThrownBy(() -> ledger.submitStored(stored))
          .isInstanceOfSatisfying(
              StatusRuntimeException.class,
              failure ->
                  assertThat(failure.getStatus().getCode()).isEqualTo(Status.Code.ALREADY_EXISTS));
      // The local participant uses a 30-second maximum duration; offset replay survives it.
      Thread.sleep(java.time.Duration.ofSeconds(31));
      try (var reopened = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
        assertThatThrownBy(() -> reopened.submitStored(stored))
            .isInstanceOfSatisfying(
                StatusRuntimeException.class,
                failure ->
                    assertThat(failure.getStatus().getCode())
                        .isEqualTo(Status.Code.ALREADY_EXISTS));
      }
      var history = ledger.history(before, operator);
      assertThat(
              history.transactions().stream()
                  .filter(transaction -> transaction.getCommandId().equals(stored.getCommandId())))
          .extracting(transaction -> transaction.getUpdateId())
          .containsExactly(first.getUpdateId());
    }
  }
}
