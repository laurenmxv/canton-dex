package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.api.v2.TransactionFilterOuterClass.*;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.api.v2.UpdateServiceGrpc;
import com.daml.ledger.api.v2.UpdateServiceOuterClass.GetUpdatesRequest;
import com.daml.ledger.api.v2.admin.UserManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.UserManagementServiceOuterClass.GetUserRequest;
import com.daml.ledger.api.v2.admin.UserManagementServiceOuterClass.ListUserRightsRequest;
import com.daml.ledger.api.v2.admin.UserManagementServiceOuterClass.Right;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.codegen.Update;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.allocation.TokenAllocation;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.holding.TokenHolding;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.ChoiceContext;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.ExtraArgs;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import com.openzeppelin.dex.onboarding.Onboarding.PartyPreparation;
import com.openzeppelin.dex.onboarding.PartySignatures;
import java.math.BigDecimal;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.Signature;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.bouncycastle.jce.provider.BouncyCastleProvider;

/** Exercises the token standard directly using only the trader's token and wallet key. */
public final class DirectAllocationWithdrawal {
  private DirectAllocationWithdrawal() {}

  public record Snapshot(
      Set<String> activeAllocationIds,
      Set<String> fundedAllocationIds,
      Map<String, BigDecimal> available,
      Map<String, BigDecimal> locked) {
    public Snapshot {
      activeAllocationIds = Set.copyOf(activeAllocationIds);
      fundedAllocationIds = Set.copyOf(fundedAllocationIds);
      available = Map.copyOf(available);
      locked = Map.copyOf(locked);
    }
  }

  /** Waits for participant evidence that a signed transaction's record-time limit has passed. */
  public static void awaitRecordTimeAfter(
      LedgerConnection ledger, String token, PartyPreparation signer, Instant expiresAt) {
    requireTrader(ledger, token, signer.partyId());
    await("participant record time after the signed transaction expires")
        .atMost(Duration.ofSeconds(60))
        .pollInterval(Duration.ofMillis(500))
        .until(() -> recordTimeAfter(ledger, token, signer, expiresAt));
  }

  private static boolean recordTimeAfter(
      LedgerConnection ledger, String token, PartyPreparation signer, Instant expiresAt) {
    long end = ledger.ledgerEnd(token);
    if (end == 0) return false;
    var filter =
        Filters.newBuilder()
            .addCumulative(
                CumulativeFilter.newBuilder()
                    .setWildcardFilter(WildcardFilter.getDefaultInstance()));
    var request =
        GetUpdatesRequest.newBuilder()
            .setBeginExclusive(Math.max(0, end - 1))
            .setEndInclusive(end)
            .setUpdateFormat(
                UpdateFormat.newBuilder()
                    .setIncludeTransactions(
                        TransactionFormat.newBuilder()
                            .setEventFormat(
                                EventFormat.newBuilder()
                                    .putFiltersByParty(signer.partyId(), filter.build())
                                    .setVerbose(true))
                            .setTransactionShape(
                                TransactionShape.TRANSACTION_SHAPE_LEDGER_EFFECTS)))
            .build();
    var stream =
        UpdateServiceGrpc.newBlockingStub(ledger.authenticatedChannel(token))
            .withDeadlineAfter(10, TimeUnit.SECONDS)
            .getUpdates(request);
    boolean observed = false;
    while (stream.hasNext()) {
      var update = stream.next();
      if (update.hasTransaction()) {
        var transaction = update.getTransaction();
        assertThat(transaction.getOffset()).isLessThanOrEqualTo(end);
        if (transaction.getSynchronizerId().equals(signer.synchronizerId())
            && transaction.hasRecordTime())
          observed |= after(transaction.getRecordTime(), expiresAt);
      } else if (update.hasOffsetCheckpoint()) {
        var checkpoint = update.getOffsetCheckpoint();
        if (checkpoint.getOffset() <= end) {
          for (var time : checkpoint.getSynchronizerTimesList()) {
            if (time.getSynchronizerId().equals(signer.synchronizerId()) && time.hasRecordTime())
              observed |= after(time.getRecordTime(), expiresAt);
          }
        }
      }
    }
    return observed;
  }

  private static boolean after(com.google.protobuf.Timestamp timestamp, Instant deadline) {
    return Instant.ofEpochSecond(timestamp.getSeconds(), timestamp.getNanos()).isAfter(deadline);
  }

  public static Snapshot snapshot(
      LedgerConnection ledger, String token, String party, List<String> allocationCids) {
    requireTrader(ledger, token, party);
    assertThat(allocationCids).doesNotHaveDuplicates();
    long offset = ledger.ledgerEnd(token);
    var account = basicAccount(party);
    var available = new HashMap<String, BigDecimal>();
    var locked = new HashMap<String, BigDecimal>();
    var lockedHoldingIds = new HashSet<String>();
    for (var event : ledger.activeContracts(party, TokenHolding.TEMPLATE_ID, offset, token)) {
      assertThat(event.getTemplateId())
          .isEqualTo(TokenHolding.TEMPLATE_ID_WITH_PACKAGE_ID.toProto());
      var holding =
          TokenHolding.valueDecoder()
              .decode(DamlRecord.fromProto(event.getCreateArguments()))
              .holding;
      if (!holding.account.equals(account)) continue;
      assertThat(holding.amount).isPositive();
      var totals = holding.lock.isPresent() ? locked : available;
      totals.merge(holding.instrumentId.id, holding.amount, BigDecimal::add);
      if (holding.lock.isPresent()) lockedHoldingIds.add(event.getContractId());
    }
    var active = new HashSet<String>();
    var funded = new HashSet<String>();
    for (var event : ledger.activeContracts(party, TokenAllocation.TEMPLATE_ID, offset, token)) {
      if (!allocationCids.contains(event.getContractId())) continue;
      var allocation = allocation(event, party);
      active.add(event.getContractId());
      if (!allocation.lockedHoldingCids.isEmpty()) {
        funded.add(event.getContractId());
        assertThat(allocation.lockedHoldingCids)
            .allSatisfy(cid -> assertThat(lockedHoldingIds).contains(cid.contractId));
      }
    }
    return new Snapshot(active, funded, available, locked);
  }

  public static Transaction withdraw(
      LedgerConnection ledger,
      String token,
      String userId,
      PartyPreparation signer,
      PrivateKey key,
      String allocationCid) {
    assertThat(requireTrader(ledger, token, signer.partyId())).isEqualTo(userId);
    long offset = ledger.ledgerEnd(token);
    var matches =
        ledger
            .activeContracts(signer.partyId(), TokenAllocation.TEMPLATE_ID, offset, token)
            .stream()
            .filter(event -> event.getContractId().equals(allocationCid))
            .toList();
    assertThat(matches).hasSize(1);
    var allocation = allocation(matches.getFirst(), signer.partyId());
    assertThat(allocation.allocation.committed).isTrue();
    assertThat(allocation.allocation.settlementDeadline).isPresent();
    // This is a local precondition; the canonical choice independently enforces ledger time >
    // deadline.
    assertThat(Instant.now()).isAfter(allocation.allocation.settlementDeadline.orElseThrow());
    var command =
        new Allocation.ContractId(allocationCid)
            .exerciseAllocation_Withdraw(
                List.of(signer.partyId()),
                new ExtraArgs(new ChoiceContext(Map.of()), new Metadata(Map.of())));
    var transaction = execute(ledger, token, userId, signer, key, command);
    assertThat(transaction.getEventsList())
        .anySatisfy(
            event -> {
              assertThat(event.hasExercised()).isTrue();
              var exercise = event.getExercised();
              assertThat(exercise.getTemplateId())
                  .isEqualTo(TokenAllocation.TEMPLATE_ID_WITH_PACKAGE_ID.toProto());
              assertThat(exercise.getContractId()).isEqualTo(allocationCid);
              assertThat(exercise.getChoice()).isEqualTo("Allocation_Withdraw");
              assertThat(exercise.getConsuming()).isFalse();
              assertThat(exercise.getActingPartiesList()).containsExactly(signer.partyId());
            });
    return transaction;
  }

  private static Transaction execute(
      LedgerConnection ledger,
      String token,
      String userId,
      PartyPreparation signer,
      PrivateKey key,
      Update<?> command) {
    var interactive = new InteractiveTransactions(ledger);
    var prepared =
        interactive.prepare(
            UUID.randomUUID().toString(),
            userId,
            token,
            signer,
            command,
            List.of(),
            Instant.now().plusSeconds(45));
    String signature;
    try {
      var signing =
          PartySignatures.algorithm(signer.publicKey()) == PartySignatures.Algorithm.ED25519
              ? Signature.getInstance("Ed25519")
              : Signature.getInstance("SHA256withECDSA", new BouncyCastleProvider());
      signing.initSign(key);
      signing.update(Base64.getDecoder().decode(prepared.preparedTransactionHash()));
      signature = Base64.getEncoder().encodeToString(signing.sign());
    } catch (GeneralSecurityException failure) {
      throw new AssertionError("Cannot sign the direct wallet command", failure);
    }
    return interactive.execute(
        UUID.randomUUID().toString(), prepared, signature, signer, token, userId);
  }

  private static TokenAllocation allocation(CreatedEvent event, String party) {
    assertThat(event.getTemplateId())
        .isEqualTo(TokenAllocation.TEMPLATE_ID_WITH_PACKAGE_ID.toProto());
    var allocation =
        TokenAllocation.valueDecoder().decode(DamlRecord.fromProto(event.getCreateArguments()));
    assertThat(allocation.allocation.authorizer).isEqualTo(basicAccount(party));
    return allocation;
  }

  private static Account basicAccount(String party) {
    return new Account(Optional.of(party), Optional.empty(), "");
  }

  private static String requireTrader(LedgerConnection ledger, String token, String party) {
    var users =
        UserManagementServiceGrpc.newBlockingStub(ledger.authenticatedChannel(token))
            .withDeadlineAfter(10, TimeUnit.SECONDS);
    var user =
        users
            .getUser(GetUserRequest.newBuilder().setIdentityProviderId("dex-users").build())
            .getUser();
    assertThat(user.getIdentityProviderId()).isEqualTo("dex-users");
    var rights =
        users
            .listUserRights(
                ListUserRightsRequest.newBuilder().setIdentityProviderId("dex-users").build())
            .getRightsList();
    assertThat(rights)
        .containsExactly(
            Right.newBuilder().setCanActAs(Right.CanActAs.newBuilder().setParty(party)).build());
    return user.getId();
  }
}
