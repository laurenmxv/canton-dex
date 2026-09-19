package com.openzeppelin.dex;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@org.springframework.scheduling.annotation.EnableScheduling
@SpringBootApplication
@ConfigurationPropertiesScan
public class DexApplication {
  public static void main(String[] args) {
    SpringApplication.run(DexApplication.class, args);
  }
}
