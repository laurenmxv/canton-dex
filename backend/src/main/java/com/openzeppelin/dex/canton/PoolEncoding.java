package com.openzeppelin.dex.canton;

import static com.openzeppelin.dex.pools.PoolModels.*;

import com.openzeppelin.dex.canton.generated.lib.tokens.Token;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolfactory.PoolSettings;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationinstructionv2.AllocationFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.SettlementFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import com.openzeppelin.dex.tokens.TokenRegistryStore;
import java.math.BigDecimal;

public final class PoolEncoding {
  private PoolEncoding() {}

  public static PoolSettings daml(
      ProposalTerms t, java.util.UUID proposalId, TokenRegistryStore registries) {
    var lp =
        registries
            .source(t.dvo())
            .orElseThrow(() -> new IllegalStateException("LP issuer registry is unavailable"));
    return new PoolSettings(
        t.dvo(),
        proposalId.toString(),
        token(t.baseInstrumentId(), registries),
        token(t.quoteInstrumentId(), registries),
        new AllocationFactory.ContractId(lp.allocationFactoryId()),
        new SettlementFactory.ContractId(lp.settlementFactoryId()),
        new BigDecimal(t.feeBps()));
  }

  static Token token(Instrument i, TokenRegistryStore registries) {
    var source =
        registries
            .source(i.admin())
            .orElseThrow(() -> new IllegalStateException("Token registry is unavailable"));
    var instrument =
        registries.instruments().stream()
            .filter(t -> t.admin().equals(i.admin()) && t.id().equals(i.id()))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Instrument is not registered"));
    return new Token(
        new InstrumentId(i.admin(), i.id()),
        new AllocationFactory.ContractId(source.allocationFactoryId()),
        new SettlementFactory.ContractId(source.settlementFactoryId()),
        (long) instrument.decimals());
  }

  static Instrument instrument(InstrumentId i) {
    return new Instrument(i.admin, i.id);
  }

  private static ReserveAccount account(Account a) {
    return new ReserveAccount(a.owner.orElseThrow(), a.provider.orElse(null), a.id);
  }

  public static ProposalTerms from(PoolSettings s) {
    return new ProposalTerms(
        s.dvo,
        instrument(s.baseToken.instrument),
        instrument(s.quoteToken.instrument),
        s.feeBps.toPlainString());
  }

  static Terms terms(Pool p, PoolConfig c, PoolState s) {
    validateComponents(p, c, s);
    return new Terms(
        p.dvo,
        instrument(p.baseToken.instrument),
        instrument(p.quoteToken.instrument),
        account(p.baseAccount),
        account(p.quoteAccount),
        instrument(p.lpToken.instrument),
        c.feeBps.toPlainString(),
        s.baseReserve.toPlainString(),
        s.quoteReserve.toPlainString(),
        s.lpTokenSupply.toPlainString(),
        c.initialRatio.toPlainString());
  }

  static void validateComponents(Pool p, PoolConfig c, PoolState s) {
    if (!c.poolCid.equals(s.poolCid)
        || !p.dvo.equals(c.dvo)
        || !p.dvo.equals(s.dvo)
        || !p.venueOperator.equals(c.venueOperator)
        || !p.venueOperator.equals(s.venueOperator))
      throw new IllegalStateException("Pool components differ");
  }
}
