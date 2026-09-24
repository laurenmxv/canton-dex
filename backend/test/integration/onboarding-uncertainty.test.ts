import { describe, expect, it } from 'vitest';
import { withBackend } from './support/backend.js';
import { text } from '../support/json.js';
import { completedOnboarding } from './support/onboarding-ledger.js';
import { scenario } from './support/scenario.js';

describe.runIf(scenario('onboarding'))('onboarding uncertainty', () => {
  it('recovers the exact command without duplicate emission when the database confirmation is missing', () =>
    withBackend(async (test) => {
      const name = await test.trader('recovery');
      const token = await test.token(name);
      const id = text(await test.create(token), 'id');
      await test.approve(id);
      const completed = await test.register(id, token);
      // Reproduce the durable state at a crash after ledger commit but before its database confirmation.
      await test.fixtures.db
        .updateTable('onboarding_steps')
        .set({ status: 'SUBMITTING', contract_id: null, update_id: null, issuer: null })
        .where('onboarding_id', '=', id)
        .where('step_key', '=', 'attestation')
        .execute();
      expect(await test.completed(token)).toEqual(completed);
      await completedOnboarding(test.fixtures, completed, [await test.poolId()]);
    }));
});
