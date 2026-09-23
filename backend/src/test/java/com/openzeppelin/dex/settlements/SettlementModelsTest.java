package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;
import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.pools.PoolModels.Instrument;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class SettlementModelsTest {
  private final JsonMapper json = JsonMapper.builder().build();

  @Test
  void typedFillsPreserveInstrumentsActualAmountsAndDecimalStrings() {
    Fill[] fills = {
      new SwapFill(UUID.randomUUID(), "999999.123456", new Instrument("issuer", "USDC")),
      new DepositFill(UUID.randomUUID(), "1", "2", "0.01", "0", "1.2345678900"),
      new WithdrawalFill(UUID.randomUUID(), "0.0000000001", "0.01", "0.02")
    };
    String encoded = json.writeValueAsString(fills);
    assertThat(encoded)
        .contains(
            "\"type\":\"swap\"",
            "\"type\":\"deposit\"",
            "\"type\":\"withdraw\"",
            "\"actualLpOut\":\"1.2345678900\"",
            "\"actualLpBurned\":\"0.0000000001\"");
    assertThat(json.readValue(encoded, Fill[].class)).containsExactly(fills);
    assertThat(json.readValue(json.writeValueAsString(List.of(fills)), Fill[].class))
        .containsExactly(fills);
  }

  @Test
  void queueWireFormatSeparatesSchedulingFromLedgerStatus() {
    var wrapped = SettlementWorkflowTest.swap(1);
    var tree = json.readTree(json.writeValueAsString(wrapped));
    assertThat(tree.size()).isEqualTo(3);
    assertThat(tree.path("deferred").asBoolean()).isFalse();
    assertThat(tree.path("type").asString()).isEqualTo("swap");
    assertThat(tree.path("request").path("swapId").asString())
        .isEqualTo(wrapped.request().swapId().toString());
  }
}
