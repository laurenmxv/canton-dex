package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.swaps.SwapFailure;
import com.openzeppelin.dex.tokens.TokenRegistryStore;
import com.openzeppelin.dex.tokens.TokenRegistryStore.Disclosure;
import com.openzeppelin.dex.tokens.TokenRegistryStore.Source;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class CantonTokenRegistryTest {
  @Test
  void preservesIndependentIssuerFactoriesAndConcreteDisclosures() {
    var registry =
        registry(
            Map.of(
                "alice-allocation",
                    disclosure("alice-allocation", "package-a:Token:Allocate", "sync-a"),
                "alice-settlement",
                    disclosure("alice-settlement", "package-b:Other:Settle", "sync-a"),
                "bob-allocation",
                    disclosure("bob-allocation", "package-c:Issuer:Factory", "sync-b")));
    var allocated = registry.inlineAllocation("alice");
    var settled = registry.inlineSettlement("alice");
    var otherIssuer = registry.inlineAllocation("bob");
    assertThat(allocated.factoryCid()).isEqualTo("alice-allocation");
    assertThat(settled.factoryCid()).isEqualTo("alice-settlement");
    assertThat(otherIssuer.factoryCid()).isEqualTo("bob-allocation");
    assertThat(settled.disclosures().getFirst().getTemplateId().getPackageId())
        .isEqualTo("package-b");
    assertThat(settled.disclosures().getFirst().getTemplateId().getEntityName())
        .isEqualTo("Settle");
    assertThat(otherIssuer.disclosures().getFirst().getSynchronizerId()).isEqualTo("sync-b");
    assertThat(allocated.disclosures().getFirst().getCreatedEventBlob().toByteArray())
        .containsExactly(1, 2, 3);
    assertThat(allocated.extraArgs().context.values).isEmpty();
    assertThat(allocated.extraArgs().meta.values).isEmpty();
    assertThat(registry.withdraw("alice", "allocation").factoryCid()).isEqualTo("allocation");
  }

  @Test
  void requiresRegisteredIssuerAndFactoryDisclosure() {
    var registry = registry(Map.of());
    for (var admin : List.of("unknown", "alice")) {
      assertThatThrownBy(() -> registry.inlineAllocation(admin))
          .isInstanceOfSatisfying(
              SwapFailure.class,
              failure -> {
                assertThat(failure.code()).isEqualTo("TOKEN_REGISTRY_UNAVAILABLE");
                assertThat(failure.status()).isEqualTo(409);
              });
    }
    var malformed =
        registry(Map.of("alice-allocation", disclosure("alice-allocation", "invalid", "sync")));
    assertThatThrownBy(() -> malformed.inlineAllocation("alice"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("invalid template identifier");
  }

  @Test
  void rejectsFactoryReplacementAndConflictingDisclosures() {
    var registry =
        registry(
            Map.of(
                "alice-allocation", disclosure("alice-allocation", "pkg:Token:Factory", "sync")));
    var allocation = registry.inlineAllocation("alice");
    assertThat(CantonSwapPools.requireFactory("alice-allocation", allocation)).isSameAs(allocation);
    assertThatThrownBy(() -> CantonSwapPools.requireFactory("unapproved-factory", allocation))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("TOKEN_FACTORY_CHANGED"));
    var original = allocation.disclosures().getFirst();
    assertThat(CantonSwapPools.mergeDisclosures(List.of(original, original)))
        .containsExactly(original);
    assertThatThrownBy(
            () ->
                CantonSwapPools.mergeDisclosures(
                    List.of(
                        original,
                        original.toBuilder().setSynchronizerId("different-sync").build())))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("Conflicting disclosures");
  }

  private static CantonTokenRegistry registry(Map<String, Disclosure> disclosures) {
    return new CantonTokenRegistry(
        new TokenRegistryStore(null) {
          @Override
          public Optional<Source> source(String admin) {
            if (!List.of("alice", "bob").contains(admin)) return Optional.empty();
            return Optional.of(new Source(admin, admin + "-allocation", admin + "-settlement"));
          }

          @Override
          public List<Disclosure> disclosures(String admin, String factoryCid) {
            var disclosure = disclosures.get(factoryCid);
            return disclosure == null ? List.of() : List.of(disclosure);
          }
        });
  }

  private static Disclosure disclosure(String cid, String template, String synchronizer) {
    return new Disclosure(template, cid, "AQID", synchronizer);
  }
}
