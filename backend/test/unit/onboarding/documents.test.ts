import { describe, expect, it } from 'vitest';
import { onboardingApplication } from '../../../src/onboarding/requests.js';
import { InvalidRequest } from '../../../src/platform/errors.js';
import { object, parseJson } from '../../../src/platform/request.js';

function read(json: string) {
  const body = object(parseJson(json));
  if (body === null) throw new Error('No body');
  return onboardingApplication(body);
}

describe('onboarding documents', () => {
  it('reads historical references and rejects missing or real uploads', () => {
    const old = read('{"legalName":"David","countryCode":"AR","documentReferences":["legacy-reference"]}');
    expect(old.documents).toEqual([]);
    expect(JSON.stringify(old)).not.toContain('documentSelectionValid');
    expect(() => read('{"legalName":"David","countryCode":"AR"}')).toThrow(InvalidRequest);
    expect(() =>
      read(
        '{"legalName":"David","countryCode":"AR","documents":[{"id":"00000000-0000-0000-0000-000000000001","category":"IDENTITY","fileName":"test.pdf","mediaType":"application/pdf","sizeBytes":1,"simulated":false}]}',
      ),
    ).toThrow(InvalidRequest);
  });
});
