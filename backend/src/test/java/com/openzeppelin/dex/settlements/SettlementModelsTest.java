package com.openzeppelin.dex.settlements;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.settlements.SettlementModels.Fill;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class SettlementModelsTest {
  private final JsonMapper json = JsonMapper.builder().build();

  @Test
  void mixedDirectionFillsPreserveOutputInstrumentTuplesAndDecimalStrings() {
    Fill baseToQuote =
        new Fill(UUID.randomUUID(), "999999.123456", new Instrument("usdc-issuer", "USDC"));
    Fill quoteToBase =
        new Fill(UUID.randomUUID(), "0.12345678", new Instrument("btc-issuer", "BTC"));
    Fill[] fills = {baseToQuote, quoteToBase};

    String encoded = json.writeValueAsString(fills);

    assertThat(encoded).contains("\"amountOut\":\"999999.123456\"", "\"amountOut\":\"0.12345678\"");
    assertThat(json.readValue(encoded, Fill[].class)).containsExactly(baseToQuote, quoteToBase);
  }

  @Test
  void legacyMissingAndExplicitlyNullOutputInstrumentsRemainUnknown() {
    UUID legacyId = UUID.fromString("00000000-0000-4000-8000-000000000001");
    UUID unknownId = UUID.fromString("00000000-0000-4000-8000-000000000002");
    String persisted =
        """
        [
          {"swapId":"00000000-0000-4000-8000-000000000001","amountOut":"1.2345678900"},
          {"swapId":"00000000-0000-4000-8000-000000000002","amountOut":"0.0000000001","outputInstrument":null}
        ]
        """;

    Fill[] fills = json.readValue(persisted, Fill[].class);

    assertThat(fills)
        .containsExactly(
            new Fill(legacyId, "1.2345678900", null), new Fill(unknownId, "0.0000000001", null));
    String encoded = json.writeValueAsString(fills);
    assertThat(encoded).contains("\"outputInstrument\":null");
    assertThat(json.readValue(encoded, Fill[].class)).containsExactly(fills);
  }
}
