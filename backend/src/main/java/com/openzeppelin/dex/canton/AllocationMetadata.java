package com.openzeppelin.dex.canton;

final class AllocationMetadata {
  private static final String PREFIX = "dex.reference.openzeppelin.com/";

  static final String MIN_OUT = PREFIX + "min-out-amount";
  static final String MIN_LP_OUT = PREFIX + "min-lp-out-amount";
  static final String MIN_BASE_OUT = PREFIX + "min-base-out-amount";
  static final String MIN_QUOTE_OUT = PREFIX + "min-quote-out-amount";

  private AllocationMetadata() {}
}
