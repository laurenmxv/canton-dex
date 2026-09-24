package com.openzeppelin.dex.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.http.RequestBody;
import com.openzeppelin.dex.settlements.*;
import java.util.UUID;
import org.springframework.context.annotation.*;
import org.springframework.web.servlet.function.*;

@Configuration(proxyBeanMethods = false)
public class SettlementRoutes {
  private static final String POLICY_PATH = "/v1/admin/pools/{poolId}/settlement-policy/{type}";

  @Bean
  RouterFunction<ServerResponse> settlementEndpoints(
      SettlementWorkflow workflow, RequestBody body, ApiErrors errors) {
    return RouterFunctions.route()
        .GET(
            "/v1/admin/settlement-requests",
            r -> {
              String status = r.param("status").orElse("READY");
              if (!status.equals("READY") && !status.equals("active"))
                throw new IllegalArgumentException("status must be READY or active");
              var queue = workflow.queue(poolParam(r), CurrentAccount.from(r));
              return ServerResponse.ok()
                  .body(
                      status.equals("active")
                          ? queue
                          : queue.stream()
                              .filter(
                                  request ->
                                      !request.deferred() && request.status().equals("READY"))
                              .toList());
            })
        .GET(
            "/v1/admin/settlements",
            r ->
                ServerResponse.ok()
                    .body(workflow.list(r.param("poolId").orElse(null), CurrentAccount.from(r))))
        .GET(
            "/v1/admin/settlements/{settlementId}",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.get(
                            UUID.fromString(r.pathVariable("settlementId")),
                            CurrentAccount.from(r))))
        .POST(
            "/v1/admin/pools/{poolId}/settlements",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.run(
                            r.pathVariable("poolId"),
                            body.read(r, SettlementModels.RunInput.class),
                            CurrentAccount.from(r))))
        .GET(
            "/v1/admin/pools/{poolId}/settlement-preview",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.preview(
                            r.pathVariable("poolId"),
                            r.param("type")
                                .orElseThrow(
                                    () -> new IllegalArgumentException("type is required")),
                            r.param("retryOf").map(UUID::fromString).orElse(null),
                            r.param("requestId").map(UUID::fromString).orElse(null),
                            CurrentAccount.from(r))))
        .PUT(
            "/v1/admin/pools/{poolId}/settlement-requests/{type}/{requestId}/deferred",
            r -> {
              workflow.setDeferred(
                  r.pathVariable("poolId"),
                  new SettlementModels.RequestRef(
                      r.pathVariable("type"), UUID.fromString(r.pathVariable("requestId"))),
                  body.read(r, SettlementModels.DeferredInput.class).deferred(),
                  CurrentAccount.from(r));
              return ServerResponse.noContent().build();
            })
        .GET(
            "/v1/admin/pools/{poolId}/settlement-history",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.history(
                            r.pathVariable("poolId"),
                            r.param("type").orElse(null),
                            r.param("status").map(SettlementModels.Status::valueOf).orElse(null),
                            r.param("before").orElse(null),
                            r.param("limit").map(Integer::parseInt).orElse(25),
                            CurrentAccount.from(r))))
        .GET(
            POLICY_PATH,
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.policy(
                            r.pathVariable("poolId"),
                            r.pathVariable("type"),
                            CurrentAccount.from(r))))
        .PUT(
            POLICY_PATH,
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.updatePolicy(
                            r.pathVariable("poolId"),
                            r.pathVariable("type"),
                            body.read(r, SettlementModels.UpdatePolicy.class),
                            CurrentAccount.from(r))))
        .GET(
            "/v1/admin/monitoring",
            r ->
                ServerResponse.ok().body(workflow.monitoring(poolParam(r), CurrentAccount.from(r))))
        .filter(errors)
        .build();
  }

  private static String poolParam(ServerRequest request) {
    return request
        .param("poolId")
        .filter(s -> !s.isBlank())
        .orElseThrow(() -> new IllegalArgumentException("poolId is required"));
  }
}
