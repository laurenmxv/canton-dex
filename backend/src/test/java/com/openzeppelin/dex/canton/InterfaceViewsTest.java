package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.api.v2.EventOuterClass.InterfaceView;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.Text;
import com.google.rpc.Status;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Holding;
import org.junit.jupiter.api.Test;

class InterfaceViewsTest {
  private static final Identifier INTERFACE = Holding.INTERFACE_ID_WITH_PACKAGE_ID;
  private static final DamlRecord VALUE =
      new DamlRecord(new DamlRecord.Field("token", new Text("foreign-instrument")));

  @Test
  void decodesViewRegardlessOfIssuerTemplateAndPayload() {
    var event =
        event(view()).toBuilder().setCreateArguments(new DamlRecord().toProtoRecord()).build();
    assertThat(InterfaceViews.view(event, INTERFACE)).isEqualTo(VALUE);
  }

  @Test
  void doesNotAcceptAnInterfaceFromAnotherPackage() {
    var other =
        view().toBuilder()
            .setInterfaceId(INTERFACE.toProto().toBuilder().setPackageId("other-standard-version"))
            .build();
    assertThatThrownBy(() -> InterfaceViews.view(event(other), INTERFACE))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("Expected one");
  }

  @Test
  void missingOrDuplicateViewsFail() {
    assertThatThrownBy(() -> InterfaceViews.view(event(), INTERFACE))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("Expected one");
    assertThatThrownBy(() -> InterfaceViews.view(event(view(), view()), INTERFACE))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("Expected one");
  }

  @Test
  void failedViewIsNotTreatedAsEmptyOrDecoded() {
    var failed = view().toBuilder().setViewStatus(Status.newBuilder().setCode(9)).build();
    assertThatThrownBy(() -> InterfaceViews.view(event(failed), INTERFACE))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("status 9");
  }

  @Test
  void absentViewValueFails() {
    var missingValue = view().toBuilder().clearViewValue().build();
    assertThatThrownBy(() -> InterfaceViews.view(event(missingValue), INTERFACE))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("no value");
  }

  @Test
  void transactionFilterRequestsAllocationsAndRetainsOtherEvents() {
    var filter = InterfaceViews.transactionFilter();
    assertThat(filter.getCumulativeCount()).isEqualTo(2);
    assertThat(filter.getCumulative(0).hasWildcardFilter()).isTrue();
    var allocation = filter.getCumulative(1).getInterfaceFilter();
    assertThat(allocation.getInterfaceId()).isEqualTo(Allocation.INTERFACE_ID.toProto());
    assertThat(allocation.getIncludeInterfaceView()).isTrue();
    assertThat(allocation.getIncludeCreatedEventBlob()).isTrue();
  }

  private static InterfaceView view() {
    return InterfaceView.newBuilder()
        .setInterfaceId(INTERFACE.toProto())
        .setViewValue(VALUE.toProtoRecord())
        .build();
  }

  private static CreatedEvent event(InterfaceView... views) {
    return CreatedEvent.newBuilder()
        .setTemplateId(new Identifier("foreign-package", "Issuer.Asset", "Balance").toProto())
        .setContractId("foreign-contract")
        .addAllInterfaceViews(java.util.List.of(views))
        .build();
  }
}
