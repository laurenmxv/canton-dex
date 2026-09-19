package com.openzeppelin.dex.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.http.RequestBody;
import com.openzeppelin.dex.pools.*;
import java.util.UUID;
import org.springframework.context.annotation.*;
import org.springframework.web.servlet.function.*;

@Configuration(proxyBeanMethods = false)
public class PoolRoutes {
  @Bean
  RouterFunction<ServerResponse> poolEndpoints(
      PoolStore store, PoolWorkflow workflow, RequestBody body, ApiErrors errors) {
    return RouterFunctions.route()
        .GET("/v1/admin/pool-proposals/options", r -> ServerResponse.ok().body(workflow.options()))
        .GET("/v1/admin/pool-proposals", r -> ServerResponse.ok().body(store.proposals()))
        .POST(
            "/v1/admin/pool-proposals",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.create(
                            body.read(r, PoolModels.Create.class), CurrentAccount.from(r))))
        .GET(
            "/v1/admin/pool-proposals/{proposalId}",
            r -> ServerResponse.ok().body(store.get(UUID.fromString(r.pathVariable("proposalId")))))
        .POST(
            "/v1/admin/pool-proposals/{proposalId}/withdraw",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.withdraw(
                            UUID.fromString(r.pathVariable("proposalId")), CurrentAccount.from(r))))
        .GET("/v1/admin/pools", r -> ServerResponse.ok().body(workflow.pools()))
        .GET(
            "/v1/pools/{poolId}",
            r -> ServerResponse.ok().body(workflow.pool(r.pathVariable("poolId"))))
        .filter(errors)
        .build();
  }
}
