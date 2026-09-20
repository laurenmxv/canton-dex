package com.openzeppelin.dex.canton;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class CantonConfiguration {
  @Bean(destroyMethod = "close")
  LedgerConnection operatorLedgerConnection(CantonProperties properties) {
    return new LedgerConnection(
        properties.host(), properties.port(), properties.tokenUrl(), properties.identity());
  }

  @Bean
  InteractiveTransactions interactiveTransactions(LedgerConnection ledger) {
    return new InteractiveTransactions(ledger);
  }
}
