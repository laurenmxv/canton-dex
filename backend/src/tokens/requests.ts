import { invalidBody } from '../platform/errors.js';
import { notBlank, text, uuid, type JsonObject } from '../platform/request.js';
import type { Submission } from './model.js';

/** POST /v1/dev/faucet/submit: the preparation id and the wallet's signature. */
export function faucetSubmission(body: JsonObject): Submission {
  const preparationId = uuid(body.preparationId);
  const signature = text(body.signature);
  if (preparationId === null || !notBlank(signature)) throw invalidBody();
  return { preparationId, signature };
}
