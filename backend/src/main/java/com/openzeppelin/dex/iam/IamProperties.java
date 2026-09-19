package com.openzeppelin.dex.iam;

import java.net.URI;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("dex.iam")
public record IamProperties(String issuer, URI jwkSetUri) {}
