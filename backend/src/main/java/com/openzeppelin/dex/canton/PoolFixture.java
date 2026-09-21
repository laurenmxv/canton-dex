package com.openzeppelin.dex.canton;

import com.openzeppelin.dex.canton.generated.pool.Pool;

/** The pool package this generation of the Daml code creates, for a caller outside canton. */
public final class PoolFixture {
  private PoolFixture() {}

  public static String packageId() {
    return Pool.PACKAGE_ID;
  }
}
