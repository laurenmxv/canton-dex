package com.openzeppelin.dex.onboarding.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.OnboardingWorkflow;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;

@Component
public final class GetOwnOnboardingHandler {
  private final OnboardingWorkflow store;

  public GetOwnOnboardingHandler(OnboardingWorkflow store) {
    this.store = store;
  }

  public ServerResponse handle(ServerRequest request) {
    var result = store.mine(CurrentAccount.from(request), CurrentAccount.accessToken(request));
    return result == null
        ? ServerResponse.ok()
            .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
            .body("null")
        : ServerResponse.ok().body(result);
  }
}
