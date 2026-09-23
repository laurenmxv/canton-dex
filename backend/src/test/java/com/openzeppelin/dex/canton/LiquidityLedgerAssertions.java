package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;

import com.daml.ledger.javaapi.data.DamlRecord;
import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.AllocationView;
import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.tokens.TokenRegistryStore;
import com.openzeppelin.dex.tokens.TokenStore;
import java.security.KeyPair;
import java.security.Signature;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

public final class LiquidityLedgerAssertions {
  private LiquidityLedgerAssertions() {}

  public static PoolAccess revokeAccess(LedgerConnection ledger, String trader, String poolId) {
    var accesses =
        ledger.activeContracts(ledger.primaryParty(), PoolAccess.TEMPLATE_ID).stream()
            .filter(
                event -> {
                  var access =
                      PoolAccess.valueDecoder()
                          .decode(DamlRecord.fromProto(event.getCreateArguments()));
                  return access.trader.equals(trader) && access.poolCid.contractId.equals(poolId);
                })
            .toList();
    assertThat(accesses).hasSize(1);
    ledger.submit(
        UUID.randomUUID().toString(),
        ledger.primaryParty(),
        List.of(),
        new PoolAccess.ContractId(accesses.getFirst().getContractId()).exerciseArchive());
    assertThat(ledger.activeContracts(ledger.primaryParty(), PoolAccess.TEMPLATE_ID))
        .noneMatch(event -> event.getContractId().equals(accesses.getFirst().getContractId()));
    return PoolAccess.valueDecoder()
        .decode(DamlRecord.fromProto(accesses.getFirst().getCreateArguments()));
  }

  public static void restoreAccess(LedgerConnection ledger, PoolAccess access) {
    ledger.submit(UUID.randomUUID().toString(), ledger.primaryParty(), List.of(), access.create());
  }

  public static void withdrawAllocation(
      DevelopmentFixtures fixtures,
      LedgerConnection ledger,
      String callerToken,
      String trader,
      KeyPair key,
      String allocationCid)
      throws Exception {
    var account =
        fixtures
            .sql()
            .sql("SELECT * FROM accounts WHERE party_id=?")
            .param(trader)
            .query(
                (r, n) ->
                    new Account(
                        r.getObject("id", UUID.class),
                        r.getString("issuer"),
                        r.getString("subject"),
                        r.getString("display_name"),
                        Account.Role.TRADER))
            .single();
    var signer = new TokenStore(fixtures.sql()).signer(account).party();
    var event =
        ledger
            .activeInterfaceContracts(
                trader, Allocation.INTERFACE_ID, ledger.ledgerEnd(callerToken), callerToken)
            .stream()
            .filter(candidate -> candidate.getContractId().equals(allocationCid))
            .findFirst()
            .orElseThrow();
    var allocation =
        AllocationView.valueDecoder()
            .decode(InterfaceViews.view(event, Allocation.INTERFACE_ID_WITH_PACKAGE_ID));
    var context =
        new CantonTokenRegistry(new TokenRegistryStore(fixtures.sql()))
            .withdraw(allocation.allocation.admin, allocationCid);
    var interactive = new InteractiveTransactions(ledger);
    String commandId = UUID.randomUUID().toString();
    var prepared =
        interactive.prepare(
            commandId,
            account.subject(),
            callerToken,
            signer,
            new Allocation.ContractId(allocationCid)
                .exerciseAllocation_Withdraw(List.of(trader), context.extraArgs()),
            context.disclosures(),
            Instant.now().plusSeconds(45));
    var signature = Signature.getInstance("Ed25519");
    signature.initSign(key.getPrivate());
    signature.update(Base64.getDecoder().decode(prepared.preparedTransactionHash()));
    interactive.execute(
        commandId,
        prepared,
        Base64.getEncoder().encodeToString(signature.sign()),
        signer,
        callerToken,
        account.subject());
    assertThat(
            ledger.activeInterfaceContracts(
                trader, Allocation.INTERFACE_ID, ledger.ledgerEnd(callerToken), callerToken))
        .noneMatch(candidate -> candidate.getContractId().equals(allocationCid));
  }
}
