package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.javaapi.data.DamlRecord;
import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.generated.kycattestation.KycAttestation;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess;
import java.util.*;
import tools.jackson.databind.JsonNode;

public final class OnboardingLedgerAssertions {
  private OnboardingLedgerAssertions() {}

  public static void completed(
      DevelopmentFixtures fixtures, JsonNode onboarding, List<String> expectedPools) {
    String trader = onboarding.path("party").path("partyId").asString();
    assertThat(onboarding.path("status").asString()).isEqualTo("COMPLETED");
    assertThat(onboarding.path("partyMode").asString()).isEqualTo("external");
    assertThat(onboarding.path("party").path("partyId").asString()).isEqualTo(trader);
    assertThat(onboarding.path("party").path("confirmed").asBoolean()).isTrue();
    var pools = new ArrayList<String>();
    onboarding.path("review").path("approvedPoolIds").forEach(n -> pools.add(n.asString()));
    assertThat(pools).containsExactlyInAnyOrderElementsOf(expectedPools);
    var persistedPools =
        fixtures
            .sql()
            .sql("SELECT jsonb_array_elements_text(approved_pools) FROM onboardings WHERE id = ?")
            .param(UUID.fromString(onboarding.path("id").asString()))
            .query(String.class)
            .list();
    assertThat(persistedPools).containsExactlyInAnyOrderElementsOf(expectedPools);
    var ids = new HashMap<String, String>();
    onboarding
        .path("ledgerSteps")
        .forEach(
            step -> {
              assertThat(step.path("status").asString()).isEqualTo("CONFIRMED");
              ids.put(step.path("key").asString(), step.path("contractId").asString());
              var stored =
                  fixtures
                      .sql()
                      .sql(
                          "SELECT command_id, status, contract_id, update_id, issuer FROM onboarding_steps WHERE onboarding_id = ? AND step_key = ?")
                      .params(
                          UUID.fromString(onboarding.path("id").asString()),
                          step.path("key").asString())
                      .query()
                      .singleRow();
              assertThat(stored.get("command_id").toString())
                  .isEqualTo(step.path("commandId").asString());
              assertThat(stored.get("update_id")).isEqualTo(step.path("updateId").asString());
              assertThat(stored.get("issuer")).isEqualTo(step.path("issuer").asString());
              assertThat(stored.get("status")).isEqualTo("CONFIRMED");
              assertThat(stored.get("contract_id")).isEqualTo(step.path("contractId").asString());
            });
    assertThat(ids).hasSize(pools.size() + 1);
    assertThat(
            fixtures
                .sql()
                .sql("SELECT party_id FROM accounts WHERE id = ?")
                .param(UUID.fromString(onboarding.path("accountId").asString()))
                .query(String.class)
                .single())
        .isEqualTo(trader);
    try (var operator = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
      for (var reader : List.of(operator)) {
        var attestations =
            reader.activeContracts(reader.primaryParty(), KycAttestation.TEMPLATE_ID).stream()
                .filter(e -> e.getTemplateId().getPackageId().equals(KycAttestation.PACKAGE_ID))
                .filter(
                    e ->
                        KycAttestation.valueDecoder()
                            .decode(DamlRecord.fromProto(e.getCreateArguments()))
                            .trader
                            .equals(trader))
                .toList();
        assertThat(attestations).hasSize(1);
        var event = attestations.getFirst();
        assertThat(event.getSignatoriesList()).containsExactly(operator.primaryParty());
        assertThat(event.getObserversList()).contains(trader);
        assertThat(fixtures.admin().rights(DevelopmentFixtures.operatorIdentity().userId()))
            .noneMatch(
                right -> right.hasCanActAs() && right.getCanActAs().getParty().equals(trader));
        assertThat(event.getContractId()).isEqualTo(ids.get("attestation"));
        var attestation =
            KycAttestation.valueDecoder().decode(DamlRecord.fromProto(event.getCreateArguments()));
        assertThat(attestation.venueOperator).isEqualTo(operator.primaryParty());
        assertThat(attestation.pools.stream().map(cid -> cid.contractId))
            .containsExactlyInAnyOrderElementsOf(pools);
        var accesses =
            reader.activeContracts(reader.primaryParty(), PoolAccess.TEMPLATE_ID).stream()
                .filter(e -> e.getTemplateId().getPackageId().equals(PoolAccess.PACKAGE_ID))
                .filter(
                    e ->
                        PoolAccess.valueDecoder()
                            .decode(DamlRecord.fromProto(e.getCreateArguments()))
                            .trader
                            .equals(trader))
                .toList();
        assertThat(accesses).hasSize(pools.size());
        for (var accessEvent : accesses) {
          var access =
              PoolAccess.valueDecoder()
                  .decode(DamlRecord.fromProto(accessEvent.getCreateArguments()));
          assertThat(access.venueOperator).isEqualTo(operator.primaryParty());
          assertThat(access.attestationCid.contractId).isEqualTo(ids.get("attestation"));
          assertThat(accessEvent.getContractId())
              .isEqualTo(ids.get("access:" + access.poolCid.contractId));
        }
      }
    }
  }
}
