package com.openzeppelin.dex.canton;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("dex.registration")
public record RegistrationProperties(String identityProviderId) {}
