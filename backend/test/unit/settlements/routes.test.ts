import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Caller } from '../../../src/iam/authentication.js';
import { jsonText } from '../../../src/platform/json.js';
import { createServer } from '../../../src/platform/server.js';
import type { QueueRequest } from '../../../src/settlements/model.js';
import type { SettlementLedger } from '../../../src/settlements/ports.js';
import { registerSettlementRoutes } from '../../../src/settlements/routes.js';
import { SettlementStore } from '../../../src/settlements/store.js';
import { SettlementWorkflow } from '../../../src/settlements/workflow.js';
import { swap, withoutDatabase } from './fixtures.js';

const CALLER: Caller = {
  account: { id: randomUUID(), issuer: 'issuer', subject: 'operator', displayName: 'Operator', role: 'OPERATOR' },
  accessToken: 'token',
};
const unused = () => Promise.reject(new Error('The queue route does not reach the ledger'));
const LEDGER: SettlementLedger = {
  snapshot: unused,
  preflight: unused,
  preview: unused,
  submit: unused,
  recover: unused,
};

/** A store whose queue is fixed, counting its reads. */
class QueueStore extends SettlementStore {
  reads = 0;

  constructor(private readonly queued: QueueRequest[]) {
    super(withoutDatabase(), 10);
  }

  override queue(poolId: string): Promise<QueueRequest[]> {
    expect(poolId).toBe('pool');
    this.reads += 1;
    return Promise.resolve(this.queued);
  }
}

describe('settlement request routes', () => {
  const queue = [swap(1n, 'READY'), swap(1n, 'BLOCKED'), swap(1n, 'UNRESOLVED'), swap(1n, 'SETTLING')];
  let store: QueueStore;
  let app: FastifyInstance;

  beforeEach(() => {
    store = new QueueStore(queue);
    app = createServer();
    app.decorateRequest('caller', null);
    app.addHook('onRequest', (request, _reply, done) => {
      request.caller = CALLER;
      done();
    });
    registerSettlementRoutes(app, new SettlementWorkflow(store, LEDGER, app.log));
  });

  afterEach(() => app.close());

  function request(status: string | undefined) {
    const query = status === undefined ? '' : `&status=${status}`;
    return app.inject({ method: 'GET', url: `/v1/admin/settlement-requests?poolId=pool${query}` });
  }

  it('default and explicit READY return only ready requests', async () => {
    for (const status of [undefined, 'READY']) {
      const response = await request(status);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(JSON.parse(jsonText(queue.slice(0, 1))));
    }
  });

  it('explicit active keeps the whole queue in arrival order', async () => {
    const response = await request('active');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(JSON.parse(jsonText(queue)));
  });

  it('rejects an unknown status without a queue read', async () => {
    expect((await request('unknown')).statusCode).toBe(400);
    expect(store.reads).toBe(0);
  });
});
