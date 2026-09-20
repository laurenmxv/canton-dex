package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.EventOuterClass.ExercisedEvent;
import com.daml.ledger.javaapi.data.Value;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.AllocationResult;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.allocationresult_output.AllocationResult_Withdrawn;

/** Standard lifecycle results, independent of the issuer's concrete allocation template. */
final class AllocationEvents {
  private AllocationEvents() {}

  static boolean withdrawn(ExercisedEvent event) {
    if (!event.hasInterfaceId()
        || !event.getInterfaceId().equals(Allocation.INTERFACE_ID_WITH_PACKAGE_ID.toProto())
        || event.getConsuming()
        || !event.getChoice().equals("Allocation_Withdraw")
        || !event.hasExerciseResult()) return false;
    var result = AllocationResult.valueDecoder().decode(Value.fromProto(event.getExerciseResult()));
    return result.output instanceof AllocationResult_Withdrawn;
  }
}
