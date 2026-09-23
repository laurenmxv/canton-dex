package com.openzeppelin.dex.http;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.liquidity.LiquidityModels;
import com.openzeppelin.dex.liquidity.LiquidityStore;
import com.openzeppelin.dex.liquidity.LiquidityWorkflow;
import com.openzeppelin.dex.onboarding.http.RequestBody;
import com.openzeppelin.dex.settlements.SettlementModels.*;
import com.openzeppelin.dex.swaps.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.context.annotation.*;
import org.springframework.web.servlet.function.*;

@Configuration(proxyBeanMethods = false)
public class SwapRoutes {
  @Bean
  RouterFunction<ServerResponse> swapEndpoints(
      SwapWorkflow workflow,
      LiquidityWorkflow liquidity,
      SwapStore swaps,
      LiquidityStore liquidityStore,
      RequestBody body,
      ApiErrors errors) {
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
            r -> ServerResponse.ok().body(activity(r, workflow, liquidity, swaps, liquidityStore)))
        .filter(errors)
        .build();
  }

  private static Object activity(
      ServerRequest request,
      SwapWorkflow swaps,
      LiquidityWorkflow liquidity,
      SwapStore swapStore,
      LiquidityStore liquidityStore) {
    Account caller = CurrentAccount.from(request);
    caller.requireRole(Account.Role.TRADER);
    String type = request.param("type").orElse("swap");
    int limit = Integer.parseInt(request.param("limit").orElse("50"));
    String cursor = request.param("cursor").orElse(null);
    String status = request.param("status").orElse(null);
    return switch (type) {
      case "swap" -> swaps.activity(caller, limit, cursor, status);
      case "deposit" ->
          liquidity.activity(caller, LiquidityModels.Kind.DEPOSIT, limit, cursor, status);
      case "withdraw" ->
          liquidity.activity(caller, LiquidityModels.Kind.WITHDRAW, limit, cursor, status);
      case "all" -> allActivity(caller, limit, cursor, status, swapStore, liquidityStore);
      default -> throw new IllegalArgumentException("Unknown activity type");
    };
  }

  private record AllActivity(List<QueueRequest> items, String nextCursor) {}

  private static AllActivity allActivity(
      Account caller,
      int limit,
      String cursor,
      String status,
      SwapStore swaps,
      LiquidityStore liquidity) {
    if (limit < 1 || limit > 100) throw new IllegalArgumentException("Invalid page size");
    if (status != null) {
      try {
        SwapModels.Status.valueOf(status);
      } catch (IllegalArgumentException ignored) {
        LiquidityModels.Status.valueOf(status);
      }
    }
    Instant beforeTime = null;
    UUID beforeId = null;
    if (cursor != null) {
      var parts = cursor.split(":", 2);
      if (parts.length != 2) throw new IllegalArgumentException("Invalid activity cursor");
      beforeId = UUID.fromString(parts[1]);
      if (parts[0].equals("swap")) {
        beforeTime = swaps.owned(beforeId, caller).createdAt();
      } else {
        var prior = liquidity.owned(beforeId, caller);
        var expectedType = prior.kind() == LiquidityModels.Kind.DEPOSIT ? "deposit" : "withdraw";
        if (!parts[0].equals(expectedType))
          throw new IllegalArgumentException("Invalid activity cursor");
        beforeTime = prior.createdAt();
      }
    }
    var swapPage = swaps.activityBefore(caller, limit, beforeTime, beforeId, status);
    var liquidityPage = liquidity.activityBefore(caller, null, limit, beforeTime, beforeId, status);
    List<QueueRequest> combined = new ArrayList<>();
    swapPage.items().forEach(item -> combined.add(new SwapRequest(item)));
    liquidityPage.items().forEach(item -> combined.add(new LiquidityRequest(item)));
    combined.sort(
        Comparator.comparing(QueueRequest::createdAt)
            .thenComparing(item -> item.reference().requestId().toString())
            .reversed());
    boolean more =
        combined.size() > limit
            || swapPage.nextCursor() != null
            || liquidityPage.nextCursor() != null;
    List<QueueRequest> items = List.copyOf(combined.subList(0, Math.min(limit, combined.size())));
    String next =
        more && !items.isEmpty()
            ? items.getLast().type() + ":" + items.getLast().reference().requestId()
            : null;
    return new AllActivity(items, next);
  }

  private static UUID id(ServerRequest request) {
    return UUID.fromString(request.pathVariable("swapId"));
  }
}
