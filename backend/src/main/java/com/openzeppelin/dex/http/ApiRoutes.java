package com.openzeppelin.dex.http;

import com.openzeppelin.dex.onboarding.http.*;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.function.*;

@Configuration(proxyBeanMethods = false)
public class ApiRoutes {
  @Bean
  RouterFunction<ServerResponse> routes(
      CreateOnboardingHandler create,
      GetOnboardingHandler get,
      ListOnboardingsHandler list,
      ReviewOnboardingHandler review,
      PreparePartyHandler prepare,
      SubmitPartyHandler submit,
      com.openzeppelin.dex.iam.ProfileHandler profile,
      GetOwnOnboardingHandler mine,
      ListPoolsHandler pools,
      ApiErrors errors) {
    return RouterFunctions.route()
        .GET("/v1/me", profile::handle)
        .GET("/v1/pools", pools::handle)
        .GET("/v1/onboardings/mine", mine::handle)
        .POST("/v1/onboardings", create::handle)
        .GET("/v1/onboardings/{onboardingId}", get::handle)
        .GET("/v1/admin/onboardings", list::handle)
        .POST("/v1/admin/onboardings/{onboardingId}/review", review::handle)
        .POST("/v1/onboardings/{onboardingId}/party/prepare", prepare::handle)
        .POST("/v1/onboardings/{onboardingId}/party/submit", submit::handle)
        .filter(errors)
        .build();
  }
}
