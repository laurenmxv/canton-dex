import type { FastifyBaseLogger } from 'fastify';
import { numericUnits, trimmedText } from '../platform/decimal.js';
import { InvalidRequest } from '../platform/errors.js';
import { epochNanos } from '../platform/time.js';
import type {
  Balance,
  Balances,
  Claim,
  Confirmation,
  InstrumentCatalog,
  Prepared,
  RegisteredInstrument,
  Registry,
  Signer,
} from '../tokens/model.js';
import { GrantNotSubmitted, TokenRejected, type TokenLedger } from '../tokens/ports.js';
import { holdingView, type HoldingView } from './contracts.js';
import { record, string } from './decode.js';
import { definitelyRejected } from './http.js';
import {
  verify as verifyPreparation,
  type InteractiveTransactions,
  type Prepared as StoredPreparation,
} from './interactive.js';
import { createdEvents, exercise, interfaceView, type Ledger, type Transaction } from './ledger.js';
import { PreparationFailed, type OperatorCommands } from './operator-commands.js';
import {
  byPackageId,
  HoldingInterface,
  isExactly,
  TestTokenFaucet,
  TestTokenGrant,
  TestTokenReceipt,
  TokenRules,
  type DamlName,
} from './packages.js';

/** The operator command kind of a faucet grant in the durable command journal. */
const FAUCET_GRANT = 'faucet-grant';

async function submitTokenCommand(submission: () => Promise<Transaction>): Promise<Transaction> {
  try {
    return await submission();
  } catch (error) {
    if (definitelyRejected(error)) {
      throw new TokenRejected('Participant rejected the test token command', { cause: error });
    }
    if (error instanceof InvalidRequest) {
      throw new TokenRejected('The test token command was rejected before submission', { cause: error });
    }
    throw error;
  }
}

function one(results: readonly Confirmation[]): Confirmation | undefined {
  if (results.length > 1) throw new Error('More than one matching test token effect');
  return results[0];
}

function stored(claim: Claim, signer: Signer): StoredPreparation {
  if (claim.prepared === null) throw new Error('The test token claim has no preparation');
  return {
    preparedTransaction: claim.prepared.preparedTransaction,
    preparedTransactionHash: claim.prepared.preparedTransactionHash,
    hashingSchemeVersion: claim.prepared.hashingSchemeVersion,
    partyId: signer.party.partyId,
    publicKeyFingerprint: signer.party.publicKeyFingerprint,
    expiresAt: claim.prepared.expiresAt,
  };
}

function requireOffset(offset: bigint | null, what: string): bigint {
  if (offset === null) throw new Error(`The test token claim has no ${what} begin offset`);
  return offset;
}

/** Per registered instrument, the trader's unlocked and locked amounts in its own account. */
export function balances(holdings: readonly HoldingView[], instruments: readonly RegisteredInstrument[]): Balance[] {
  return instruments.map((token) => {
    let available = 0n;
    let locked = 0n;
    for (const holding of holdings) {
      if (holding.instrumentId.admin !== token.admin || holding.instrumentId.id !== token.id) continue;
      if (holding.locked) locked += numericUnits(holding.amount);
      else available += numericUnits(holding.amount);
    }
    return {
      instrument: { admin: token.admin, id: token.id },
      symbol: token.symbol,
      decimals: token.decimals,
      available: trimmedText(available),
      locked: trimmedText(locked),
      total: trimmedText(available + locked),
    };
  });
}

/**
 * The faucet grant, issued through the durable operator command journal, and the trader's signed
 * claim, relayed with the caller's token. Recovery reads the operator's complete history.
 */
export class CantonTokenLedger implements TokenLedger {
  constructor(
    private readonly ledger: Ledger,
    private readonly interactive: InteractiveTransactions,
    private readonly configuration: { registry(): Promise<Registry> },
    private readonly catalog: InstrumentCatalog,
    private readonly commands: OperatorCommands,
    private readonly log: Pick<FastifyBaseLogger, 'debug'>,
  ) {}

  ledgerEnd(): Promise<bigint> {
    return this.ledger.ledgerEnd();
  }

  async issueGrant(claim: Claim, signer: Signer): Promise<Confirmation> {
    let tx: Transaction;
    try {
      tx = await submitTokenCommand(() =>
        this.commands.submit(claim.grantCommandId, FAUCET_GRANT, async () => {
          const registry = await this.configuration.registry();
          return this.ledger.storedCommands(
            claim.grantCommandId,
            await this.ledger.primaryParty(),
            [],
            [
              exercise(TestTokenFaucet, registry.faucetFactoryId, 'TestTokenFaucet_IssueGrant', {
                recipient: signer.party.partyId,
                grantId: claim.grantId,
              }),
            ],
            requireOffset(claim.grantBeginOffset, 'grant'),
            [],
          );
        }),
      );
    } catch (error) {
      if (error instanceof PreparationFailed) throw new GrantNotSubmitted(error.message);
      throw error;
    }
    const grant = (await this.effects(TestTokenGrant, claim, signer))(tx);
    if (!grant) throw new Error('Grant transaction has no matching grant');
    return grant;
  }

  async recoverGrant(claim: Claim, signer: Signer): Promise<Confirmation | undefined> {
    const { transactions } = await this.ledger.history(
      requireOffset(claim.grantBeginOffset, 'grant'),
      await this.ledger.primaryParty(),
    );
    const grant = await this.effects(TestTokenGrant, claim, signer);
    const confirmed = one(
      transactions.filter((tx) => tx.commandId === claim.grantCommandId).flatMap((tx) => grant(tx) ?? []),
    );
    if (confirmed) return confirmed;
    try {
      return await this.issueGrant(claim, signer);
    } catch (error) {
      if (error instanceof GrantNotSubmitted) throw error;
      // A retry's rejection cannot establish the outcome of the original stored command.
      this.log.debug({ err: error, command: claim.grantCommandId }, 'Test token grant remains unresolved');
      return undefined;
    }
  }

  async prepareClaim(claim: Claim, signer: Signer, callerToken: string, expiresAt: string): Promise<Prepared> {
    if (claim.grantCid === null) throw new Error('The test token claim has no confirmed grant');
    const registry = await this.configuration.registry();
    const rules = {
      contractId: registry.rulesId,
      templateId: byPackageId(TokenRules),
      createdEventBlob: registry.rulesCreatedEventBlob,
      synchronizerId: registry.synchronizerId,
    };
    const prepared = await this.interactive.prepare(
      `test-token-claim-${claim.grantId}`,
      signer.userId,
      callerToken,
      signer.party,
      exercise(TestTokenGrant, claim.grantCid, 'TestTokenGrant_Claim', {}),
      [rules],
      expiresAt,
    );
    return {
      preparedTransaction: prepared.preparedTransaction,
      preparedTransactionHash: prepared.preparedTransactionHash,
      hashingSchemeVersion: prepared.hashingSchemeVersion,
      expiresAt: prepared.expiresAt,
    };
  }

  async claim(claim: Claim, signer: Signer, callerToken: string, signature: string): Promise<Confirmation> {
    if (claim.preparationId === null) throw new Error('The test token claim has no preparation');
    const submissionId = claim.preparationId;
    const tx = await submitTokenCommand(() =>
      this.interactive.execute(
        submissionId,
        stored(claim, signer),
        signature,
        signer.party,
        callerToken,
        signer.userId,
      ),
    );
    const receipt = (await this.effects(TestTokenReceipt, claim, signer))(tx);
    if (!receipt) throw new Error('Claim transaction has no matching receipt');
    return receipt;
  }

  verify(claim: Claim, signer: Signer, signature: string): void {
    verifyPreparation(stored(claim, signer), signature, signer.party);
  }

  /** A receipt proves the claim; a record time past the deadline without one proves no effect. */
  async recoverClaim(claim: Claim, signer: Signer): Promise<Confirmation | undefined> {
    const history = await this.ledger.history(
      requireOffset(claim.claimBeginOffset, 'claim'),
      await this.ledger.primaryParty(),
    );
    const receipt = await this.effects(TestTokenReceipt, claim, signer);
    const confirmed = one(history.transactions.flatMap((tx) => receipt(tx) ?? []));
    if (confirmed) return confirmed;
    const deadline = stored(claim, signer).expiresAt;
    if (history.recordTime !== undefined && epochNanos(history.recordTime) > epochNanos(deadline)) {
      throw new TokenRejected('Record-time deadline passed without a committed effect');
    }
    return undefined;
  }

  async balances(signer: Signer, callerToken: string): Promise<Balances> {
    const caller = this.ledger.forCaller(callerToken);
    const offset = await caller.ledgerEnd();
    const party = signer.party.partyId;
    const holdings = (await caller.activeInterfaceContracts(party, HoldingInterface, offset))
      .map((event) => holdingView(interfaceView(event, HoldingInterface)))
      .filter(
        (holding) => holding.account.owner === party && holding.account.provider === null && holding.account.id === '',
      );
    return { balances: balances(holdings, await this.catalog.instruments()), asOfOffset: offset };
  }

  /** Finds the grant or receipt of this claim, from the configured issuer, in a transaction. */
  private async effects(
    template: DamlName,
    claim: Claim,
    signer: Signer,
  ): Promise<(tx: Transaction) => Confirmation | undefined> {
    const registry = await this.configuration.registry();
    const operator = await this.ledger.primaryParty();
    return (tx) =>
      one(
        createdEvents(tx)
          .filter((event) => isExactly(event.templateId, template))
          .filter((event) => {
            const fields = record(event.createArgument, template.entity);
            return (
              string(fields.grantId, 'grantId') === claim.grantId &&
              string(fields.recipient, 'recipient') === signer.party.partyId &&
              string(fields.issuer, 'issuer') === registry.issuerPartyId &&
              string(fields.operator, 'operator') === operator &&
              string(fields.rulesCid, 'rulesCid') === registry.rulesId
            );
          })
          .map((event) => ({ contractId: event.contractId, updateId: tx.updateId })),
      );
  }
}
