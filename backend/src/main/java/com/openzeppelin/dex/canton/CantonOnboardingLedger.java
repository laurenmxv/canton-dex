package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.openzeppelin.dex.canton.generated.kycattestation.KycAttestation;
import com.openzeppelin.dex.canton.generated.pool.Pool;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess;
import com.openzeppelin.dex.onboarding.*;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
public final class CantonOnboardingLedger implements OnboardingLedger {
  private final LedgerConnection ledger;

  public CantonOnboardingLedger(LedgerConnection ledger) {
    this.ledger = ledger;
  }

  @Override
  public String packageId() {
    return Pool.PACKAGE_ID;
  }

  @Override
  public long ledgerEnd() {
    return ledger.ledgerEnd();
  }

  @Override
  public Confirmation attest(String commandId, String trader, List<String> poolIds) {
    String issuer = ledger.primaryParty();
    var expected =
        new KycAttestation(issuer, trader, poolIds.stream().map(Pool.ContractId::new).toList());
    return confirm(
        ledger.submit(commandId, issuer, List.of(), expected.create()),
        expected,
        null,
        issuer,
        trader);
  }

  @Override
  public Confirmation grantAccess(
      String commandId, String trader, String poolId, String attestationId) {
    String issuer = ledger.primaryParty();
    var expected =
        new PoolAccess(
            issuer,
            trader,
            new Pool.ContractId(poolId),
            new KycAttestation.ContractId(attestationId));
    return confirm(
        ledger.submit(commandId, issuer, List.of(), expected.create()),
        null,
        expected,
        issuer,
        trader);
  }

  @Override
  public Optional<Confirmation> recover(
      long beginOffset, LedgerStep step, Onboarding onboarding, String attestationId) {
    String issuer = ledger.primaryParty(), trader = onboarding.party().partyId();
    var transactions =
        ledger.transactions(beginOffset, issuer).stream()
            .filter(t -> t.getCommandId().equals(step.commandId().toString()))
            .toList();
    if (transactions.isEmpty()) return Optional.empty();
    if (transactions.size() != 1)
      throw new IllegalStateException("Multiple transactions for the onboarding command");
    var attestation =
        step.key().equals("attestation")
            ? new KycAttestation(
                issuer,
                trader,
                onboarding.review().approvedPoolIds().stream().map(Pool.ContractId::new).toList())
            : null;
    var access =
        attestation == null
            ? new PoolAccess(
                issuer,
                trader,
                new Pool.ContractId(step.key().substring("access:".length())),
                new KycAttestation.ContractId(attestationId))
            : null;
    return Optional.of(confirm(transactions.getFirst(), attestation, access, issuer, trader));
  }

  private Confirmation confirm(
      Transaction tx, KycAttestation attestation, PoolAccess access, String issuer, String trader) {
    var template =
        attestation != null
            ? KycAttestation.TEMPLATE_ID_WITH_PACKAGE_ID
            : PoolAccess.TEMPLATE_ID_WITH_PACKAGE_ID;
    if (tx.getEventsCount() != 1 || !tx.getEvents(0).hasCreated())
      throw new IllegalStateException("Unexpected onboarding transaction effects");
    var event = tx.getEvents(0).getCreated();
    if (!event.getTemplateId().equals(template.toProto())
        || !event.getSignatoriesList().equals(List.of(issuer))
        || !event.getObserversList().contains(trader))
      throw new IllegalStateException("Unexpected onboarding contract authority");
    var payload = DamlRecord.fromProto(event.getCreateArguments());
    boolean matches =
        attestation != null
            ? attestation.equals(KycAttestation.valueDecoder().decode(payload))
            : access.equals(PoolAccess.valueDecoder().decode(payload));
    if (!matches) throw new IllegalStateException("Onboarding command payload differs");
    return new Confirmation(event.getContractId(), tx.getUpdateId(), issuer);
  }
}
