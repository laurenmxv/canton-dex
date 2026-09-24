import { invalidBody } from '../platform/errors.js';
import { notBlank, object, text, type JsonObject } from '../platform/request.js';
import type { Instrument } from '../tokens/model.js';
import type { CreateProposal } from './model.js';

const MAX_NAME = 120;
const MAX_ADMIN = 255;
const MAX_ID = 128;

function bounded(value: string | null, max: number): string {
  if (!notBlank(value) || value.length > max) throw invalidBody();
  return value;
}

function instrument(value: unknown): Instrument | null {
  const fields = object(value);
  if (fields === null) return null;
  return { admin: bounded(text(fields.admin), MAX_ADMIN), id: bounded(text(fields.id), MAX_ID) };
}

/** POST /v1/admin/pool-proposals. Every field is decoded before the constraints apply. */
export function createProposal(body: JsonObject): CreateProposal {
  const name = text(body.name);
  const baseInstrumentId = instrument(body.baseInstrumentId);
  const quoteInstrumentId = instrument(body.quoteInstrumentId);
  const feeBps = text(body.feeBps);
  if (baseInstrumentId === null || quoteInstrumentId === null || feeBps === null) throw invalidBody();
  return { name: bounded(name, MAX_NAME), baseInstrumentId, quoteInstrumentId, feeBps };
}
