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
    return ledgerEnd(authenticatedChannel());
  }

  public long ledgerEnd(String callerToken) {
    return ledgerEnd(authenticatedChannel(callerToken));
  }

  private long ledgerEnd(io.grpc.Channel authorized) {
    return StateServiceGrpc.newBlockingStub(authorized)
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
    return history(beginOffset, party).transactions();
  }

  /**
   * Complete visible history through endOffset and a record-time watermark for one synchronizer.
   */
  public record History(
      List<TransactionOuterClass.Transaction> transactions,
      Optional<Instant> recordTime,
      long endOffset) {
    public History {
      transactions = List.copyOf(transactions);
    }
  }

  public History history(long beginOffset, String party) {
    long end = ledgerEnd();
    if (beginOffset < 0 || end < beginOffset)
      throw new IllegalArgumentException("History begins outside the current ledger range");
    if (end == 0) return new History(List.of(), Optional.empty(), end);
    String synchronizer = singleSynchronizer();
    var filter = InterfaceViews.transactionFilter();
    var request =
        UpdateServiceOuterClass.GetUpdatesRequest.newBuilder()
            // A one-offset overlap permits an end checkpoint even when the ledger offset has
            // not changed. The overlap's transaction is excluded from the returned history.
            .setBeginExclusive(beginOffset == end ? Math.max(0, end - 1) : beginOffset)
            .setEndInclusive(end)
            .setUpdateFormat(
                UpdateFormat.newBuilder()
                    .setIncludeTransactions(
                        TransactionFormat.newBuilder()
                            .setEventFormat(
                                EventFormat.newBuilder()
                                    .putFiltersByParty(party, filter)
                                    .setVerbose(true))
                            .setTransactionShape(
                                TransactionShape.TRANSACTION_SHAPE_LEDGER_EFFECTS)))
            .build();
    var stream =
        UpdateServiceGrpc.newBlockingStub(authenticatedChannel())
            .withDeadlineAfter(20, TimeUnit.SECONDS)
            .getUpdates(request);
    var result = new ArrayList<TransactionOuterClass.Transaction>();
    Instant recordTime = null;
    while (stream.hasNext()) {
      var update = stream.next();
      if (update.hasTransaction()) {
        var transaction = update.getTransaction();
        if (transaction.getOffset() > end)
          throw new IllegalStateException("Participant returned a transaction beyond the snapshot");
        if (transaction.getOffset() > beginOffset) result.add(transaction);
        if (transaction.getSynchronizerId().equals(synchronizer) && transaction.hasRecordTime())
          recordTime = latest(recordTime, transaction.getRecordTime());
      } else if (update.hasOffsetCheckpoint()) {
        var checkpoint = update.getOffsetCheckpoint();
        // A later watermark cannot prove absence in a history ending before that checkpoint.
        if (checkpoint.getOffset() <= end) {
          for (var time : checkpoint.getSynchronizerTimesList()) {
            if (time.getSynchronizerId().equals(synchronizer) && time.hasRecordTime())
              recordTime = latest(recordTime, time.getRecordTime());
          }
        }
      }
    }
    return new History(result, Optional.ofNullable(recordTime), end);
  }

  private static Instant latest(Instant previous, com.google.protobuf.Timestamp timestamp) {
    Instant current = Instant.ofEpochSecond(timestamp.getSeconds(), timestamp.getNanos());
    return previous == null || current.isAfter(previous) ? current : previous;
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
    var authorized = authenticatedChannel();
    return activeContracts(party, template, authorized, ledgerEnd(authorized));
  }

  public List<EventOuterClass.CreatedEvent> activeContracts(
      String party, Identifier template, long activeAtOffset) {
    return activeContracts(party, template, authenticatedChannel(), activeAtOffset);
  }

  public List<EventOuterClass.CreatedEvent> activeContracts(
      String party, Identifier template, String callerToken) {
    var authorized = authenticatedChannel(callerToken);
    return activeContracts(party, template, authorized, ledgerEnd(authorized));
  }

  /** A shared offset lets callers compare balances and pool reserves from the same ledger state. */
  public List<EventOuterClass.CreatedEvent> activeContracts(
      String party, Identifier template, long activeAtOffset, String callerToken) {
    return activeContracts(party, template, authenticatedChannel(callerToken), activeAtOffset);
  }

  private List<EventOuterClass.CreatedEvent> activeContracts(
      String party, Identifier template, io.grpc.Channel authorized, long activeAtOffset) {
    if (!template.getPackageId().startsWith("#"))
      throw new IllegalArgumentException(
          "Ledger template filters require package-name identifiers");
    var filter =
        Filters.newBuilder()
            .addCumulative(
                CumulativeFilter.newBuilder()
                    .setTemplateFilter(
                        TemplateFilter.newBuilder()
                            .setTemplateId(template.toProto())
                            .setIncludeCreatedEventBlob(true)))
            .build();
    return activeContracts(party, filter, authorized, activeAtOffset);
  }

  public List<EventOuterClass.CreatedEvent> activeInterfaceContracts(
      String party, Identifier interfaceId, long activeAtOffset) {
    return activeInterfaceContracts(party, interfaceId, authenticatedChannel(), activeAtOffset);
  }

  public List<EventOuterClass.CreatedEvent> activeInterfaceContracts(
      String party, Identifier interfaceId, long activeAtOffset, String callerToken) {
    return activeInterfaceContracts(
        party, interfaceId, authenticatedChannel(callerToken), activeAtOffset);
  }

  private List<EventOuterClass.CreatedEvent> activeInterfaceContracts(
      String party, Identifier interfaceId, io.grpc.Channel authorized, long activeAtOffset) {
    var filter = Filters.newBuilder().addCumulative(InterfaceViews.filter(interfaceId)).build();
    return activeContracts(party, filter, authorized, activeAtOffset);
  }

  private List<EventOuterClass.CreatedEvent> activeContracts(
      String party, Filters filter, io.grpc.Channel authorized, long activeAtOffset) {
    var request =
        StateServiceOuterClass.GetActiveContractsRequest.newBuilder()
            .setActiveAtOffset(activeAtOffset)
            .setEventFormat(
                EventFormat.newBuilder().putFiltersByParty(party, filter).setVerbose(true))
            .build();
    var stream =
        StateServiceGrpc.newBlockingStub(authorized)
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
    return submit(commandId, actor, readers, update, List.of());
  }

  public TransactionOuterClass.Transaction submit(
      String commandId,
      String actor,
      List<String> readers,
      Update<?> update,
      List<CommandsOuterClass.DisclosedContract> disclosures) {
    var commands =
        CommandsOuterClass.Commands.newBuilder()
            .setUserId(identity.userId())
            .addPackageIdSelectionPreference(
                com.openzeppelin.dex.canton.generated.pool.Pool.PACKAGE_ID)
            .setCommandId(commandId)
            .addActAs(actor)
            .addAllReadAs(readers)
            .addAllDisclosedContracts(disclosures)
            .setDeduplicationDuration(com.google.protobuf.Duration.newBuilder().setSeconds(30));
    update.commands().stream().map(Command::toProtoCommand).forEach(commands::addCommands);
    var eventFormat = EventFormat.newBuilder().setVerbose(true);
    var filter = InterfaceViews.transactionFilter();
    eventFormat.putFiltersByParty(actor, filter);
    readers.forEach(party -> eventFormat.putFiltersByParty(party, filter));
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

  /** Build once, then persist the entire protobuf before its first submission. */
  public CommandsOuterClass.Commands storedCommands(
      String commandId,
      String actor,
      List<String> readers,
      Update<?> update,
      long deduplicationOffset,
      List<CommandsOuterClass.DisclosedContract> disclosures) {
    if (deduplicationOffset < 0)
      throw new IllegalArgumentException("Deduplication offset must be non-negative");
    var commands =
        CommandsOuterClass.Commands.newBuilder()
            .setUserId(identity.userId())
            .setCommandId(commandId)
            .addActAs(actor)
            .addAllReadAs(readers)
            .addAllDisclosedContracts(disclosures)
            .setDeduplicationOffset(deduplicationOffset)
            .addPackageIdSelectionPreference(
                com.openzeppelin.dex.canton.generated.pool.Pool.PACKAGE_ID);
    update.commands().stream().map(Command::toProtoCommand).forEach(commands::addCommands);
    return commands.build();
  }

  /**
   * Retry the same stored intent on this participant. Never advance its deduplication offset,
   * including when Canton rejects an offset as unsupported or pruned.
   */
  public TransactionOuterClass.Transaction submitStored(CommandsOuterClass.Commands stored) {
    if (!stored.getUserId().equals(identity.userId()))
      throw new IllegalArgumentException("Stored command belongs to a different ledger user");
    if (!stored.hasDeduplicationOffset()
        || stored.getDeduplicationOffset() < 0
        || stored.getActAsCount() != 1
        || stored.getCommandsCount() == 0)
      throw new IllegalArgumentException(
          "Stored command requires one actor, commands, and an original offset");
    var eventFormat = EventFormat.newBuilder().setVerbose(true);
    var filter = InterfaceViews.transactionFilter();
    stored.getActAsList().forEach(party -> eventFormat.putFiltersByParty(party, filter));
    stored.getReadAsList().forEach(party -> eventFormat.putFiltersByParty(party, filter));
    return CommandServiceGrpc.newBlockingStub(authenticatedChannel())
        .withDeadlineAfter(60, TimeUnit.SECONDS)
        .submitAndWaitForTransaction(
            CommandServiceOuterClass.SubmitAndWaitForTransactionRequest.newBuilder()
                // Submission IDs identify individual attempts; they do not change the intent.
                .setCommands(stored.toBuilder().setSubmissionId(UUID.randomUUID().toString()))
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
