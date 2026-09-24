import { InvalidRequest } from '../platform/errors.js';
import { bool, enumeration, list, long, notBlank, object, text, uuid, type JsonObject } from '../platform/request.js';
import {
  DECISIONS,
  DOCUMENT_CATEGORIES,
  type OnboardingApplication,
  type OnboardingDocument,
  type ReviewDecision,
} from './model.js';

const MAX_DOCUMENTS = 10;
const MAX_DOCUMENT_BYTES = 10_485_760n;
const MAX_APPROVED_POOLS = 20;
const COUNTRY_CODE = /^[A-Z]{2}$/;

export interface PartySubmission {
  readonly preparationId: string;
  readonly signature: string;
}

function invalid(): never {
  throw new InvalidRequest('Invalid request fields or request body');
}

function boundedText(value: string | null, max: number): string {
  if (!notBlank(value) || value.length > max) invalid();
  return value;
}

function required<T>(value: T | null): T {
  if (value === null) invalid();
  return value;
}

function onboardingDocument(value: unknown): OnboardingDocument {
  const fields = required(object(value));
  const document = {
    id: uuid(fields.id),
    category: enumeration(fields.category, DOCUMENT_CATEGORIES),
    fileName: text(fields.fileName),
    mediaType: text(fields.mediaType),
    sizeBytes: long(fields.sizeBytes),
    simulated: bool(fields.simulated),
  };
  const sizeBytes = required(document.sizeBytes);
  if (sizeBytes < 0n || sizeBytes > MAX_DOCUMENT_BYTES || document.simulated !== true) invalid();
  return {
    id: required(document.id),
    category: required(document.category),
    fileName: boundedText(document.fileName, 200),
    mediaType: boundedText(document.mediaType, 120),
    sizeBytes: Number(sizeBytes),
    simulated: true,
  };
}

/**
 * POST /v1/onboardings. Every field is decoded before any field is validated. One to ten distinct
 * simulated documents or historical references.
 */
export function onboardingApplication(body: JsonObject): OnboardingApplication {
  const legalName = text(body.legalName);
  const countryCode = text(body.countryCode);
  const references = list(body.documentReferences, text) ?? [];
  const documents = list(body.documents, (item) => (item === null ? null : onboardingDocument(item))) ?? [];
  const count = references.length + documents.length;
  const ids = new Set(documents.map((document) => document?.id));
  if (
    references.length > MAX_DOCUMENTS ||
    documents.length > MAX_DOCUMENTS ||
    count < 1 ||
    count > MAX_DOCUMENTS ||
    ids.size !== documents.length ||
    countryCode === null ||
    !COUNTRY_CODE.test(countryCode)
  ) {
    invalid();
  }
  return {
    legalName: boundedText(legalName, 120),
    countryCode,
    documentReferences: references.map((reference) => boundedText(reference, 200)),
    documents: documents.map((document) => required(document)),
  };
}

export function reviewDecision(body: JsonObject): ReviewDecision {
  const decision = enumeration(body.decision, DECISIONS);
  const approvedPoolIds = list(body.approvedPoolIds, text);
  const partyHint = text(body.partyHint);
  if (approvedPoolIds === null || approvedPoolIds.length > MAX_APPROVED_POOLS) invalid();
  return {
    decision: required(decision),
    approvedPoolIds: approvedPoolIds.map((id) => (notBlank(id) ? id : invalid())),
    partyHint,
  };
}

export function partyKey(body: JsonObject): string {
  return boundedText(text(body.publicKey), 200);
}

export function partySubmission(body: JsonObject): PartySubmission {
  const preparationId = uuid(body.preparationId);
  const signature = text(body.signature);
  return { preparationId: required(preparationId), signature: boundedText(signature, 100) };
}
