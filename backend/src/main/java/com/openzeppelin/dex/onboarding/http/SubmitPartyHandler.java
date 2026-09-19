package com.openzeppelin.dex.onboarding.http;

import com.openzeppelin.dex.iam.CurrentAccount;
import com.openzeppelin.dex.onboarding.*;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;

@Component
public final class SubmitPartyHandler {
  private final OnboardingWorkflow workflow;
  private final RequestBody body;

  public SubmitPartyHandler(OnboardingWorkflow workflow, RequestBody body) {
    this.workflow = workflow;
    this.body = body;
  }

  public ServerResponse handle(ServerRequest request) throws Exception {
    var id = UUID.fromString(request.pathVariable("onboardingId"));
    return ServerResponse.ok()
        .body(
            workflow.submitParty(
                id,
                CurrentAccount.from(request),
                body.read(request, PartySubmission.class),
                CurrentAccount.accessToken(request)));
  }
}
