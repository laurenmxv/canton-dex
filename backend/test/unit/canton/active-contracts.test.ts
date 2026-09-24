import { afterEach, describe, expect, it } from 'vitest';
import { ServiceCredentials } from '../../../src/canton/credentials.js';
import { LedgerHttp } from '../../../src/canton/http.js';
import { Ledger } from '../../../src/canton/ledger.js';
import { byName, byPackageId, HoldingInterface, TokenRules, type DamlName } from '../../../src/canton/packages.js';
import { at } from '../../support/json.js';
import { fakeParticipant, type FakeParticipant } from '../support/participant.js';

const OPERATOR = { userId: 'operator', clientId: 'operator', clientSecret: 'unused' };

describe('caller active contracts', () => {
  let participant: FakeParticipant | undefined;
  afterEach(async () => {
    await participant?.close();
    participant = undefined;
  });

  /** Caller reads relay each token, use the given or current offset, and keep the participant's blob. */
  async function checkReads(template: DamlName, interfaceName?: DamlName): Promise<void> {
    const event = {
      offset: 5,
      nodeId: 0,
      contractId: 'holding-cid',
      templateId: `concrete-issuer-package:${template.module}:${template.entity}`,
      createArgument: {},
      createdEventBlob: Buffer.from('opaque-participant-blob').toString('base64'),
      interfaceViews:
        interfaceName === undefined
          ? []
          : [{ interfaceId: byPackageId(HoldingInterface), viewStatus: { code: 0, message: '' }, viewValue: {} }],
      witnessParties: ['trader'],
      signatories: ['issuer'],
      observers: [],
      createdAt: '2026-01-01T00:00:00Z',
      packageName: template.packageName,
      representativePackageId: 'concrete-issuer-package',
      acsDelta: true,
    };
    participant = await fakeParticipant({
      'GET /v2/state/ledger-end': () => ({ body: { offset: 88 } }),
      'POST /v2/state/active-contracts': () => ({
        body: [
          {
            contractEntry: {
              JsActiveContract: { createdEvent: event, synchronizerId: 'sync', reassignmentCounter: 0 },
            },
          },
        ],
      }),
    });
    const ledger = Ledger.service(
      new LedgerHttp(participant.url),
      new ServiceCredentials(new URL('http://127.0.0.1:1'), OPERATOR),
    );
    expect(await ledger.forCaller('end-token').ledgerEnd()).toBe(88n);
    const read = (token: string, offset?: bigint) =>
      interfaceName === undefined
        ? ledger.forCaller(token).activeContracts('trader', template, offset)
        : ledger.forCaller(token).activeInterfaceContracts('trader', interfaceName, offset);
    for (const contracts of [await read('fixed-token', 77n), await read('fresh-token')]) {
      expect(contracts).toHaveLength(1);
      expect(contracts[0]).toMatchObject({
        contractId: 'holding-cid',
        templateId: event.templateId,
        createdEventBlob: event.createdEventBlob,
        interfaceViews: event.interfaceViews.map((view) => ({
          interfaceId: view.interfaceId,
          statusCode: 0,
          value: {},
        })),
      });
    }
    expect(participant.exchanges.map((exchange) => exchange.authorization)).toEqual([
      'Bearer end-token',
      'Bearer fixed-token',
      'Bearer fresh-token',
      'Bearer fresh-token',
    ]);
    const requests = participant.exchanges
      .filter((exchange) => exchange.path === '/v2/state/active-contracts')
      .map((exchange) => exchange.body);
    expect(requests.map((request) => at(request, 'activeAtOffset'))).toEqual([77, 88]);
    for (const request of requests) {
      const filters = at(request, 'eventFormat', 'filtersByParty');
      expect(Object.keys(filters ?? {})).toEqual(['trader']);
      const expected =
        interfaceName === undefined
          ? { TemplateFilter: { value: { templateId: byName(template), includeCreatedEventBlob: true } } }
          : {
              InterfaceFilter: {
                value: {
                  interfaceId: byName(interfaceName),
                  includeInterfaceView: true,
                  includeCreatedEventBlob: true,
                },
              },
            };
      expect(at(filters, 'trader')).toEqual({ cumulative: [{ identifierFilter: expected }] });
    }
  }

  it('reads with fresh caller tokens, fixed offsets and canonical disclosure blobs', async () => {
    await checkReads({
      packageName: 'package',
      packageId: 'concrete-issuer-package',
      module: 'Test',
      entity: 'Holding',
    });
  });

  it('filters issuer templates by explicit package name', async () => {
    await checkReads(TokenRules);
    expect(byName(TokenRules)).toBe('#openzeppelin-tokenCIP112-v1:OpenZeppelin.TokenCIP112V1.Registry:TokenRules');
  });

  it('reads interfaces with foreign template views, the caller token and the disclosure blob', async () => {
    await checkReads(
      { packageName: 'foreign', packageId: 'foreign-package', module: 'Issuer.Asset', entity: 'Balance' },
      HoldingInterface,
    );
  });
});
