package com.openzeppelin.dex.tokens;

import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Operator-configured token factories and instrument metadata. */
@Repository
public class TokenRegistryStore implements InstrumentCatalog {
  private final JdbcClient sql;

  public TokenRegistryStore(JdbcClient sql) {
    this.sql = sql;
  }

  public Optional<Source> source(String admin) {
    return sql.sql(
            "SELECT admin,allocation_factory_id,settlement_factory_id"
                + " FROM token_registries WHERE admin=?")
        .param(admin)
        .query((r, i) -> new Source(r.getString(1), r.getString(2), r.getString(3)))
        .optional();
  }

  public List<Disclosure> disclosures(String admin, String factoryCid) {
    return sql.sql(
            "SELECT template_id,contract_id,created_event_blob,synchronizer_id"
                + " FROM token_registry_contracts WHERE admin=? AND contract_id=?")
        .params(admin, factoryCid)
        .query(
            (r, i) ->
                new Disclosure(r.getString(1), r.getString(2), r.getString(3), r.getString(4)))
        .list();
  }

  @Override
  public List<Instrument> instruments() {
    return sql.sql(
            "SELECT admin,instrument_id,symbol,decimals FROM token_instruments"
                + " ORDER BY symbol,admin,instrument_id")
        .query(
            (r, i) -> new Instrument(r.getString(1), r.getString(2), r.getString(3), r.getInt(4)))
        .list();
  }

  public record Source(String admin, String allocationFactoryId, String settlementFactoryId) {}

  public record Disclosure(
      String templateId, String contractId, String createdEventBlob, String synchronizerId) {}
}
