package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;

import com.daml.ledger.api.v2.admin.PartyManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.PartyManagementServiceOuterClass.*;
import com.sun.net.httpserver.HttpServer;
import io.grpc.Server;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.StreamObserver;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class CantonAdminTest {
  private static final String HINT = "dex-operator";
  private static final String LOCAL = HINT + "::current-participant";
  private static final PartyDetails REMOTE = party(HINT + "::previous-participant", false);
  private final Map<String, ListKnownPartiesResponse> pages = new ConcurrentHashMap<>();
  private final List<ListKnownPartiesRequest> listings = new CopyOnWriteArrayList<>();
  private final List<AllocatePartyRequest> allocations = new CopyOnWriteArrayList<>();
  private HttpServer auth;
  private Server grpc;
  private LedgerConnection ledger;
  private CantonAdmin admin;

  @BeforeEach
  void startServers() throws Exception {
    auth = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    auth.createContext(
        "/token",
        exchange -> {
          byte[] body =
              "{\"access_token\":\"service-token\",\"expires_in\":3600}"
                  .getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(200, body.length);
          try (var output = exchange.getResponseBody()) {
            output.write(body);
          }
        });
    auth.start();
    grpc =
        NettyServerBuilder.forAddress(new InetSocketAddress("127.0.0.1", 0))
            .addService(
                new PartyManagementServiceGrpc.PartyManagementServiceImplBase() {
                  @Override
                  public void listKnownParties(
                      ListKnownPartiesRequest request,
                      StreamObserver<ListKnownPartiesResponse> observer) {
                    listings.add(request);
                    observer.onNext(pages.get(request.getPageToken()));
                    observer.onCompleted();
                  }

                  @Override
                  public void allocateParty(
                      AllocatePartyRequest request,
                      StreamObserver<AllocatePartyResponse> observer) {
                    allocations.add(request);
                    var allocated = party(LOCAL, true);
                    pages.put(
                        "",
                        ListKnownPartiesResponse.newBuilder()
                            .addPartyDetails(REMOTE)
                            .addPartyDetails(allocated)
                            .build());
                    observer.onNext(
                        AllocatePartyResponse.newBuilder().setPartyDetails(allocated).build());
                    observer.onCompleted();
                  }
                })
            .build()
            .start();
    ledger =
        new LedgerConnection(
            "127.0.0.1",
            grpc.getPort(),
            URI.create("http://127.0.0.1:" + auth.getAddress().getPort() + "/token"),
            new LedgerIdentity("admin", "admin", "test-secret"));
    admin = new CantonAdmin(ledger);
  }

  @AfterEach
  void closeServers() throws Exception {
    if (ledger != null) ledger.close();
    if (grpc != null) grpc.shutdownNow().awaitTermination();
    if (auth != null) auth.stop(0);
  }

  @Test
  void reusesLocalPartyEvenWhenRemotePartyAppearsFirst() {
    pages.put(
        "",
        ListKnownPartiesResponse.newBuilder()
            .addPartyDetails(REMOTE)
            .addPartyDetails(party(LOCAL, true))
            .build());

    assertThat(admin.ensureParty(HINT)).isEqualTo(LOCAL);
    assertThat(allocations).isEmpty();
    assertThat(listings)
        .singleElement()
        .satisfies(r -> assertThat(r.getFilterParty()).isEqualTo(HINT + "::"));
  }

  @Test
  void looksForLocalPartyAcrossPagesBeforeAllocating() {
    pages.put(
        "",
        ListKnownPartiesResponse.newBuilder()
            .addPartyDetails(REMOTE)
            .setNextPageToken("next")
            .build());
    pages.put(
        "next", ListKnownPartiesResponse.newBuilder().addPartyDetails(party(LOCAL, true)).build());

    assertThat(admin.ensureParty(HINT)).isEqualTo(LOCAL);
    assertThat(listings)
        .extracting(ListKnownPartiesRequest::getPageToken)
        .containsExactly("", "next");
    assertThat(allocations).isEmpty();
  }

  @Test
  void allocatesLocalPartyWhenOnlyRemoteOrDifferentHintsExistAndReusesItOnRetry() {
    pages.put(
        "",
        ListKnownPartiesResponse.newBuilder()
            .addPartyDetails(REMOTE)
            .addPartyDetails(party("other-" + LOCAL, true))
            .build());

    assertThat(admin.ensureParty(HINT)).isEqualTo(LOCAL);
    assertThat(admin.ensureParty(HINT)).isEqualTo(LOCAL);
    assertThat(allocations)
        .singleElement()
        .satisfies(r -> assertThat(r.getPartyIdHint()).isEqualTo(HINT));
  }

  private static PartyDetails party(String id, boolean local) {
    return PartyDetails.newBuilder().setParty(id).setIsLocal(local).build();
  }
}
