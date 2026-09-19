package com.openzeppelin.dex.iam;

import java.util.UUID;
import org.springframework.security.access.AccessDeniedException;

public record Account(UUID id, String issuer, String subject, String displayName, Role role) {
  public enum Role {
    TRADER,
    OPERATOR
  }

  public void requireRole(Role required) {
    if (role != required)
      throw new AccessDeniedException("This account cannot perform that operation");
  }
}
