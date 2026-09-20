import { describe, expect, it } from 'vitest';
import { DexClientError } from '../errors.js';
import { COMPLETED_ONBOARDING, jsonResponse, recordFetch } from '../test-support.js';
import { createSend, segment } from './http.js';

const TOKEN = 'header.payload.signature';
const ACCEPTED = 'application/json';

function sendWith(
  reply: () => Response | Promise<Response>,
  overrides: Partial<Parameters<typeof createSend>[0]> = {},
) {
  const recorder = recordFetch(reply);
  const send = createSend({
    baseUrl: 'https://venue.example.com',
    getAccessToken: () => TOKEN,
    fetchImpl: recorder.fetchImpl,
    ...overrides,
  });
  return { send, recorder };
}

describe('where the request goes', () => {
  const cases: [string, string, string][] = [
    ['an origin', 'https://venue.example.com', 'https://venue.example.com/v1/onboardings'],
    ['a trailing slash', 'https://venue.example.com/', 'https://venue.example.com/v1/onboardings'],
    ['a path prefix', 'https://venue.example.com/dex', 'https://venue.example.com/dex/v1/onboardings'],
    ['a prefix and a slash', 'https://venue.example.com/dex/', 'https://venue.example.com/dex/v1/onboardings'],
    ['a same-origin path', '/api', '/api/v1/onboardings'],
    ['the site root', '/', '/v1/onboardings'],
  ];

  it.each(cases)('keeps %s intact', async (_name, baseUrl, expected) => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING), { baseUrl });
    await send({ method: 'GET', path: '/v1/onboardings' });
    expect(recorder.calls[0]?.url).toBe(expected);
  });

  it.each([
    ['a bare host and port', 'venue.example.com:8080'],
    ['a protocol-relative host', '//venue.example.com'],
    // Rejected by shape, not by where it resolves: this one names the probe host
    // the origin check itself uses, so only the leading-slash rule catches it.
    ['a protocol-relative probe host', '//base.invalid'],
    ['a protocol-relative probe host with a path', '//base.invalid/dex'],
    ['three leading slashes', '///base.invalid'],
    ['four leading slashes', '////base.invalid'],
    // A backslash reads as a separator, so this resolves to http://unexpected.test.
    ['a backslash separator', `/${String.fromCharCode(92)}unexpected.test`],
    ['a backslash after a prefix', `/api/${String.fromCharCode(92)}unexpected.test`],
    ['a stripped newline', '/api\nx'],
    ['a stripped tab', '/api\tx'],
    ['a scheme with no host', 'https://'],
    ['a query string', 'https://venue.example.com/dex?tenant=a'],
    ['a fragment', '/api#section'],
  ])('refuses %s rather than sending the token somewhere unintended', (_name, baseUrl) => {
    expect(() => createSend({ baseUrl, getAccessToken: () => TOKEN })).toThrow(TypeError);
  });

  it.each([
    ['a backslash separator', `/${String.fromCharCode(92)}unexpected.test`],
    ['a host that matches the origin check itself', '//base.invalid'],
  ])('refuses %s before a client exists, so nothing is ever sent', (_name, baseUrl) => {
    const recorder = recordFetch(() => jsonResponse(200, COMPLETED_ONBOARDING));

    expect(() =>
      createSend({ baseUrl, getAccessToken: () => TOKEN, fetchImpl: recorder.fetchImpl }),
    ).toThrow(TypeError);
    expect(recorder.calls).toHaveLength(0);
  });

  it('refuses a runtime with no fetch at construction, not at the first request', () => {
    const original = globalThis.fetch;
    // @ts-expect-error a runtime without fetch is exactly what this guards.
    delete globalThis.fetch;
    try {
      expect(() => createSend({ baseUrl: '/api', getAccessToken: () => TOKEN })).toThrow(TypeError);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('encodes a dynamic segment rather than letting it change the path', () => {
    expect(segment('../admin/onboardings')).toBe('..%2Fadmin%2Fonboardings');
    expect(segment('7f1c3d9e-0000-4000-8000-000000000001')).toBe(
      '7f1c3d9e-0000-4000-8000-000000000001',
    );
  });

  it('encodes a query value rather than letting it add a parameter of its own', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, []));

    await send({
      method: 'GET',
      path: '/v1/admin/settlement-requests',
      query: { poolId: 'pool&status=active' },
    });

    expect(recorder.calls[0]?.url).toBe(
      'https://venue.example.com/v1/admin/settlement-requests?poolId=pool%26status%3Dactive',
    );
  });

  it('leaves out a parameter with no value, so the route applies its own default', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, []));

    await send({
      method: 'GET',
      path: '/v1/activity',
      query: { type: 'swap', status: undefined, limit: 25 },
    });

    expect(recorder.calls[0]?.url).toBe('https://venue.example.com/v1/activity?type=swap&limit=25');
  });

  it('appends nothing when a request carries no query at all', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, []));

    await send({ method: 'GET', path: '/v1/admin/settlements', query: {} });

    expect(recorder.calls[0]?.url).toBe('https://venue.example.com/v1/admin/settlements');
  });
});

describe('what the request carries', () => {
  it('records what fetch itself would see, whatever header shape it is given', async () => {
    const recorder = recordFetch(() => jsonResponse(200, COMPLETED_ONBOARDING));
    await recorder.fetchImpl('https://venue.example.com/x', {
      headers: new Headers({ Authorization: 'Bearer probe', Accept: ACCEPTED }),
    });
    expect(recorder.calls[0]?.headers).toEqual({
      authorization: 'Bearer probe',
      accept: ACCEPTED,
    });
  });

  it('sends a bearer token, asks for JSON, and joins no session', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING));
    await send({ method: 'GET', path: '/v1/onboardings' });

    const call = recorder.calls[0]!;
    expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['accept']).toContain('application/problem+json');
    expect(call.credentials).toBe('omit');
    expect(call.redirect).toBe('error');
  });

  it('leaves a bodyless request bodyless, with no content type', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING));
    await send({ method: 'POST', path: '/v1/onboardings/x/party/prepare' });

    const call = recorder.calls[0]!;
    expect(call.body).toBeUndefined();
    expect(call.headers['content-type']).toBeUndefined();
  });

  it('serializes a body only when there is one', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING));
    await send({ method: 'POST', path: '/v1/onboardings', body: { legalName: 'Acme' } });

    const call = recorder.calls[0]!;
    expect(call.body).toBe('{"legalName":"Acme"}');
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('sends no idempotency key, because the backend implements none', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING));
    await send({ method: 'POST', path: '/v1/onboardings', body: {} });

    const names = Object.keys(recorder.calls[0]!.headers);
    expect(names.some((name) => name.includes('idempotency'))).toBe(false);
  });
});

describe('the access token', () => {
  it('is read again for every request, so a refreshed one is used', async () => {
    const tokens = ['first', 'second', 'third'];
    let index = 0;
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING), {
      getAccessToken: () => tokens[index++]!,
    });

    await send({ method: 'GET', path: '/v1/onboardings' });
    await send({ method: 'GET', path: '/v1/onboardings' });

    expect(recorder.calls.map((call) => call.headers['authorization'])).toEqual([
      'Bearer first',
      'Bearer second',
    ]);
  });

  it('is awaited when the provider is asynchronous', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING), {
      getAccessToken: () => Promise.resolve('awaited'),
    });
    await send({ method: 'GET', path: '/v1/onboardings' });
    expect(recorder.calls[0]?.headers['authorization']).toBe('Bearer awaited');
  });

  it.each([
    ['missing', null],
    ['blank', '   '],
    ['empty', ''],
  ])('stops a %s token before anything is sent', async (_name, token) => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING), {
      getAccessToken: () => token,
    });

    await expect(send({ method: 'GET', path: '/v1/onboardings' })).rejects.toMatchObject({
      kind: 'authentication',
    });
    expect(recorder.calls).toHaveLength(0);
  });

  it('reports a failing provider as authentication, and sends nothing', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING), {
      getAccessToken: () => Promise.reject(new Error('The session expired')),
    });

    const error = await send({ method: 'GET', path: '/v1/onboardings' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DexClientError);
    expect((error as DexClientError).kind).toBe('authentication');
    expect(recorder.calls).toHaveLength(0);
  });

  it('never repeats the token in the error it throws', async () => {
    const { send } = sendWith(() =>
      jsonResponse(401, { status: 401, detail: 'A valid access token is required' }, 'application/problem+json'),
    );

    const error = (await send({ method: 'GET', path: '/v1/onboardings' }).catch(
      (e: unknown) => e,
    )) as DexClientError;
    expect(JSON.stringify({ message: error.message, problem: error.problem })).not.toContain(TOKEN);
  });
});

describe('an answer that is not a success', () => {
  it('keeps the status and the Problem Details the backend sent', async () => {
    const { send } = sendWith(() =>
      jsonResponse(
        409,
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This request already has a different review',
          instance: '/v1/admin/onboardings/x/review',
        },
        'application/problem+json',
      ),
    );

    const error = (await send({ method: 'POST', path: '/x', body: {} }).catch(
      (e: unknown) => e,
    )) as DexClientError;
    expect(error.kind).toBe('http');
    expect(error.status).toBe(409);
    expect(error.problem).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'This request already has a different review',
      instance: '/v1/admin/onboardings/x/review',
    });
    expect(error.message).toContain('This request already has a different review');
  });

  it.each([401, 403, 404, 409, 500])('keeps %i distinguishable by status', async (status) => {
    const { send } = sendWith(() => new Response('<html>gateway</html>', { status }));

    const error = (await send({ method: 'GET', path: '/x' }).catch(
      (e: unknown) => e,
    )) as DexClientError;
    expect(error.kind).toBe('http');
    expect(error.status).toBe(status);
    expect(error.problem).toBeUndefined();
    // HTML is never repeated back as if it were a message from the venue.
    expect(error.message).toBe(`HTTP ${status}`);
  });

  it('stays an error on 404 rather than becoming null', async () => {
    const { send } = sendWith(() => new Response('', { status: 404 }));
    await expect(send({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(DexClientError);
  });

  it('keeps the status even when the body is malformed JSON', async () => {
    const { send } = sendWith(
      () => new Response('{"detail":', { status: 500, headers: { 'content-type': 'application/json' } }),
    );

    const error = (await send({ method: 'GET', path: '/x' }).catch(
      (e: unknown) => e,
    )) as DexClientError;
    expect(error.status).toBe(500);
    expect(error.problem).toBeUndefined();
  });
});

describe('an answer that claims success', () => {
  it.each([
    ['empty', ''],
    ['HTML', '<html>ok</html>'],
    ['malformed JSON', '{"id":'],
    ['a bare string', '"ok"'],
    ['null', 'null'],
  ])('rejects %s instead of passing it off as a record', async (_name, text) => {
    const { send } = sendWith(() => new Response(text, { status: 200 }));

    const error = (await send({ method: 'GET', path: '/x' }).catch(
      (e: unknown) => e,
    )) as DexClientError;
    expect(error).toBeInstanceOf(DexClientError);
    expect(error.kind).toBe('response');
  });

  it('accepts an array, which is what the admin list returns', async () => {
    const { send } = sendWith(() => jsonResponse(200, [COMPLETED_ONBOARDING]));
    await expect(send({ method: 'GET', path: '/x' })).resolves.toEqual([COMPLETED_ONBOARDING]);
  });
});

describe('when the request never lands', () => {
  it('keeps the status when the body cannot be read off the wire', async () => {
    const { send } = sendWith(() => ({
      ok: false,
      status: 503,
      text: () => Promise.reject(new TypeError('The connection dropped')),
    }) as unknown as Response);

    const error = (await send({ method: 'GET', path: '/x' }).catch(
      (e: unknown) => e,
    )) as DexClientError;
    expect(error.kind).toBe('http');
    expect(error.status).toBe(503);
  });

  it('reports an unreadable body on a success as a response failure', async () => {
    const { send } = sendWith(() => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new TypeError('The connection dropped')),
    }) as unknown as Response);

    await expect(send({ method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'response' });
  });

  it('separates a network failure from an HTTP answer', async () => {
    const { send } = sendWith(() => Promise.reject(new TypeError('Failed to fetch')));

    const error = (await send({ method: 'GET', path: '/x' }).catch(
      (e: unknown) => e,
    )) as DexClientError;
    expect(error.kind).toBe('network');
    expect(error.status).toBeUndefined();
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('tries a failed POST exactly once, because its outcome is unknown', async () => {
    const { send, recorder } = sendWith(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(send({ method: 'POST', path: '/x', body: {} })).rejects.toBeInstanceOf(
      DexClientError,
    );
    expect(recorder.calls).toHaveLength(1);
  });

  it('tries a failed GET exactly once too', async () => {
    const { send, recorder } = sendWith(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(send({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(DexClientError);
    expect(recorder.calls).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('sends nothing when the caller has already given up', async () => {
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING));
    const controller = new AbortController();
    controller.abort();

    await expect(
      send({ method: 'GET', path: '/x' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(recorder.calls).toHaveLength(0);
  });

  it.each([
    ['a usable token', TOKEN],
    ['no token at all', null],
    ['a blank token', '  '],
  ])(
    'reports the abort, not an auth failure, when the provider gives up and returns %s',
    async (_name, answer) => {
      const controller = new AbortController();
      const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING), {
        getAccessToken: async () => {
          controller.abort();
          return answer;
        },
      });

      const error = (await send({ method: 'GET', path: '/x' }, { signal: controller.signal }).catch(
        (e: unknown) => e,
      )) as Error;
      expect(error).not.toBeInstanceOf(DexClientError);
      expect(error.name).toBe('AbortError');
      expect(recorder.calls).toHaveLength(0);
    },
  );

  it('keeps an abort during the request an abort, not a business failure', async () => {
    const controller = new AbortController();
    const { send } = sendWith(() => {
      controller.abort();
      return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
    });

    const error = (await send({ method: 'GET', path: '/x' }, { signal: controller.signal }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error).not.toBeInstanceOf(DexClientError);
    expect(error.name).toBe('AbortError');
  });

  it('reports an abort raised by the token provider as an abort', async () => {
    const controller = new AbortController();
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING), {
      getAccessToken: () => {
        controller.abort();
        return Promise.reject(controller.signal.reason as Error);
      },
    });

    const error = (await send({ method: 'GET', path: '/x' }, { signal: controller.signal }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error).not.toBeInstanceOf(DexClientError);
    expect(error.name).toBe('AbortError');
    expect(recorder.calls).toHaveLength(0);
  });

  it('hands the signal to fetch, so the transport can stop too', async () => {
    const controller = new AbortController();
    const { send, recorder } = sendWith(() => jsonResponse(200, COMPLETED_ONBOARDING));

    await send({ method: 'GET', path: '/x' }, { signal: controller.signal });
    expect(recorder.calls[0]?.signal).toBe(controller.signal);
  });
});

describe('two requests in flight at once', () => {
  it('stay independent, with one attempt and one token each', async () => {
    const tokens = ['first', 'second'];
    let index = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { send, recorder } = sendWith(
      async () => {
        await gate;
        return jsonResponse(200, COMPLETED_ONBOARDING);
      },
      { getAccessToken: () => tokens[index++]! },
    );

    const both = Promise.all([
      send({ method: 'GET', path: '/a' }),
      send({ method: 'GET', path: '/b' }),
    ]);
    release!();
    await both;

    expect(recorder.calls.map((call) => call.url)).toEqual([
      'https://venue.example.com/a',
      'https://venue.example.com/b',
    ]);
    expect(recorder.calls.map((call) => call.headers['authorization'])).toEqual([
      'Bearer first',
      'Bearer second',
    ]);
  });
});
