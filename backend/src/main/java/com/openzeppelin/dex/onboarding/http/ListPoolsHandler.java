package com.openzeppelin.dex.onboarding.http;

import com.openzeppelin.dex.onboarding.OnboardingStore;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;

@Component
public final class ListPoolsHandler {
  private final OnboardingStore store;

  public ListPoolsHandler(OnboardingStore store) {
    this.store = store;
  }

  public ServerResponse handle(ServerRequest request) {
    return ServerResponse.ok().body(store.pools());
  }
}
