package com.openzeppelin.dex.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.http.RequestBody;
import com.openzeppelin.dex.tokens.TokenModels.Submission;
import com.openzeppelin.dex.tokens.TokenWorkflow;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.function.RouterFunction;
import org.springframework.web.servlet.function.RouterFunctions;
import org.springframework.web.servlet.function.ServerResponse;

@Configuration(proxyBeanMethods = false)
public class TokenRoutes {
  @Bean
  RouterFunction<ServerResponse> balanceEndpoints(TokenWorkflow workflow, ApiErrors errors) {
    return RouterFunctions.route()
        .GET(
            "/v1/balances",
            r ->
                ServerResponse.ok()
                    .body(workflow.balances(CurrentAccount.from(r), CurrentAccount.accessToken(r))))
        .filter(errors)
        .build();
  }

  @Bean
  @ConditionalOnProperty(name = "dex.development-tokens.enabled", havingValue = "true")
  RouterFunction<ServerResponse> faucetEndpoints(
      TokenWorkflow workflow, RequestBody body, ApiErrors errors) {
    return RouterFunctions.route()
        .GET(
            "/v1/dev/faucet",
            r -> ServerResponse.ok().body(workflow.status(CurrentAccount.from(r))))
        .POST(
            "/v1/dev/faucet/prepare",
            r ->
                ServerResponse.ok()
                    .body(workflow.prepare(CurrentAccount.from(r), CurrentAccount.accessToken(r))))
        .POST(
            "/v1/dev/faucet/submit",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.submit(
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, Submission.class))))
        .filter(errors)
        .build();
  }
}
