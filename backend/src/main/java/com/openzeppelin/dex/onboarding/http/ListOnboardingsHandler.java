package com.openzeppelin.dex.onboarding.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.OnboardingStore;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;

@Component
public final class ListOnboardingsHandler {
  private final OnboardingStore store;

  public ListOnboardingsHandler(OnboardingStore store) {
    this.store = store;
  }

  public ServerResponse handle(ServerRequest request) {
    return ServerResponse.ok().body(store.list(CurrentAccount.from(request)));
  }
}
