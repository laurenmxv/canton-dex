package com.openzeppelin.dex.tokens;

import java.util.List;

/** Every instrument the venue has registered, for the modules that read against the whole set. */
public interface InstrumentCatalog {
  List<Instrument> instruments();

  /**
   * One registered instrument.
   *
   * <p>The administrator and that administrator's own identifier name it together. Two
   * administrators may register the same symbol, and the same identifier under it.
   */
  record Instrument(String admin, String id, String symbol, int decimals) {}
}
