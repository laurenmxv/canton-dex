package com.openzeppelin.dex.canton;

import static com.daml.ledger.api.v2.TransactionFilterOuterClass.*;

import com.daml.ledger.api.v2.*;
import com.daml.ledger.api.v2.admin.UserManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.UserManagementServiceOuterClass.GetUserRequest;
import com.daml.ledger.javaapi.data.Command;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.codegen.Update;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.grpc.stub.MetadataUtils;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;
import tools.jackson.databind.json.JsonMapper;

/** One authenticated Ledger API identity. Party rights are enforced by Canton. */
public final class LedgerConnection implements AutoCloseable {
  private final ManagedChannel channel;
  private final URI tokenUrl;
  private final LedgerIdentity identity;
  private final HttpClient http =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final JsonMapper json = JsonMapper.builder().build();
  private String accessToken;
  private Instant refreshAt = Instant.MIN;

  public LedgerConnection(String host, int port, URI tokenUrl, LedgerIdentity identity) {
    this.channel =
        NettyChannelBuilder.forAddress(host, port)
            .usePlaintext()
            .maxInboundMessageSize(32 * 1024 * 1024)
            .build();
    this.tokenUrl = tokenUrl;
    this.identity = identity;
  }

  synchronized io.grpc.Channel authenticatedChannel() {
    if (Instant.now().isAfter(refreshAt)) refreshToken();
    return authenticatedChannel(accessToken);
  }

  /** Attaches a validated caller token for this call only; it is never cached or persisted. */
  public io.grpc.Channel authenticatedChannel(String callerToken) {
    var metadata = new Metadata();
    metadata.put(
        Metadata.Key.of("Authorization", Metadata.ASCII_STRING_MARSHALLER),
        "Bearer " + callerToken);
    return io.grpc.ClientInterceptors.intercept(
        channel, MetadataUtils.newAttachHeadersInterceptor(metadata));
  }

  private void refreshToken() {
    String form =
        "grant_type=client_credentials&client_id="
            + encode(identity.clientId())
            + "&client_secret="
            + encode(identity.clientSecret());
    try {
      var request =
          HttpRequest.newBuilder(tokenUrl)
              .timeout(Duration.ofSeconds(10))
              .header("Content-Type", "application/x-www-form-urlencoded")
              .POST(HttpRequest.BodyPublishers.ofString(form))
              .build();
      var response = http.send(request, HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() != 200)
        throw new IllegalStateException(
            "Ledger token request failed: HTTP " + response.statusCode());
      var payload = json.readTree(response.body());
      accessToken = payload.path("access_token").asString();
      if (accessToken.isBlank())
        throw new IllegalStateException("Ledger token response has no access token");
      refreshAt =
          Instant.now().plusSeconds(Math.max(1, payload.path("expires_in").asLong(60) - 20));
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Ledger authentication interrupted", e);
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Ledger authentication unavailable", e);
    }
  }

  private static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8);
  }

  public String primaryParty() {
    return UserManagementServiceGrpc.newBlockingStub(authenticatedChannel())
        .withDeadlineAfter(10, TimeUnit.SECONDS)
        .getUser(GetUserRequest.newBuilder().setUserId(identity.userId()).build())
        .getUser()
        .getPrimaryParty();
  }

  public long ledgerEnd() {
    return StateServiceGrpc.newBlockingStub(authenticatedChannel())
        .withDeadlineAfter(10, TimeUnit.SECONDS)
        .getLedgerEnd(StateServiceOuterClass.GetLedgerEndRequest.getDefaultInstance())
        .getOffset();
  }

  public String singleSynchronizer() {
    var synchronizers =
        StateServiceGrpc.newBlockingStub(authenticatedChannel())
            .withDeadlineAfter(10, TimeUnit.SECONDS)
            .getConnectedSynchronizers(
                StateServiceOuterClass.GetConnectedSynchronizersRequest.getDefaultInstance())
            .getConnectedSynchronizersList();
    if (synchronizers.size() != 1)
      throw new IllegalStateException("Configure exactly one development synchronizer");
    return synchronizers.getFirst().getSynchronizerId();
  }

  public List<TransactionOuterClass.Transaction> transactions(long beginOffset, String party) {
    long end = ledgerEnd();
    if (end <= beginOffset) return List.of();
    var filter =
        Filters.newBuilder()
            .addCumulative(
                CumulativeFilter.newBuilder()
                    .setWildcardFilter(WildcardFilter.getDefaultInstance()));
    var request =
        UpdateServiceOuterClass.GetUpdatesRequest.newBuilder()
            .setBeginExclusive(beginOffset)
            .setEndInclusive(end)
            .setUpdateFormat(
                UpdateFormat.newBuilder()
                    .setIncludeTransactions(
                        TransactionFormat.newBuilder()
                            .setEventFormat(
                                EventFormat.newBuilder()
                                    .putFiltersByParty(party, filter.build())
                                    .setVerbose(true))
                            .setTransactionShape(
                                TransactionShape.TRANSACTION_SHAPE_LEDGER_EFFECTS)))
            .build();
    var stream =
        UpdateServiceGrpc.newBlockingStub(authenticatedChannel())
            .withDeadlineAfter(20, TimeUnit.SECONDS)
            .getUpdates(request);
    var result = new ArrayList<TransactionOuterClass.Transaction>();
    stream.forEachRemaining(
        update -> {
          if (update.hasTransaction()) result.add(update.getTransaction());
        });
    return result;
  }

  public boolean connected() {
    return !StateServiceGrpc.newBlockingStub(authenticatedChannel())
        .withDeadlineAfter(10, TimeUnit.SECONDS)
        .getConnectedSynchronizers(
            StateServiceOuterClass.GetConnectedSynchronizersRequest.newBuilder()
                .setParty(primaryParty())
                .build())
        .getConnectedSynchronizersList()
        .isEmpty();
  }

  public boolean hasPackage(String packageId) {
    return PackageServiceGrpc.newBlockingStub(authenticatedChannel())
        .withDeadlineAfter(10, TimeUnit.SECONDS)
        .listPackages(PackageServiceOuterClass.ListPackagesRequest.getDefaultInstance())
        .getPackageIdsList()
        .contains(packageId);
  }

  public List<EventOuterClass.CreatedEvent> activeContracts(String party, Identifier template) {
    var filter =
        Filters.newBuilder()
            .addCumulative(
                CumulativeFilter.newBuilder()
                    .setTemplateFilter(
                        TemplateFilter.newBuilder().setTemplateId(template.toProto())))
            .build();
    var request =
        StateServiceOuterClass.GetActiveContractsRequest.newBuilder()
            .setActiveAtOffset(ledgerEnd())
            .setEventFormat(
                EventFormat.newBuilder().putFiltersByParty(party, filter).setVerbose(true))
            .build();
    var stream =
        StateServiceGrpc.newBlockingStub(authenticatedChannel())
            .withDeadlineAfter(30, TimeUnit.SECONDS)
            .getActiveContracts(request);
    var result = new ArrayList<EventOuterClass.CreatedEvent>();
    stream.forEachRemaining(
        response -> {
          if (response.hasActiveContract())
            result.add(response.getActiveContract().getCreatedEvent());
        });
    return List.copyOf(result);
  }

  public TransactionOuterClass.Transaction submit(
      String commandId, String actor, List<String> readers, Update<?> update) {
    var commands =
        CommandsOuterClass.Commands.newBuilder()
            .setUserId(identity.userId())
            .addPackageIdSelectionPreference(
                com.openzeppelin.dex.canton.generated.pool.Pool.PACKAGE_ID)
            .setCommandId(commandId)
            .addActAs(actor)
            .addAllReadAs(readers)
            .setDeduplicationDuration(com.google.protobuf.Duration.newBuilder().setSeconds(30));
    update.commands().stream().map(Command::toProtoCommand).forEach(commands::addCommands);
    var eventFormat = EventFormat.newBuilder().setVerbose(true);
    var wildcard =
        Filters.newBuilder()
            .addCumulative(
                CumulativeFilter.newBuilder()
                    .setWildcardFilter(WildcardFilter.getDefaultInstance()))
            .build();
    eventFormat.putFiltersByParty(actor, wildcard);
    readers.forEach(party -> eventFormat.putFiltersByParty(party, wildcard));
    return CommandServiceGrpc.newBlockingStub(authenticatedChannel())
        .withDeadlineAfter(60, TimeUnit.SECONDS)
        .submitAndWaitForTransaction(
            CommandServiceOuterClass.SubmitAndWaitForTransactionRequest.newBuilder()
                .setCommands(commands)
                .setTransactionFormat(
                    TransactionFormat.newBuilder()
                        .setEventFormat(eventFormat)
                        .setTransactionShape(TransactionShape.TRANSACTION_SHAPE_LEDGER_EFFECTS))
                .build())
        .getTransaction();
  }

  public static EventOuterClass.CreatedEvent created(
      TransactionOuterClass.Transaction transaction, Identifier template) {
    return transaction.getEventsList().stream()
        .filter(EventOuterClass.Event::hasCreated)
        .map(EventOuterClass.Event::getCreated)
        .filter(
            event ->
                event.getTemplateId().getModuleName().equals(template.getModuleName())
                    && event.getTemplateId().getEntityName().equals(template.getEntityName()))
        .findFirst()
        .orElseThrow(() -> new IllegalStateException("Transaction did not create " + template));
  }

  @Override
  public void close() {
    channel.shutdownNow();
    http.close();
  }
}
