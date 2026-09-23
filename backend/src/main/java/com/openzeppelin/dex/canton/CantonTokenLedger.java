package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.google.protobuf.ByteString;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.registry.TokenRules;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Holding;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.HoldingView;
import com.openzeppelin.dex.canton.generated.testtokenfaucet.TestTokenFaucet;
import com.openzeppelin.dex.canton.generated.testtokenfaucet.TestTokenGrant;
import com.openzeppelin.dex.canton.generated.testtokenfaucet.TestTokenReceipt;
import com.openzeppelin.dex.tokens.InstrumentCatalog;
import com.openzeppelin.dex.tokens.TokenLedger;
import com.openzeppelin.dex.tokens.TokenModels.*;
import com.openzeppelin.dex.tokens.TokenStore;
import io.grpc.StatusRuntimeException;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public final class CantonTokenLedger implements TokenLedger {
  private static final Logger LOG = LoggerFactory.getLogger(CantonTokenLedger.class);
  private final LedgerConnection ledger;
  private final InteractiveTransactions interactive;
  private final TokenStore store;
  private final InstrumentCatalog catalog;
  private final CantonOperatorCommands operatorCommands;

  public CantonTokenLedger(
      LedgerConnection ledger,
      TokenStore store,
      InstrumentCatalog catalog,
      CantonOperatorCommands operatorCommands) {
    this.ledger = ledger;
    this.interactive = new InteractiveTransactions(ledger);
    this.store = store;
    this.catalog = catalog;
    this.operatorCommands = operatorCommands;
  }

  @Override
  public long ledgerEnd() {
    return ledger.ledgerEnd();
  }

  @Override
  public Confirmation issueGrant(Claim claim, Signer signer) {
    Transaction tx;
    try {
      tx =
          submit(
              () ->
                  operatorCommands.submit(
                      claim.grantCommandId(),
                      "faucet-grant",
                      () -> {
                        var registry = store.registry();
                        return ledger.storedCommands(
                            claim.grantCommandId().toString(),
                            ledger.primaryParty(),
                            List.of(),
                            new TestTokenFaucet.ContractId(registry.faucetFactoryId())
                                .exerciseTestTokenFaucet_IssueGrant(
                                    signer.party().partyId(), claim.grantId().toString()),
                            claim.grantBeginOffset(),
                            List.of());
                      }));
    } catch (CantonOperatorCommands.PreparationFailed failure) {
      throw new TokenLedger.GrantNotSubmitted(failure.getMessage());
    }
    return grant(tx, claim, signer)
        .orElseThrow(() -> new IllegalStateException("Grant transaction has no matching grant"));
  }

  @Override
  public Optional<Confirmation> recoverGrant(Claim claim, Signer signer) {
    var history = ledger.history(claim.grantBeginOffset(), ledger.primaryParty());
    var confirmed =
        one(
            history.transactions().stream()
                .filter(tx -> tx.getCommandId().equals(claim.grantCommandId().toString()))
                .flatMap(tx -> grant(tx, claim, signer).stream())
                .toList());
    if (confirmed.isPresent()) return confirmed;
    try {
      return Optional.of(issueGrant(claim, signer));
    } catch (TokenLedger.GrantNotSubmitted notSent) {
      throw notSent;
    } catch (RuntimeException retryFailure) {
      // A retry's rejection cannot establish the outcome of the original persisted command.
      LOG.debug(
          "Test token grant remains unresolved: command={}", claim.grantCommandId(), retryFailure);
      return Optional.empty();
    }
  }

  @Override
  public Prepared prepareClaim(Claim claim, Signer signer, String callerToken, Instant expiresAt) {
    var registry = store.registry();
    var rules =
        DisclosedContract.newBuilder()
            .setContractId(registry.rulesId())
            .setTemplateId(TokenRules.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
            .setCreatedEventBlob(
                ByteString.copyFrom(Base64.getDecoder().decode(registry.rulesCreatedEventBlob())))
            .setSynchronizerId(registry.synchronizerId())
            .build();
    var prepared =
        interactive.prepare(
            claimCommand(claim),
            signer.userId(),
            callerToken,
            signer.party(),
            new TestTokenGrant.ContractId(claim.grantCid()).exerciseTestTokenGrant_Claim(),
            List.of(rules),
            expiresAt);
    return new Prepared(
        prepared.preparedTransaction(),
        prepared.preparedTransactionHash(),
        prepared.hashingSchemeVersion(),
        prepared.expiresAt());
  }

  @Override
  public Confirmation claim(Claim claim, Signer signer, String callerToken, String signature) {
    var tx =
        submit(
            () ->
                interactive.execute(
                    claim.preparationId().toString(),
                    stored(claim, signer),
                    signature,
                    signer.party(),
                    callerToken,
                    signer.userId()));
    return receipt(tx, claim, signer)
        .orElseThrow(() -> new IllegalStateException("Claim transaction has no matching receipt"));
  }

  @Override
  public void verify(Claim claim, Signer signer, String signature) {
    InteractiveTransactions.verify(stored(claim, signer), signature, signer.party());
  }

  @Override
  public Optional<Confirmation> recoverClaim(Claim claim, Signer signer) {
    var history = ledger.history(claim.claimBeginOffset(), ledger.primaryParty());
    var confirmed =
        one(
            history.transactions().stream()
                .flatMap(tx -> receipt(tx, claim, signer).stream())
                .toList());
    return recovered(history, confirmed, claim.prepared().expiresAt());
  }

  private static Optional<Confirmation> recovered(
      LedgerConnection.History history, Optional<Confirmation> confirmed, Instant deadline) {
    if (confirmed.isPresent()) return confirmed;
    if (history.recordTime().filter(time -> time.isAfter(deadline)).isPresent())
      throw new TokenLedger.Rejected(
          "Record-time deadline passed without a committed effect", null);
    return Optional.empty();
  }

  @Override
  public Balances balances(Signer signer, String callerToken) {
    long offset = ledger.ledgerEnd(callerToken);
    var holdings =
        ledger
            .activeInterfaceContracts(
                signer.party().partyId(), Holding.INTERFACE_ID, offset, callerToken)
            .stream()
            .map(
                event ->
                    HoldingView.valueDecoder()
                        .decode(InterfaceViews.view(event, Holding.INTERFACE_ID_WITH_PACKAGE_ID)))
            .filter(
                h ->
                    h.account.owner.equals(Optional.of(signer.party().partyId()))
                        && h.account.provider.isEmpty()
                        && h.account.id.isEmpty())
            .toList();
    return new Balances(balances(holdings, catalog.instruments()), offset);
  }

  static List<Balance> balances(
      List<HoldingView> holdings, List<InstrumentCatalog.Instrument> instruments) {
    var balances = new ArrayList<Balance>();
    for (var token : instruments) {
      BigDecimal available = BigDecimal.ZERO, locked = BigDecimal.ZERO;
      for (var holding : holdings) {
        if (!holding.instrumentId.admin.equals(token.admin())
            || !holding.instrumentId.id.equals(token.id())) continue;
        if (holding.lock.isPresent()) locked = locked.add(holding.amount);
        else available = available.add(holding.amount);
      }
      balances.add(
          new Balance(
              new Instrument(token.admin(), token.id()),
              token.symbol(),
              token.decimals(),
              decimal(available),
              decimal(locked),
              decimal(available.add(locked))));
    }
    return List.copyOf(balances);
  }

  private Optional<Confirmation> grant(Transaction tx, Claim claim, Signer signer) {
    var registry = store.registry();
    var operator = ledger.primaryParty();
    return one(
        created(tx, TestTokenGrant.TEMPLATE_ID_WITH_PACKAGE_ID).stream()
            .filter(
                e -> {
                  var value =
                      TestTokenGrant.valueDecoder()
                          .decode(DamlRecord.fromProto(e.getCreateArguments()));
                  return value.grantId.equals(claim.grantId().toString())
                      && value.recipient.equals(signer.party().partyId())
                      && value.issuer.equals(registry.issuerPartyId())
                      && value.operator.equals(operator)
                      && value.rulesCid.contractId.equals(registry.rulesId());
                })
            .map(e -> new Confirmation(e.getContractId(), tx.getUpdateId()))
            .toList());
  }

  private Optional<Confirmation> receipt(Transaction tx, Claim claim, Signer signer) {
    var registry = store.registry();
    var operator = ledger.primaryParty();
    return one(
        created(tx, TestTokenReceipt.TEMPLATE_ID_WITH_PACKAGE_ID).stream()
            .filter(
                e -> {
                  var value =
                      TestTokenReceipt.valueDecoder()
                          .decode(DamlRecord.fromProto(e.getCreateArguments()));
                  return value.grantId.equals(claim.grantId().toString())
                      && value.recipient.equals(signer.party().partyId())
                      && value.issuer.equals(registry.issuerPartyId())
                      && value.operator.equals(operator)
                      && value.rulesCid.contractId.equals(registry.rulesId());
                })
            .map(e -> new Confirmation(e.getContractId(), tx.getUpdateId()))
            .toList());
  }

  private static List<CreatedEvent> created(Transaction tx, Identifier template) {
    return tx.getEventsList().stream()
        .filter(e -> e.hasCreated())
        .map(e -> e.getCreated())
        .filter(
            e ->
                e.getTemplateId().getModuleName().equals(template.getModuleName())
                    && e.getTemplateId().getEntityName().equals(template.getEntityName())
                    && template.getPackageId().equals(e.getTemplateId().getPackageId()))
        .toList();
  }

  private static Transaction submit(Supplier<Transaction> submission) {
    try {
      return submission.get();
    } catch (StatusRuntimeException failure) {
      if (CantonPoolLedger.definitivelyRejected(failure))
        throw new TokenLedger.Rejected("Participant rejected the test token command", failure);
      throw failure;
    } catch (IllegalArgumentException failure) {
      throw new TokenLedger.Rejected(
          "The test token command was rejected before submission", failure);
    }
  }

  private static Optional<Confirmation> one(List<Confirmation> results) {
    if (results.size() > 1)
      throw new IllegalStateException("More than one matching test token effect");
    return results.stream().findFirst();
  }

  private static InteractiveTransactions.Prepared stored(Claim claim, Signer signer) {
    var prepared = claim.prepared();
    return new InteractiveTransactions.Prepared(
        prepared.preparedTransaction(),
        prepared.preparedTransactionHash(),
        prepared.hashingSchemeVersion(),
        signer.party().partyId(),
        signer.party().publicKeyFingerprint(),
        prepared.expiresAt());
  }

  private static String claimCommand(Claim claim) {
    return "test-token-claim-" + claim.grantId();
  }

  private static String decimal(BigDecimal amount) {
    return amount.stripTrailingZeros().toPlainString();
  }
}
