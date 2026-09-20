package com.openzeppelin.dex.http;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.onboarding.http.RequestBody;
import com.openzeppelin.dex.settlements.SettlementStore;
import com.openzeppelin.dex.settlements.SettlementWorkflow;
import com.openzeppelin.dex.swaps.SwapModels.*;
import jakarta.servlet.http.HttpServletRequest;
import java.lang.reflect.Proxy;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.server.RequestPath;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.servlet.function.*;
import tools.jackson.databind.json.JsonMapper;

class SettlementRoutesTest {
  private final List<Swap> queue =
      List.of(
          swap(Status.READY), swap(Status.BLOCKED), swap(Status.UNRESOLVED), swap(Status.SETTLING));
  private int queueReads;
  private final SettlementStore store =
      new SettlementStore(null, null, null, 10) {
        @Override
        public List<Swap> queue(String poolId) {
          assertThat(poolId).isEqualTo("pool");
          queueReads++;
          return queue;
        }
      };
  private final RouterFunction<ServerResponse> routes =
      new SettlementRoutes()
          .settlementEndpoints(
              new SettlementWorkflow(store, null),
              new RequestBody(null),
              new ApiErrors(JsonMapper.builder().build()));

  @Test
  void defaultAndExplicitReadyReturnOnlyReadyRequests() throws Exception {
    for (String status : Arrays.asList(null, "READY")) {
      var response = request(status);
      assertThat(response.statusCode().value()).isEqualTo(200);
      assertThat(((EntityResponse<?>) response).entity()).isEqualTo(List.of(queue.getFirst()));
    }
  }

  @Test
  void explicitActiveKeepsTheWholeQueueInArrivalOrder() throws Exception {
    var response = request("active");
    assertThat(response.statusCode().value()).isEqualTo(200);
    assertThat(((EntityResponse<?>) response).entity()).isEqualTo(queue);
  }

  @Test
  void rejectsUnknownStatusWithoutReadingTheQueue() throws Exception {
    assertThat(request("unknown").statusCode().value()).isEqualTo(400);
    assertThat(queueReads).isZero();
  }

  private ServerResponse request(String status) throws Exception {
    var parameters = new LinkedMultiValueMap<String, String>();
    parameters.add("poolId", "pool");
    if (status != null) parameters.add("status", status);
    var attributes = new HashMap<String, Object>();
    var account =
        new Account(UUID.randomUUID(), "issuer", "operator", "Operator", Account.Role.OPERATOR);
    var authentication = new UsernamePasswordAuthenticationToken(account, null, List.of());
    var servlet =
        (HttpServletRequest)
            Proxy.newProxyInstance(
                HttpServletRequest.class.getClassLoader(),
                new Class<?>[] {HttpServletRequest.class},
                (proxy, method, args) ->
                    switch (method.getName()) {
                      case "getMethod" -> "GET";
                      case "getHeader" -> null;
                      case "getAttribute" -> attributes.get((String) args[0]);
                      case "setAttribute" -> {
                        attributes.put((String) args[0], args[1]);
                        yield null;
                      }
                      default -> throw new UnsupportedOperationException(method.getName());
                    });
    var request =
        (ServerRequest)
            Proxy.newProxyInstance(
                ServerRequest.class.getClassLoader(),
                new Class<?>[] {ServerRequest.class},
                (proxy, method, args) ->
                    switch (method.getName()) {
                      case "servletRequest" -> servlet;
                      case "method" -> HttpMethod.GET;
                      case "path" -> "/v1/admin/settlement-requests";
                      case "requestPath" -> RequestPath.parse("/v1/admin/settlement-requests", "");
                      case "param" -> Optional.ofNullable(parameters.getFirst((String) args[0]));
                      case "params" -> parameters;
                      case "pathVariables" -> Map.of();
                      case "attributes" -> attributes;
                      case "principal" -> Optional.of(authentication);
                      case "toString" -> "settlement-requests test";
                      default -> throw new UnsupportedOperationException(method.getName());
                    });
    return routes.route(request).orElseThrow().handle(request);
  }

  private static Swap swap(Status status) {
    var now = Instant.parse("2026-09-19T00:00:00Z");
    return new Swap(
        UUID.randomUUID(),
        null,
        "pool",
        "Pool",
        "trader",
        Direction.BaseToQuote,
        null,
        null,
        "1",
        "2",
        "0",
        "1",
        now.plusSeconds(60),
        status,
        1L,
        now,
        now,
        now,
        null,
        null,
        List.of(),
        null,
        null,
        null,
        false);
  }
}
