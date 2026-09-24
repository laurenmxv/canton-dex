import { invalidBody, InvalidRequest } from '../platform/errors.js';
import { bool, int, list, long, object, text, uuid, type JsonObject } from '../platform/request.js';
import {
  INCOMPLETE_SELECTION,
  requireFamily,
  selection,
  type RequestRef,
  type RunInput,
  type Selection,
  type UpdatePolicy,
} from './model.js';

const INVALID_REFERENCE = 'Invalid settlement request reference';

/** A public request reference: a known family and a request id. */
export function requestRef(type: string | null, requestId: string | null): RequestRef {
  if (requestId === null) throw new InvalidRequest(INVALID_REFERENCE);
  return { type: requireFamily(type), requestId };
}

function selectionInput(fields: JsonObject): Selection {
  const type = requireFamily(text(fields.type));
  const stateVersion = text(fields.stateVersion);
  const requests = list(fields.requests, (value) => {
    const ref = object(value);
    if (ref === null) throw new InvalidRequest(INVALID_REFERENCE);
    return requestRef(text(ref.type), uuid(ref.requestId));
  });
  if (stateVersion === null || requests === null) throw new InvalidRequest(INCOMPLETE_SELECTION);
  return selection(type, uuid(fields.retryOf), stateVersion, long(fields.policyVersion) ?? 0n, requests);
}

/** POST /v1/admin/pools/{poolId}/settlements. */
export function runInput(body: JsonObject): RunInput {
  const idempotencyKey = uuid(body.idempotencyKey);
  const fields = object(body.selection);
  const intent = fields === null ? null : selectionInput(fields);
  if (idempotencyKey === null) throw invalidBody();
  return { idempotencyKey, selection: intent };
}

/** PUT /v1/admin/pools/{poolId}/settlement-policy/{type}; the primitive fields default to zero. */
export function updatePolicyInput(body: JsonObject): UpdatePolicy {
  const automaticEnabled = bool(body.automaticEnabled) ?? false;
  const batchSize = int(body.batchSize) ?? 0;
  const expectedVersion = long(body.expectedVersion) ?? 0n;
  if (batchSize < 1 || expectedVersion < 0n) throw invalidBody();
  return { automaticEnabled, batchSize, expectedVersion };
}

/** PUT …/settlement-requests/{type}/{requestId}/deferred. */
export function deferredInput(body: JsonObject): boolean {
  const deferred = bool(body.deferred);
  if (deferred === null) throw invalidBody();
  return deferred;
}
