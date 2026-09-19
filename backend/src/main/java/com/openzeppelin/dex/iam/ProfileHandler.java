package com.openzeppelin.dex.iam;

import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;

@Component
public final class ProfileHandler {
  private final AccountDirectory accounts;

  public ProfileHandler(AccountDirectory accounts) {
    this.accounts = accounts;
  }

  public ServerResponse handle(ServerRequest request) {
    return ServerResponse.ok().body(accounts.profile(CurrentAccount.from(request)));
  }
}
