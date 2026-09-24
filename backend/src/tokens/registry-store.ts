import type { Db } from '../platform/database.js';
import type { InstrumentCatalog, RegisteredInstrument } from './model.js';

/** An issuer's configured allocation and settlement factories. */
export interface TokenSource {
  readonly admin: string;
  readonly allocationFactoryId: string;
  readonly settlementFactoryId: string;
}

/** A stored factory contract that commands disclose; the blob is the participant's Base64. */
export interface RegistryDisclosure {
  readonly templateId: string;
  readonly contractId: string;
  readonly createdEventBlob: string;
  readonly synchronizerId: string;
}

/** Operator-configured token factories and instrument metadata. */
export class TokenRegistryStore implements InstrumentCatalog {
  constructor(private readonly db: Db) {}

  async source(admin: string): Promise<TokenSource | undefined> {
    return this.db
      .selectFrom('token_registries')
      .select(['admin', 'allocation_factory_id as allocationFactoryId', 'settlement_factory_id as settlementFactoryId'])
      .where('admin', '=', admin)
      .executeTakeFirst();
  }

  async disclosures(admin: string, factoryCid: string): Promise<RegistryDisclosure[]> {
    return this.db
      .selectFrom('token_registry_contracts')
      .select([
        'template_id as templateId',
        'contract_id as contractId',
        'created_event_blob as createdEventBlob',
        'synchronizer_id as synchronizerId',
      ])
      .where('admin', '=', admin)
      .where('contract_id', '=', factoryCid)
      .execute();
  }

  async instruments(): Promise<RegisteredInstrument[]> {
    return this.db
      .selectFrom('token_instruments')
      .select(['admin', 'instrument_id as id', 'symbol', 'decimals'])
      .orderBy('symbol')
      .orderBy('admin')
      .orderBy('instrument_id')
      .execute();
  }

  /** Registers an instrument once; an existing registration keeps its symbol. */
  async registerInstrument(admin: string, id: string, symbol: string, decimals: number): Promise<void> {
    await this.db
      .insertInto('token_instruments')
      .values({ admin, instrument_id: id, symbol, decimals })
      .onConflict((conflict) => conflict.columns(['admin', 'instrument_id']).doNothing())
      .execute();
  }
}
