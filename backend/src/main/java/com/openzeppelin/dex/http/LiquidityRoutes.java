package com.openzeppelin.dex.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.liquidity.LiquidityModels.*;
import com.openzeppelin.dex.liquidity.LiquidityWorkflow;
import com.openzeppelin.dex.onboarding.http.RequestBody;
import java.util.UUID;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.function.*;

@Configuration(proxyBeanMethods = false)
public class LiquidityRoutes {
  @Bean
  RouterFunction<ServerResponse> liquidityEndpoints(
      LiquidityWorkflow workflow, RequestBody body, ApiErrors errors) {
    return RouterFunctions.route()
        .POST(
            "/v1/lp/deposit/quote",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.quoteDeposit(
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, DepositQuoteInput.class))))
        .POST(
            "/v1/lp/deposit/prepare",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.prepareDeposit(
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, PrepareDepositInput.class))))
        .POST(
            "/v1/lp/deposit/submit",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.submit(
                            Kind.DEPOSIT,
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, SubmitInput.class))))
        .GET(
            "/v1/lp/deposit/{depositId}",
            r ->
                ServerResponse.ok()
                    .body(workflow.get(id(r, "depositId"), Kind.DEPOSIT, CurrentAccount.from(r))))
        .POST(
            "/v1/lp/deposit/{depositId}/cancel/prepare",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.prepareRecovery(
                            id(r, "depositId"),
                            Kind.DEPOSIT,
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r))))
        .POST(
            "/v1/lp/deposit/{depositId}/cancel/submit",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.recover(
                            id(r, "depositId"),
                            Kind.DEPOSIT,
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, SubmitInput.class))))
        .POST(
            "/v1/lp/withdraw/quote",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.quoteWithdrawal(
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, WithdrawalQuoteInput.class))))
        .POST(
            "/v1/lp/withdraw/prepare",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.prepareWithdrawal(
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, PrepareWithdrawalInput.class))))
        .POST(
            "/v1/lp/withdraw/submit",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.submit(
                            Kind.WITHDRAW,
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, SubmitInput.class))))
        .GET(
            "/v1/lp/withdraw/{withdrawalId}",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.get(id(r, "withdrawalId"), Kind.WITHDRAW, CurrentAccount.from(r))))
        .POST(
            "/v1/lp/withdraw/{withdrawalId}/cancel/prepare",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.prepareRecovery(
                            id(r, "withdrawalId"),
                            Kind.WITHDRAW,
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r))))
        .POST(
            "/v1/lp/withdraw/{withdrawalId}/cancel/submit",
            r ->
                ServerResponse.accepted()
                    .body(
                        workflow.recover(
                            id(r, "withdrawalId"),
                            Kind.WITHDRAW,
                            CurrentAccount.from(r),
                            CurrentAccount.accessToken(r),
                            body.read(r, SubmitInput.class))))
        .GET(
            "/v1/lp/positions",
            r ->
                ServerResponse.ok()
                    .body(
                        workflow.positions(CurrentAccount.from(r), CurrentAccount.accessToken(r))))
        .filter(errors)
        .build();
  }

  private static UUID id(ServerRequest request, String name) {
    return UUID.fromString(request.pathVariable(name));
  }
}
