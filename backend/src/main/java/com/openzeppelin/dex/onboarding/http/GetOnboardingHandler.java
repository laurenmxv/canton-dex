package com.openzeppelin.dex.onboarding.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.OnboardingWorkflow;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;

@Component
public final class GetOnboardingHandler {
  private final OnboardingWorkflow store;

  public GetOnboardingHandler(OnboardingWorkflow store) {
    this.store = store;
  }

  public ServerResponse handle(ServerRequest request) {
    return ServerResponse.ok()
        .body(
            store.getOwned(
                UUID.fromString(request.pathVariable("onboardingId")),
                CurrentAccount.from(request),
                CurrentAccount.accessToken(request)));
  }
}
