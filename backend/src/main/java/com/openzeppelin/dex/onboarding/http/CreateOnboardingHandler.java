package com.openzeppelin.dex.onboarding.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.*;
import java.net.URI;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;

@Component
public final class CreateOnboardingHandler {
  private final OnboardingStore store;
  private final RequestBody bodies;

  public CreateOnboardingHandler(OnboardingStore store, RequestBody bodies) {
    this.store = store;
    this.bodies = bodies;
  }

  public ServerResponse handle(ServerRequest request) throws Exception {
    var application = bodies.read(request, OnboardingApplication.class);
    var onboarding = store.create(CurrentAccount.from(request), application);
    return ServerResponse.created(URI.create("/v1/onboardings/" + onboarding.id()))
        .body(onboarding);
  }
}
