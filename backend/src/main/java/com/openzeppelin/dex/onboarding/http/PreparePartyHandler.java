package com.openzeppelin.dex.onboarding.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.*;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;

@Component
public final class PreparePartyHandler {
  private final OnboardingStore store;
  private final RequestBody body;

  public PreparePartyHandler(OnboardingStore store, RequestBody body) {
    this.store = store;
    this.body = body;
  }

  public ServerResponse handle(ServerRequest request) throws Exception {
    return ServerResponse.ok()
        .body(
            store.prepare(
                UUID.fromString(request.pathVariable("onboardingId")),
                CurrentAccount.from(request),
                body.read(request, PartyKey.class).publicKey(),
                CurrentAccount.accessToken(request)));
  }
}
