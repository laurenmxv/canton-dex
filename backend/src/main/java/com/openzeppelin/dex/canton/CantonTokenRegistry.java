package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.ValueOuterClass.Identifier;
import com.google.protobuf.ByteString;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.ChoiceContext;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.ExtraArgs;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import com.openzeppelin.dex.swaps.SwapFailure;
import com.openzeppelin.dex.tokens.TokenRegistryStore;
import com.openzeppelin.dex.tokens.TokenRegistryStore.Disclosure;
import com.openzeppelin.dex.tokens.TokenRegistryStore.Source;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Configured issuer factories for synchronous operations that need no choice context. */
@Component
public final class CantonTokenRegistry {
  private static final ExtraArgs EMPTY =
      new ExtraArgs(new ChoiceContext(Map.of()), new Metadata(Map.of()));
  private final TokenRegistryStore store;

  public CantonTokenRegistry(TokenRegistryStore store) {
    this.store = store;
  }

  public Operation inlineAllocation(String admin) {
    var source = source(admin);
    return operation(source, source.allocationFactoryId());
  }

  public Operation inlineSettlement(String admin) {
    var source = source(admin);
    return operation(source, source.settlementFactoryId());
  }

  public Operation withdraw(String admin, String allocationCid) {
    var allocation = inlineAllocation(admin);
    return new Operation(allocationCid, EMPTY, allocation.disclosures());
  }

  private Source source(String admin) {
    return store
        .source(admin)
        .orElseThrow(
            () ->
                SwapFailure.conflict(
                    "TOKEN_REGISTRY_UNAVAILABLE", "Token registry is not configured for " + admin));
  }

  private Operation operation(Source source, String factoryCid) {
    var contracts = store.disclosures(source.admin(), factoryCid);
    if (contracts.isEmpty())
      throw SwapFailure.conflict(
          "TOKEN_REGISTRY_UNAVAILABLE",
          "Token registry factory disclosure is missing for " + source.admin());
    return new Operation(
        factoryCid, EMPTY, contracts.stream().map(CantonTokenRegistry::disclosure).toList());
  }

  private static DisclosedContract disclosure(Disclosure contract) {
    var parts = contract.templateId().split(":", -1);
    if (parts.length != 3 || parts[0].isBlank() || parts[1].isBlank() || parts[2].isBlank())
      throw new IllegalStateException("Token registry contains an invalid template identifier");
    return DisclosedContract.newBuilder()
        .setTemplateId(
            Identifier.newBuilder()
                .setPackageId(parts[0])
                .setModuleName(parts[1])
                .setEntityName(parts[2]))
        .setContractId(contract.contractId())
        .setCreatedEventBlob(
            ByteString.copyFrom(Base64.getDecoder().decode(contract.createdEventBlob())))
        .setSynchronizerId(contract.synchronizerId())
        .build();
  }

  public record Operation(
      String factoryCid, ExtraArgs extraArgs, List<DisclosedContract> disclosures) {}
}
