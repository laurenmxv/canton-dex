package com.openzeppelin.dex.canton;

import java.net.URI;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("dex.canton")
public record CantonProperties(
    String host, int port, URI tokenUrl, String userId, String clientId, String clientSecret) {
  public LedgerIdentity identity() {
    return new LedgerIdentity(userId, clientId, clientSecret);
  }

  @Override
  public String toString() {
    return "CantonProperties[host=" + host + ", port=" + port + "]";
  }
}
