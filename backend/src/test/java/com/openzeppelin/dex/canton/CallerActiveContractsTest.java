package com.openzeppelin.dex.canton;

import static com.daml.ledger.api.v2.StateServiceOuterClass.*;
import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.api.v2.EventOuterClass.InterfaceView;
import com.daml.ledger.api.v2.StateServiceGrpc;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.google.protobuf.ByteString;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Holding;
import io.grpc.*;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.StreamObserver;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.*;
import org.junit.jupiter.api.Test;

class CallerActiveContractsTest {
  @Test
  void callerReadsUseFreshTokensFixedOffsetsAndCanonicalDisclosureBlobs() throws Exception {
    checkReads(new Identifier("#package", "Test", "Holding"), null);
  }

  @Test
  void issuerTemplatesUseExplicitPackageNameFilters() throws Exception {
    checkReads(
        com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.registry.TokenRules
            .TEMPLATE_ID,
        null);
  }

  @Test
  void interfaceReadsPreserveForeignTemplateViewsCallerTokenAndDisclosureBlob() throws Exception {
    checkReads(new Identifier("foreign-package", "Issuer.Asset", "Balance"), Holding.INTERFACE_ID);
  }

  private static void checkReads(Identifier template, Identifier interfaceId) throws Exception {
    var eventBuilder =
        CreatedEvent.newBuilder()
            .setContractId("holding-cid")
            .setTemplateId(template.toProto().toBuilder().setPackageId("concrete-issuer-package"))
            .setCreatedEventBlob(ByteString.copyFromUtf8("opaque-participant-blob"));
    if (interfaceId != null)
      eventBuilder.addInterfaceViews(
          InterfaceView.newBuilder()
              .setInterfaceId(Holding.INTERFACE_ID_WITH_PACKAGE_ID.toProto())
              .setViewValue(new DamlRecord().toProtoRecord()));
    var event = eventBuilder.build();
    var requests = new ArrayList<GetActiveContractsRequest>();
    var tokens = new ArrayList<String>();
    var rpc =
        new StateServiceGrpc.StateServiceImplBase() {
          @Override
          public void getLedgerEnd(
              GetLedgerEndRequest request, StreamObserver<GetLedgerEndResponse> observer) {
            observer.onNext(GetLedgerEndResponse.newBuilder().setOffset(88).build());
            observer.onCompleted();
          }

          @Override
          public void getActiveContracts(
              GetActiveContractsRequest request,
              StreamObserver<GetActiveContractsResponse> observer) {
            var filter =
                request.getEventFormat().getFiltersByPartyOrThrow("trader").getCumulative(0);
            var identifier =
                filter.hasTemplateFilter()
                    ? filter.getTemplateFilter().getTemplateId()
                    : filter.getInterfaceFilter().getInterfaceId();
            assertThat(identifier.getPackageId()).startsWith("#");
            requests.add(request);
            observer.onNext(
                GetActiveContractsResponse.newBuilder()
                    .setActiveContract(ActiveContract.newBuilder().setCreatedEvent(event))
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
                          Metadata headers,
                          ServerCallHandler<ReqT, RespT> next) {
                        tokens.add(
                            headers.get(
                                Metadata.Key.of(
                                    "Authorization", Metadata.ASCII_STRING_MARSHALLER)));
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
      assertThat(ledger.ledgerEnd("end-token")).isEqualTo(88);
      if (interfaceId == null) {
        assertThat(ledger.activeContracts("trader", template, 77, "fixed-token"))
            .containsExactly(event);
        assertThat(ledger.activeContracts("trader", template, "fresh-token"))
            .containsExactly(event);
      } else {
        assertThat(ledger.activeInterfaceContracts("trader", interfaceId, 77, "fixed-token"))
            .containsExactly(event);
        long offset = ledger.ledgerEnd("fresh-token");
        assertThat(ledger.activeInterfaceContracts("trader", interfaceId, offset, "fresh-token"))
            .containsExactly(event);
      }
      assertThat(tokens)
          .containsExactly(
              "Bearer end-token", "Bearer fixed-token", "Bearer fresh-token", "Bearer fresh-token");
      assertThat(requests)
          .extracting(GetActiveContractsRequest::getActiveAtOffset)
          .containsExactly(77L, 88L);
      assertThat(requests)
          .allSatisfy(
              request -> {
                assertThat(request.getEventFormat().getFiltersByPartyMap())
                    .containsOnlyKeys("trader");
                var filter =
                    request.getEventFormat().getFiltersByPartyOrThrow("trader").getCumulative(0);
                if (interfaceId == null) {
                  assertThat(filter.hasTemplateFilter()).isTrue();
                  assertThat(filter.getTemplateFilter().getTemplateId())
                      .isEqualTo(template.toProto());
                  assertThat(filter.getTemplateFilter().getIncludeCreatedEventBlob()).isTrue();
                } else {
                  assertThat(filter.hasInterfaceFilter()).isTrue();
                  assertThat(filter.getInterfaceFilter().getInterfaceId())
                      .isEqualTo(interfaceId.toProto());
                  assertThat(filter.getInterfaceFilter().getIncludeCreatedEventBlob()).isTrue();
                  assertThat(filter.getInterfaceFilter().getIncludeInterfaceView()).isTrue();
                }
              });
    } finally {
      server.shutdownNow().awaitTermination();
    }
  }
}
