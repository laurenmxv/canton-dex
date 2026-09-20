package com.openzeppelin.dex.canton;

import static com.daml.ledger.api.v2.TransactionFilterOuterClass.*;
import static com.daml.ledger.api.v2.interactive.InteractiveSubmissionServiceOuterClass.*;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.CryptoOuterClass;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.api.v2.interactive.InteractiveSubmissionServiceGrpc;
import com.daml.ledger.javaapi.data.Command;
import com.daml.ledger.javaapi.data.codegen.Update;
import com.google.protobuf.ByteString;
import com.google.protobuf.InvalidProtocolBufferException;
import com.google.protobuf.Timestamp;
import com.openzeppelin.dex.onboarding.Onboarding;
import com.openzeppelin.dex.onboarding.PartySignatures;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Relays a single external party's transaction with its caller token and wallet signature. */
public final class InteractiveTransactions {
  /** Backend-owned preparation. HTTP callers provide its ID and signature, never these bytes. */
  public record Prepared(
      String preparedTransaction,
      String preparedTransactionHash,
      int hashingSchemeVersion,
      String partyId,
      String publicKeyFingerprint,
      Instant expiresAt) {}

  private final LedgerConnection ledger;

  public InteractiveTransactions(LedgerConnection ledger) {
    this.ledger = ledger;
  }

  public Prepared prepare(
      String commandId,
      String userId,
      String callerToken,
      Onboarding.PartyPreparation signer,
      Update<?> command,
      List<DisclosedContract> disclosures,
      Instant expiresAt) {
    expiresAt = expiresAt.truncatedTo(ChronoUnit.MICROS);
    requireSigner(signer);
    requireFuture(expiresAt);
    var commands = command.commands();
    if (commands.size() != 1)
      throw new IllegalArgumentException("Interactive submission requires one root command");
    if (disclosures.stream().anyMatch(disclosure -> disclosure.getCreatedEventBlob().isEmpty()))
      throw new IllegalArgumentException(
          "Disclosures require the participant's created-event blob");
    var request =
        PrepareSubmissionRequest.newBuilder()
            .setUserId(userId)
            .setCommandId(commandId)
            .addActAs(signer.partyId())
            .setSynchronizerId(signer.synchronizerId())
            .setHashingSchemeVersion(HashingSchemeVersion.HASHING_SCHEME_VERSION_V3)
            .addAllDisclosedContracts(disclosures)
            .addPackageIdSelectionPreference(
                com.openzeppelin.dex.canton.generated.pool.Pool.PACKAGE_ID)
            .setMaxRecordTime(timestamp(expiresAt));
    commands.stream().map(Command::toProtoCommand).forEach(request::addCommands);
    var response =
        InteractiveSubmissionServiceGrpc.newBlockingStub(ledger.authenticatedChannel(callerToken))
            .withDeadlineAfter(30, TimeUnit.SECONDS)
            .prepareSubmission(request.build());
    if (!response.hasPreparedTransaction() || response.getPreparedTransactionHash().size() != 32)
      throw new IllegalStateException("Participant returned an invalid transaction preparation");
    requireHashingScheme(response.getHashingSchemeVersionValue());
    var transaction = response.getPreparedTransaction();
    requireSubmitter(transaction, signer);
    requireDeadline(transaction, expiresAt);
    if (!transaction.getMetadata().getSubmitterInfo().getCommandId().equals(commandId))
      throw new IllegalStateException("Participant prepared a different command");
    return new Prepared(
        encode(transaction.toByteArray()),
        encode(response.getPreparedTransactionHash().toByteArray()),
        response.getHashingSchemeVersionValue(),
        signer.partyId(),
        signer.publicKeyFingerprint(),
        expiresAt);
  }

  public Transaction execute(
      String submissionId,
      Prepared stored,
      String signature,
      Onboarding.PartyPreparation signer,
      String callerToken,
      String userId) {
    verify(stored, signature, signer);
    var prepared = decodeTransaction(stored.preparedTransaction());
    boolean ed25519 =
        PartySignatures.algorithm(signer.publicKey()) == PartySignatures.Algorithm.ED25519;
    var walletSignature =
        CryptoOuterClass.Signature.newBuilder()
            .setSignature(ByteString.copyFrom(Base64.getDecoder().decode(signature)))
            .setSignedBy(signer.publicKeyFingerprint())
            .setFormat(
                ed25519
                    ? CryptoOuterClass.SignatureFormat.SIGNATURE_FORMAT_RAW
                    : CryptoOuterClass.SignatureFormat.SIGNATURE_FORMAT_DER)
            .setSigningAlgorithmSpec(
                ed25519
                    ? CryptoOuterClass.SigningAlgorithmSpec.SIGNING_ALGORITHM_SPEC_ED25519
                    : CryptoOuterClass.SigningAlgorithmSpec.SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256);
    var parties =
        com.daml.ledger.api.v2.interactive.InteractiveSubmissionServiceOuterClass.PartySignatures
            .newBuilder()
            .addSignatures(
                SinglePartySignatures.newBuilder()
                    .setParty(signer.partyId())
                    .addSignatures(walletSignature));
    var request =
        ExecuteSubmissionAndWaitForTransactionRequest.newBuilder()
            .setUserId(userId)
            .setSubmissionId(submissionId)
            .setPreparedTransaction(prepared)
            .setHashingSchemeVersionValue(stored.hashingSchemeVersion())
            .setPartySignatures(parties)
            .setTransactionFormat(
                TransactionFormat.newBuilder()
                    .setEventFormat(
                        EventFormat.newBuilder()
                            .setVerbose(true)
                            .putFiltersByParty(
                                signer.partyId(), InterfaceViews.transactionFilter()))
                    .setTransactionShape(TransactionShape.TRANSACTION_SHAPE_LEDGER_EFFECTS))
            .build();
    // Omitting deduplication selects the participant's configured maximum. Unknown outcomes
    // belong to the caller's recovery workflow, never to a retry hidden in this adapter.
    return InteractiveSubmissionServiceGrpc.newBlockingStub(
            ledger.authenticatedChannel(callerToken))
        .withDeadlineAfter(60, TimeUnit.SECONDS)
        .executeSubmissionAndWaitForTransaction(request)
        .getTransaction();
  }

  /** Validate before claiming durable submission work, so a bad signature never becomes unknown. */
  public static void verify(Prepared stored, String signature, Onboarding.PartyPreparation signer) {
    requireSigner(signer);
    requireFuture(stored.expiresAt());
    if (!stored.partyId().equals(signer.partyId())
        || !stored.publicKeyFingerprint().equals(signer.publicKeyFingerprint()))
      throw new IllegalArgumentException("Preparation does not belong to the registered wallet");
    if (Base64.getDecoder().decode(stored.preparedTransactionHash()).length != 32)
      throw new IllegalArgumentException("Expected a 32-byte prepared transaction hash");
    requireHashingScheme(stored.hashingSchemeVersion());
    PartySignatures.verify(signer, stored.preparedTransactionHash(), signature);
    var prepared = decodeTransaction(stored.preparedTransaction());
    requireSubmitter(prepared, signer);
    requireDeadline(prepared, stored.expiresAt());
  }

  static void requireDeadline(PreparedTransaction transaction, Instant expiresAt) {
    // The prepared metadata encodes timestamps in microseconds since the Unix epoch.
    long expected =
        Math.addExact(
            Math.multiplyExact(expiresAt.getEpochSecond(), 1_000_000), expiresAt.getNano() / 1_000);
    if (!transaction.getMetadata().hasMaxRecordTime()
        || transaction.getMetadata().getMaxRecordTime() != expected)
      throw new IllegalArgumentException(
          "Participant did not bind the requested maximum record time");
  }

  private static void requireSigner(Onboarding.PartyPreparation signer) {
    if (signer == null || !signer.confirmed())
      throw new IllegalArgumentException("A confirmed external party is required");
    PartySignatures.algorithm(signer.publicKey());
  }

  private static void requireFuture(Instant expiresAt) {
    if (!Instant.now().isBefore(expiresAt))
      throw new IllegalArgumentException("Transaction preparation has expired");
  }

  private static void requireHashingScheme(int scheme) {
    if (scheme != HashingSchemeVersion.HASHING_SCHEME_VERSION_V3_VALUE)
      throw new IllegalArgumentException(
          "Hashing scheme V3 is required to sign the maximum record time");
  }

  private static void requireSubmitter(
      PreparedTransaction transaction, Onboarding.PartyPreparation signer) {
    if (!transaction.hasMetadata()
        || !transaction
            .getMetadata()
            .getSubmitterInfo()
            .getActAsList()
            .equals(List.of(signer.partyId()))
        || !matchesSynchronizer(
            transaction.getMetadata().getSynchronizerId(), signer.synchronizerId()))
      throw new IllegalArgumentException(
          "Prepared transaction has a different submitter or synchronizer");
  }

  static boolean matchesSynchronizer(String prepared, String logical) {
    if (prepared.equals(logical)) return true;
    // PV35+ hashes the physical ID: <logical-id>::<protocol-version>-<serial>.
    int delimiter = prepared.lastIndexOf("::");
    if (delimiter < 0 || !prepared.substring(0, delimiter).equals(logical)) return false;
    String suffix = prepared.substring(delimiter + 2);
    if (!suffix.matches("[1-9][0-9]*-(?:0|[1-9][0-9]*)")) return false;
    String[] components = suffix.split("-", -1);
    try {
      return Integer.parseInt(components[0]) >= 35 && Integer.parseInt(components[1]) >= 0;
    } catch (NumberFormatException invalidPhysicalId) {
      return false;
    }
  }

  private static PreparedTransaction decodeTransaction(String encoded) {
    try {
      return PreparedTransaction.parseFrom(Base64.getDecoder().decode(encoded));
    } catch (InvalidProtocolBufferException | IllegalArgumentException e) {
      throw new IllegalArgumentException("Invalid stored transaction preparation", e);
    }
  }

  private static Timestamp timestamp(Instant time) {
    return Timestamp.newBuilder()
        .setSeconds(time.getEpochSecond())
        .setNanos(time.getNano())
        .build();
  }

  private static String encode(byte[] bytes) {
    return Base64.getEncoder().encodeToString(bytes);
  }
}
