package com.openzeppelin.dex.canton;

import static com.daml.ledger.api.v2.TransactionFilterOuterClass.*;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;

/** Decodes standard interface views without depending on the issuer's implementing template. */
public final class InterfaceViews {
  private InterfaceViews() {}

  public static DamlRecord view(CreatedEvent event, Identifier interfaceId) {
    var matches =
        event.getInterfaceViewsList().stream()
            .filter(view -> view.getInterfaceId().equals(interfaceId.toProto()))
            .toList();
    if (matches.size() != 1)
      throw new IllegalStateException(
          "Expected one " + interfaceId + " view on contract " + event.getContractId());
    var view = matches.getFirst();
    if (view.getViewStatus().getCode() != 0)
      throw new IllegalStateException(
          "Interface view failed for contract "
              + event.getContractId()
              + ": status "
              + view.getViewStatus().getCode());
    if (!view.hasViewValue())
      throw new IllegalStateException(
          "Interface view has no value for contract " + event.getContractId());
    return DamlRecord.fromProto(view.getViewValue());
  }

  static CumulativeFilter filter(Identifier interfaceId) {
    return CumulativeFilter.newBuilder()
        .setInterfaceFilter(
            InterfaceFilter.newBuilder()
                .setInterfaceId(interfaceId.toProto())
                .setIncludeInterfaceView(true)
                .setIncludeCreatedEventBlob(true))
        .build();
  }

  static Filters transactionFilter() {
    return Filters.newBuilder()
        .addCumulative(
            CumulativeFilter.newBuilder().setWildcardFilter(WildcardFilter.getDefaultInstance()))
        .addCumulative(filter(Allocation.INTERFACE_ID))
        .build();
  }
}
