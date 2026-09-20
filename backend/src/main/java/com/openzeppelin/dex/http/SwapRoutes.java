package com.openzeppelin.dex.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.http.RequestBody;
import com.openzeppelin.dex.swaps.*;
import java.util.UUID;
import org.springframework.context.annotation.*;
import org.springframework.web.servlet.function.*;

@Configuration(proxyBeanMethods = false)
public class SwapRoutes {
  @Bean
  RouterFunction<ServerResponse> swapEndpoints(
      SwapWorkflow workflow, RequestBody body, ApiErrors errors) {
    return RouterFunctions.route()
        .POST(
            "/v1/swaps/quote",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.quote(
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, SwapModels.QuoteInput.class))))
        .POST(
            "/v1/swaps/prepare",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.prepare(
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, SwapModels.PrepareInput.class))))
        .POST(
            "/v1/swaps/submit",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.submit(
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, SwapModels.SubmitInput.class))))
        .GET(
            "/v1/swaps/{swapId}",
            r -> ServerResponse.ok().body(workflow.get(id(r), CurrentAccount.from(r))))
        .POST(
            "/v1/swaps/{swapId}/cancel/prepare",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.prepareWithdrawal(
                            id(r), CurrentAccount.from(r), CurrentAccount.accessToken(r))))
        .POST(
            "/v1/swaps/{swapId}/cancel/submit",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.withdraw(
                            id(r),
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, SwapModels.SubmitInput.class))))
        .GET(
            "/v1/activity",
            r -> {
              String type = r.param("type").orElse("swap");
              if (!type.equalsIgnoreCase("swap"))
                throw new IllegalArgumentException("Only swap activity is supported");
              return ServerResponse.ok()
                  .body(
                      workflow.activity(
                          CurrentAccount.from(r),
                          Integer.parseInt(r.param("limit").orElse("50")),
                          r.param("cursor").orElse(null),
                          r.param("status").orElse(null)));
            })
        .filter(errors)
        .build();
  }

  private static UUID id(ServerRequest request) {
    return UUID.fromString(request.pathVariable("swapId"));
  }
}
