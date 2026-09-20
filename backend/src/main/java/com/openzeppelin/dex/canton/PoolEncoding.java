package com.openzeppelin.dex.canton;

import static com.openzeppelin.dex.pools.PoolModels.*;

import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolfactory.PoolSettings;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import java.math.BigDecimal;
import java.util.Optional;

public final class PoolEncoding {
  private PoolEncoding() {}

  public static PoolSettings daml(Terms t) {
    return new PoolSettings(
        t.dvo(),
        instrument(t.baseInstrumentId()),
        instrument(t.quoteInstrumentId()),
        account(t.baseAccount()),
        account(t.quoteAccount()),
        instrument(t.lpTokenInstrumentId()),
        new BigDecimal(t.feeBps()),
        new BigDecimal(t.baseReserve()),
        new BigDecimal(t.quoteReserve()),
        new BigDecimal(t.lpTokenSupply()));
  }

  private static InstrumentId instrument(Instrument i) {
    return new InstrumentId(i.admin(), i.id());
  }

  private static Account account(ReserveAccount a) {
    return new Account(Optional.of(a.owner()), Optional.ofNullable(a.provider()), a.id());
  }

  private static Instrument instrument(InstrumentId i) {
    return new Instrument(i.admin, i.id);
  }

  private static ReserveAccount account(Account a) {
    return new ReserveAccount(a.owner.orElseThrow(), a.provider.orElse(null), a.id);
  }

  public static Terms from(PoolSettings s) {
    return new Terms(
        s.dvo,
        instrument(s.baseInstrumentId),
        instrument(s.quoteInstrumentId),
        account(s.baseAccount),
        account(s.quoteAccount),
        instrument(s.lpTokenInstrumentId),
        s.feeBps.toPlainString(),
        s.baseReserve.toPlainString(),
        s.quoteReserve.toPlainString(),
        s.lpTokenSupply.toPlainString());
  }

  static Terms terms(Pool p, PoolConfig c, PoolState s) {
    if (!c.poolCid.equals(s.poolCid)
        || !p.dvo.equals(c.dvo)
        || !p.dvo.equals(s.dvo)
        || !p.venueOperator.equals(c.venueOperator)
        || !p.venueOperator.equals(s.venueOperator))
      throw new IllegalStateException("Pool components differ");
    return from(
        new PoolSettings(
            p.dvo,
            p.baseInstrumentId,
            p.quoteInstrumentId,
            p.baseAccount,
            p.quoteAccount,
            p.lpTokenInstrumentId,
            c.feeBps,
            s.baseReserve,
            s.quoteReserve,
            s.lpTokenSupply));
  }
}
