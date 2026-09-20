package com.openzeppelin.dex.canton;

import static com.daml.ledger.api.v2.interactive.InteractiveSubmissionServiceOuterClass.*;
import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.CryptoOuterClass;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.api.v2.interactive.InteractiveSubmissionServiceGrpc;
import com.daml.ledger.javaapi.data.CreateCommand;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.codegen.Update;
import com.google.protobuf.ByteString;
import com.google.protobuf.UnknownFieldSet;
import com.openzeppelin.dex.onboarding.Onboarding;
import io.grpc.*;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.StreamObserver;
import java.net.InetSocketAddress;
import java.net.URI;
import java.security.*;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.junit.jupiter.api.Test;

class InteractiveTransactionsTest {
  private static final Provider EC_PROVIDER = new BouncyCastleProvider();
  private static final Identifier TEMPLATE = new Identifier("package", "Test", "Rules");

  @Test
  void secp256k1RelaysFreshCallerTokensAndOpaquePreparation() throws Exception {
    roundTrip("secp256k1");
  }

  @Test
  void ed25519UsesRawSignatureAndPreservesParticipantHashingScheme() throws Exception {
    roundTrip("Ed25519");
  }

  @Test
  void pv35PhysicalSynchronizerPreservesSignedTransactionBytes() throws Exception {
    roundTrip("secp256k1", "synchronizer::35-0");
  }

  @Test
  void physicalSynchronizerRequiresTheExactLogicalIdAndCanonicalBoundedSuffix() {
    assertThat(InteractiveTransactions.matchesSynchronizer("synchronizer", "synchronizer"))
        .isTrue();
    assertThat(InteractiveTransactions.matchesSynchronizer("synchronizer::35-0", "synchronizer"))
        .isTrue();
    assertThat(InteractiveTransactions.matchesSynchronizer("synchronizer::35-12", "synchronizer"))
        .isTrue();
    for (String invalid :
        List.of(
            "other::35-0",
            "synchronizer-extra::35-0",
            "synchronizer::34-0",
            "synchronizer::035-0",
            "synchronizer::35-00",
            "synchronizer::35-",
            "synchronizer::35--1",
            "synchronizer::35-0-extra",
            "synchronizer::35-0::extra",
            "synchronizer::2147483648-0",
            "synchronizer::35-2147483648")) {
      assertThat(InteractiveTransactions.matchesSynchronizer(invalid, "synchronizer"))
          .as(invalid)
          .isFalse();
    }
  }

  private static void roundTrip(String algorithm) throws Exception {
    roundTrip(algorithm, "synchronizer");
  }

  private static void roundTrip(String algorithm, String synchronizer) throws Exception {
    var key = key(algorithm);
    var signer = signer(key, "trader::key", "fingerprint");
    byte[] hash = new byte[32];
    new SecureRandom().nextBytes(hash);
    Instant expiresAt = Instant.ofEpochSecond(Instant.now().getEpochSecond() + 90, 123456789);
    Instant normalizedExpiry = expiresAt.truncatedTo(ChronoUnit.MICROS);
    var responseScheme = new AtomicInteger(3);
    var base = prepared(signer.partyId(), expiresAt);
    var transaction =
        base.toBuilder()
            .setMetadata(base.getMetadata().toBuilder().setSynchronizerId(synchronizer))
            .build();
    var preparationRequests = new ArrayList<PrepareSubmissionRequest>();
    var executionRequests = new ArrayList<ExecuteSubmissionAndWaitForTransactionRequest>();
    var tokens = new ArrayList<String>();
    var rpc =
        new InteractiveSubmissionServiceGrpc.InteractiveSubmissionServiceImplBase() {
          @Override
          public void prepareSubmission(
              PrepareSubmissionRequest request,
              StreamObserver<PrepareSubmissionResponse> observer) {
            preparationRequests.add(request);
            observer.onNext(
                PrepareSubmissionResponse.newBuilder()
                    .setPreparedTransaction(transaction)
                    .setPreparedTransactionHash(ByteString.copyFrom(hash))
                    .setHashingSchemeVersionValue(responseScheme.get())
                    .build());
            observer.onCompleted();
          }

          @Override
          public void executeSubmissionAndWaitForTransaction(
              ExecuteSubmissionAndWaitForTransactionRequest request,
              StreamObserver<ExecuteSubmissionAndWaitForTransactionResponse> observer) {
            executionRequests.add(request);
            observer.onNext(
                ExecuteSubmissionAndWaitForTransactionResponse.newBuilder()
                    .setTransaction(Transaction.newBuilder().setUpdateId("confirmed-update"))
                    .build());
            observer.onCompleted();
          }
        };
    var server =
        NettyServerBuilder.forAddress(new InetSocketAddress("127.0.0.1", 0))
            .addService(
                ServerInterceptors.intercept(
                    rpc,
                    new ServerInterceptor() {
                      @Override
                      public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                          ServerCall<ReqT, RespT> call,
                          io.grpc.Metadata headers,
                          ServerCallHandler<ReqT, RespT> next) {
                        tokens.add(
                            headers.get(
                                io.grpc.Metadata.Key.of(
                                    "Authorization", io.grpc.Metadata.ASCII_STRING_MARSHALLER)));
                        return next.startCall(call, headers);
                      }
                    }))
            .build()
            .start();
    try (var ledger =
        new LedgerConnection(
            "127.0.0.1",
            server.getPort(),
            URI.create("http://127.0.0.1:1"),
            new LedgerIdentity("operator", "operator", "unused"))) {
      var interactive = new InteractiveTransactions(ledger);
      var disclosure =
          DisclosedContract.newBuilder()
              .setContractId("rules-cid")
              .setTemplateId(TEMPLATE.toProto())
              .setCreatedEventBlob(ByteString.copyFromUtf8("participant-event-blob"))
              .setSynchronizerId("synchronizer")
              .build();
      var stored =
          interactive.prepare(
              "command",
              "caller-user",
              "prepare-token",
              signer,
              new Update.CreateUpdate<>(
                  new CreateCommand(TEMPLATE, new DamlRecord()),
                  created -> "result",
                  Function.identity()),
              List.of(disclosure),
              expiresAt);
      assertThat(stored.preparedTransaction()).isEqualTo(encode(transaction.toByteArray()));
      assertThat(stored.preparedTransactionHash()).isEqualTo(encode(hash));
      assertThat(stored.hashingSchemeVersion()).isEqualTo(3);
      assertThat(stored.expiresAt()).isEqualTo(normalizedExpiry);
      String signature = sign(key, algorithm, hash);
      InteractiveTransactions.verify(stored, signature, signer);
      var result =
          interactive.execute(
              "submission", stored, signature, signer, "fresh-token", "caller-user");
      assertThat(result.getUpdateId()).isEqualTo("confirmed-update");
      assertThat(tokens).containsExactly("Bearer prepare-token", "Bearer fresh-token");
      var prepare = preparationRequests.getFirst();
      assertThat(prepare.getUserId()).isEqualTo("caller-user");
      assertThat(prepare.getCommandId()).isEqualTo("command");
      assertThat(prepare.getActAsList()).containsExactly(signer.partyId());
      assertThat(prepare.getReadAsList()).isEmpty();
      assertThat(prepare.getDisclosedContractsList()).containsExactly(disclosure);
      assertThat(prepare.hasMinLedgerTime()).isFalse();
      assertThat(prepare.getMaxRecordTime().getSeconds()).isEqualTo(expiresAt.getEpochSecond());
      assertThat(prepare.getMaxRecordTime().getNanos()).isEqualTo(normalizedExpiry.getNano());
      assertThat(prepare.getHashingSchemeVersionValue()).isEqualTo(3);
      assertThat(prepare.getPackageIdSelectionPreferenceList())
          .containsExactly(com.openzeppelin.dex.canton.generated.pool.Pool.PACKAGE_ID);
      var execute = executionRequests.getFirst();
      assertThat(execute.getTransactionFormat().getEventFormat().getFiltersByPartyMap())
          .containsOnlyKeys(signer.partyId());
      assertThat(
              execute
                  .getTransactionFormat()
                  .getEventFormat()
                  .getFiltersByPartyOrThrow(signer.partyId()))
          .isEqualTo(InterfaceViews.transactionFilter());
      assertThat(execute.getPreparedTransaction().toByteArray())
          .containsExactly(transaction.toByteArray());
      assertThat(execute.getUserId()).isEqualTo("caller-user");
      assertThat(execute.getSubmissionId()).isEqualTo("submission");
      assertThat(execute.getHashingSchemeVersionValue()).isEqualTo(3);
      var partySignature = execute.getPartySignatures().getSignatures(0);
      assertThat(partySignature.getParty()).isEqualTo(signer.partyId());
      var actualSignature = partySignature.getSignatures(0);
      assertThat(actualSignature.getSignedBy()).isEqualTo(signer.publicKeyFingerprint());
      assertThat(actualSignature.getSignature().toByteArray())
          .containsExactly(Base64.getDecoder().decode(signature));
      assertThat(actualSignature.getFormat())
          .isEqualTo(
              algorithm.equals("Ed25519")
                  ? CryptoOuterClass.SignatureFormat.SIGNATURE_FORMAT_RAW
                  : CryptoOuterClass.SignatureFormat.SIGNATURE_FORMAT_DER);
      assertThat(actualSignature.getSigningAlgorithmSpec())
          .isEqualTo(
              algorithm.equals("Ed25519")
                  ? CryptoOuterClass.SigningAlgorithmSpec.SIGNING_ALGORITHM_SPEC_ED25519
                  : CryptoOuterClass.SigningAlgorithmSpec.SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256);

      assertThatThrownBy(
              () ->
                  interactive.execute(
                      "bad-signature",
                      stored,
                      encode(new byte[64]),
                      signer,
                      "unused",
                      "caller-user"))
          .isInstanceOf(IllegalArgumentException.class);
      assertThat(executionRequests).hasSize(1);
      responseScheme.set(2);
      assertThatThrownBy(
              () ->
                  interactive.prepare(
                      "command",
                      "caller-user",
                      "prepare-token",
                      signer,
                      new Update.CreateUpdate<>(
                          new CreateCommand(TEMPLATE, new DamlRecord()),
                          created -> "result",
                          Function.identity()),
                      List.of(disclosure),
                      expiresAt))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageContaining("Hashing scheme V3");
      assertThat(executionRequests).hasSize(1);
    } finally {
      server.shutdownNow().awaitTermination();
    }
  }

  @Test
  void rejectsChangedKeyHashPartyFingerprintOrExpiredWorkBeforeSubmission() throws Exception {
    var key = key("secp256k1");
    var signer = signer(key, "trader::key", "fingerprint");
    byte[] hash = new byte[32];
    new SecureRandom().nextBytes(hash);
    String signature = sign(key, "secp256k1", hash);
    Instant expiresAt = Instant.now().plusSeconds(90);
    var stored =
        new InteractiveTransactions.Prepared(
            encode(prepared(signer.partyId(), expiresAt).toByteArray()),
            encode(hash),
            3,
            signer.partyId(),
            signer.publicKeyFingerprint(),
            expiresAt);
    InteractiveTransactions.verify(stored, signature, signer);
    assertThatThrownBy(
            () ->
                InteractiveTransactions.verify(
                    new InteractiveTransactions.Prepared(
                        stored.preparedTransaction(),
                        stored.preparedTransactionHash(),
                        stored.hashingSchemeVersion(),
                        stored.partyId(),
                        stored.publicKeyFingerprint(),
                        stored.expiresAt().plusSeconds(1)),
                    signature,
                    signer))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("maximum record time");
    assertThatThrownBy(
            () ->
                InteractiveTransactions.verify(
                    stored,
                    signature,
                    signer(key("secp256k1"), signer.partyId(), signer.publicKeyFingerprint())))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                InteractiveTransactions.verify(
                    stored, signature, signer(key, "other-party", signer.publicKeyFingerprint())))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                InteractiveTransactions.verify(
                    stored, signature, signer(key, signer.partyId(), "other-fingerprint")))
        .isInstanceOf(IllegalArgumentException.class);
    hash[0] ^= 1;
    assertThatThrownBy(
            () ->
                InteractiveTransactions.verify(
                    new InteractiveTransactions.Prepared(
                        stored.preparedTransaction(),
                        encode(hash),
                        3,
                        stored.partyId(),
                        stored.publicKeyFingerprint(),
                        stored.expiresAt()),
                    signature,
                    signer))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                InteractiveTransactions.verify(
                    new InteractiveTransactions.Prepared(
                        stored.preparedTransaction(),
                        stored.preparedTransactionHash(),
                        3,
                        stored.partyId(),
                        stored.publicKeyFingerprint(),
                        Instant.EPOCH),
                    signature,
                    signer))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                InteractiveTransactions.verify(
                    new InteractiveTransactions.Prepared(
                        encode(prepared("other-party", stored.expiresAt()).toByteArray()),
                        stored.preparedTransactionHash(),
                        3,
                        stored.partyId(),
                        stored.publicKeyFingerprint(),
                        stored.expiresAt()),
                    signature,
                    signer))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                InteractiveTransactions.verify(
                    new InteractiveTransactions.Prepared(
                        stored.preparedTransaction(),
                        stored.preparedTransactionHash(),
                        2,
                        stored.partyId(),
                        stored.publicKeyFingerprint(),
                        stored.expiresAt()),
                    signature,
                    signer))
        .isInstanceOf(IllegalArgumentException.class);
  }

  private static PreparedTransaction prepared(String party, Instant expiresAt) {
    return PreparedTransaction.newBuilder()
        .setMetadata(
            com.daml.ledger.api.v2.interactive.InteractiveSubmissionServiceOuterClass.Metadata
                .newBuilder()
                .setSynchronizerId("synchronizer")
                .setMaxRecordTime(
                    expiresAt.getEpochSecond() * 1_000_000 + expiresAt.getNano() / 1_000)
                .setSubmitterInfo(
                    com.daml.ledger.api.v2.interactive.InteractiveSubmissionServiceOuterClass
                        .Metadata.SubmitterInfo.newBuilder()
                        .setCommandId("command")
                        .addActAs(party)))
        .setUnknownFields(
            UnknownFieldSet.newBuilder()
                .addField(
                    100,
                    UnknownFieldSet.Field.newBuilder()
                        .addLengthDelimited(ByteString.copyFromUtf8("opaque-extra"))
                        .build())
                .build())
        .build();
  }

  private static Onboarding.PartyPreparation signer(KeyPair key, String party, String fingerprint) {
    return new Onboarding.PartyPreparation(
        UUID.randomUUID(),
        party,
        true,
        encode(key.getPublic().getEncoded()),
        fingerprint,
        encode(new byte[34]),
        "synchronizer",
        "CONFIRMED",
        "participant",
        List.of());
  }

  private static KeyPair key(String algorithm) throws Exception {
    if (algorithm.equals("Ed25519"))
      return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    var generator = KeyPairGenerator.getInstance("EC", EC_PROVIDER);
    generator.initialize(new ECGenParameterSpec(algorithm));
    return generator.generateKeyPair();
  }

  private static String sign(KeyPair key, String algorithm, byte[] hash) throws Exception {
    var signing =
        algorithm.equals("Ed25519")
            ? Signature.getInstance("Ed25519")
            : Signature.getInstance("SHA256withECDSA", EC_PROVIDER);
    signing.initSign(key.getPrivate());
    signing.update(hash);
    return encode(signing.sign());
  }

  private static String encode(byte[] bytes) {
    return Base64.getEncoder().encodeToString(bytes);
  }
}
