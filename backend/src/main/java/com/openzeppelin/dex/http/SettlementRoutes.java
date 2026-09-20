package com.openzeppelin.dex.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.http.RequestBody;
import com.openzeppelin.dex.settlements.*;
import java.util.UUID;
import org.springframework.context.annotation.*;
import org.springframework.web.servlet.function.*;

@Configuration(proxyBeanMethods = false)
public class SettlementRoutes {
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
                                  swap ->
                                      swap.status()
                                          == com.openzeppelin.dex.swaps.SwapModels.Status.READY)
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
            "/v1/admin/pools/{poolId}/settlement-policy",
            r ->
                ServerResponse.ok()
                    .body(workflow.policy(r.pathVariable("poolId"), CurrentAccount.from(r))))
        .PUT(
            "/v1/admin/pools/{poolId}/settlement-policy",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.updatePolicy(
                            r.pathVariable("poolId"),
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
