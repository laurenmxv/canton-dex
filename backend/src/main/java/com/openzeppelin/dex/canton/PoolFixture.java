package com.openzeppelin.dex.canton;

import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolfactory.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import java.math.BigDecimal;
import java.util.*;

/** Operator proposal followed by atomic dvv acceptance, using separate authenticated actors. */
public final class PoolFixture {
  private PoolFixture() {}

  public record Contracts(String poolId, String configId, String stateId, String packageId) {}

  public static String packageId() {
    return Pool.PACKAGE_ID;
  }

  public static boolean compatible(
      LedgerConnection ledger, String dvv, String operator, Contracts ids) {
    var event =
        ledger.activeContracts(operator, Pool.TEMPLATE_ID).stream()
            .filter(e -> e.getTemplateId().getPackageId().equals(Pool.PACKAGE_ID))
            .filter(e -> e.getContractId().equals(ids.poolId()))
            .findFirst();
    if (event.isEmpty() || !ids.packageId().equals(Pool.PACKAGE_ID)) return false;
    var pool =
        Pool.valueDecoder()
            .decode(
                com.daml.ledger.javaapi.data.DamlRecord.fromProto(
                    event.get().getCreateArguments()));
    if (!pool.dvv.equals(dvv) || !pool.venueOperator.equals(operator)) return false;
    boolean config =
        ledger.activeContracts(operator, PoolConfig.TEMPLATE_ID).stream()
            .filter(e -> e.getTemplateId().getPackageId().equals(PoolConfig.PACKAGE_ID))
            .filter(e -> e.getContractId().equals(ids.configId()))
            .anyMatch(
                e -> {
                  var value =
                      PoolConfig.valueDecoder()
                          .decode(
                              com.daml.ledger.javaapi.data.DamlRecord.fromProto(
                                  e.getCreateArguments()));
                  return value.poolCid.contractId.equals(ids.poolId())
                      && value.dvv.equals(dvv)
                      && value.venueOperator.equals(operator);
                });
    boolean state =
        ledger.activeContracts(operator, PoolState.TEMPLATE_ID).stream()
            .filter(e -> e.getTemplateId().getPackageId().equals(PoolState.PACKAGE_ID))
            .filter(e -> e.getContractId().equals(ids.stateId()))
            .anyMatch(
                e -> {
                  var value =
                      PoolState.valueDecoder()
                          .decode(
                              com.daml.ledger.javaapi.data.DamlRecord.fromProto(
                                  e.getCreateArguments()));
                  return value.poolCid.contractId.equals(ids.poolId())
                      && value.dvv.equals(dvv)
                      && value.venueOperator.equals(operator);
                });
    return config && state;
  }

  public static Contracts create(
      LedgerConnection authority,
      LedgerConnection operator,
      LedgerConnection baseAdmin,
      LedgerConnection quoteAdmin) {
    String dvv = authority.primaryParty(), op = operator.primaryParty();
    String run = UUID.randomUUID().toString();
    var settings =
        new PoolSettings(
            dvv,
            new InstrumentId(baseAdmin.primaryParty(), "BASE"),
            new InstrumentId(quoteAdmin.primaryParty(), "QUOTE"),
            new Account(Optional.of(dvv), Optional.empty(), "base"),
            new Account(Optional.of(dvv), Optional.empty(), "quote"),
            new InstrumentId(dvv, "LP"),
            new BigDecimal("30"),
            new BigDecimal("997"),
            new BigDecimal("1000"),
            new BigDecimal("1000"));
    var factory =
        LedgerConnection.created(
            authority.submit(run + "-factory", dvv, List.of(), new PoolFactory(dvv, op).create()),
            PoolFactory.TEMPLATE_ID);
    var proposal =
        LedgerConnection.created(
            operator.submit(
                run + "-propose",
                op,
                List.of(),
                new PoolFactory.ContractId(factory.getContractId())
                    .exercisePoolFactory_ProposePool(settings)),
            PoolProposal.TEMPLATE_ID);
    var created =
        authority.submit(
            run + "-accept",
            dvv,
            List.of(),
            new PoolProposal.ContractId(proposal.getContractId()).exercisePoolProposal_Accept());
    return new Contracts(
        LedgerConnection.created(created, Pool.TEMPLATE_ID).getContractId(),
        LedgerConnection.created(created, PoolConfig.TEMPLATE_ID).getContractId(),
        LedgerConnection.created(created, PoolState.TEMPLATE_ID).getContractId(),
        Pool.PACKAGE_ID);
  }
}
