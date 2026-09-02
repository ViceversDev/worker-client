import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.ts';

test('executes an API-authorized Markdown delivery and removes artifact noindex', async () => {
  const originalFetch = globalThis.fetch;
  const waits = [];
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    requests.push({ url: requestUrl, init });

    if (requestUrl === 'https://example.com/page') {
      return new Response('<html><head></head><body>Human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (requestUrl.includes('/v1/resolve/event')) return new Response(null, { status: 204 });
    if (requestUrl.includes('/v1/resolve?')) {
      return Response.json({
        links: [
          {
            rel: 'alternate',
            type: 'text/markdown',
            href: 'https://cdn.vicevers.dev/site/page.md',
            targets: ['html', 'header'],
          },
        ],
        inline: {},
        agent_delivery: {
          mode: 'agent',
          format: 'markdown',
          href: 'https://cdn.vicevers.dev/site/page.md',
          bot_name: 'GPTBot',
        },
      });
    }
    if (requestUrl.startsWith('https://cdn.vicevers.dev/site/page.md')) {
      return new Response('# Agent page', {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'x-robots-tag': 'noindex',
          vary: 'Accept-Encoding',
        },
      });
    }
    throw new Error(`Unexpected fetch: ${requestUrl}`);
  };

  try {
    const response = await worker.fetch(
      new Request('https://example.com/page', { headers: { 'user-agent': 'GPTBot/1.0' } }),
      {
        VICEVERS_API: 'https://api.vicevers.dev/v1/resolve',
        VICEVERS_SITE_KEY: 'vvsk_test',
      },
      { waitUntil: (promise) => waits.push(promise) }
    );
    await Promise.all(waits);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '# Agent page');
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(response.headers.get('x-robots-tag'), null);
    assert.equal(response.headers.get('x-vicevers-mode'), 'agent');
    assert.equal(response.headers.get('x-vicevers-format'), 'markdown');
    assert.equal(response.headers.get('x-vicevers-bot'), 'GPTBot');
    assert.equal(response.headers.get('vary'), 'Accept-Encoding, User-Agent, Accept');
    assert.equal(response.headers.get('link'), '<https://example.com/page>; rel="canonical"');

    const resolveRequest = requests.find(({ url }) => url.includes('/v1/resolve?'));
    assert.match(resolveRequest.url, /ua_key=[0-9a-f]{16}/);
    assert.match(resolveRequest.url, /accept_key=[0-9a-f]{16}/);
    assert.equal(resolveRequest.init.headers['X-Vicevers-Visitor-UA'], 'GPTBot/1.0');
    assert.equal(resolveRequest.init.headers['X-Vicevers-Visitor-Accept'], '');
    assert.ok(requests.some(({ url }) => url.includes('src=agent')));

    const eventRequest = requests.find(({ url }) => url.includes('/v1/resolve/event'));
    assert.equal(JSON.parse(eventRequest.init.body).test, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwards the visitor Accept header to resolve, keyed separately from the UA cache key', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    requests.push({ url: requestUrl, init });

    if (requestUrl === 'https://example.com/page') {
      return new Response('<html><head></head><body>Human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (requestUrl.includes('/v1/resolve/event')) return new Response(null, { status: 204 });
    if (requestUrl.includes('/v1/resolve?')) return Response.json({ links: [], inline: {} });
    throw new Error(`Unexpected fetch: ${requestUrl}`);
  };

  try {
    await worker.fetch(
      new Request('https://example.com/page', {
        headers: { 'user-agent': 'GPTBot/1.0', accept: 'text/markdown, text/html;q=0.5' },
      }),
      { VICEVERS_API: 'https://api.vicevers.dev/v1/resolve', VICEVERS_SITE_KEY: 'vvsk_test' },
      { waitUntil: (promise) => promise }
    );

    const resolveRequest = requests.find(({ url }) => url.includes('/v1/resolve?'));
    assert.equal(
      resolveRequest.init.headers['X-Vicevers-Visitor-Accept'],
      'text/markdown, text/html;q=0.5'
    );
    assert.match(resolveRequest.url, /accept_key=[0-9a-f]{16}/);

    // Different Accept values must not collapse onto the same edge cache
    // entry as an empty one — otherwise one visitor's cached resolve
    // decision could leak to another with a different Accept.
    const [, acceptKeyValue] = resolveRequest.url.match(/accept_key=([0-9a-f]{16})/);
    const emptyAcceptDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(''));
    const emptyAcceptKey = Array.from(new Uint8Array(emptyAcceptDigest).slice(0, 8), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    assert.notEqual(acceptKeyValue, emptyAcceptKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('tags internal QA traffic without changing delivery', async () => {
  const originalFetch = globalThis.fetch;
  const waits = [];
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    const requestHeaders = input instanceof Request ? input.headers : new Headers(init.headers || {});
    requests.push({ url: requestUrl, init, headers: requestHeaders });

    if (requestUrl === 'https://example.com/page') {
      return new Response('<html><head></head><body>Human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (requestUrl.includes('/v1/resolve/event')) return new Response(null, { status: 204 });
    if (requestUrl.includes('/v1/resolve?')) {
      return Response.json({
        links: [
          {
            rel: 'alternate',
            type: 'text/markdown',
            href: 'https://cdn.vicevers.dev/site/page.md',
            targets: ['html', 'header'],
          },
        ],
        inline: {},
        agent_delivery: {
          mode: 'agent',
          format: 'markdown',
          href: 'https://cdn.vicevers.dev/site/page.md',
          bot_name: 'GPTBot',
        },
      });
    }
    if (requestUrl.startsWith('https://cdn.vicevers.dev/site/page.md')) {
      return new Response('# Agent page', {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    }
    throw new Error(`Unexpected fetch: ${requestUrl}`);
  };

  try {
    const response = await worker.fetch(
      new Request('https://example.com/page', {
        headers: { 'user-agent': 'GPTBot/1.0', 'X-Vicevers-Internal-Test': '1' },
      }),
      {
        VICEVERS_API: 'https://api.vicevers.dev/v1/resolve',
        VICEVERS_SITE_KEY: 'vvsk_test',
      },
      { waitUntil: (promise) => waits.push(promise) }
    );
    await Promise.all(waits);

    // Delivery is unaffected — same agent-mode response as an untagged request.
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '# Agent page');

    const eventRequest = requests.find(({ url }) => url.includes('/v1/resolve/event'));
    assert.equal(JSON.parse(eventRequest.init.body).test, true);

    const alternateRequest = requests.find(({ url }) => url.includes('src=agent'));
    assert.equal(alternateRequest.headers.get('X-Vicevers-Internal-Test'), '1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwards the raw utm_source on the tracked event, unclassified', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    requests.push({ url: requestUrl, init });

    if (requestUrl.startsWith('https://example.com/page')) {
      return new Response('<html><head></head><body>Human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (requestUrl.includes('/v1/resolve/event')) return new Response(null, { status: 204 });
    if (requestUrl.includes('/v1/resolve?')) {
      return Response.json({ links: [], inline: {} });
    }
    throw new Error(`Unexpected fetch: ${requestUrl}`);
  };

  try {
    await worker.fetch(
      new Request('https://example.com/page?utm_source=chatgpt.com', {
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/140.0' },
      }),
      { VICEVERS_API: 'https://api.vicevers.dev/v1/resolve', VICEVERS_SITE_KEY: 'vvsk_test' },
      { waitUntil: (promise) => promise }
    );

    const eventRequest = requests.find(({ url }) => url.includes('/v1/resolve/event'));
    // Classification (is "chatgpt.com" actually ChatGPT?) is the Vicevers
    // API's job now, not this Worker's — see worker-api's handleEvent.
    assert.equal(JSON.parse(eventRequest.init.body).utm_source, 'chatgpt.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('attaches the edge-geolocated country whenever the click carries a utm_source', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    requests.push({ url: requestUrl, init });

    if (requestUrl.startsWith('https://example.com/page')) {
      return new Response('<html><head></head><body>Human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (requestUrl.includes('/v1/resolve/event')) return new Response(null, { status: 204 });
    if (requestUrl.includes('/v1/resolve?')) {
      return Response.json({ links: [], inline: {} });
    }
    throw new Error(`Unexpected fetch: ${requestUrl}`);
  };

  try {
    // `cf` is a Cloudflare Workers runtime extension on the incoming
    // Request, not something the Request constructor accepts — set it the
    // same way the real runtime attaches it, as a plain property.
    const request = new Request('https://example.com/page?utm_source=chatgpt.com', {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/140.0' },
    });
    request.cf = { country: 'AR' };

    await worker.fetch(
      request,
      { VICEVERS_API: 'https://api.vicevers.dev/v1/resolve', VICEVERS_SITE_KEY: 'vvsk_test' },
      { waitUntil: (promise) => promise }
    );

    const eventRequest = requests.find(({ url }) => url.includes('/v1/resolve/event'));
    assert.equal(JSON.parse(eventRequest.init.body).country, 'AR');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('leaves country empty on an ordinary visit even when the edge reports one', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    requests.push({ url: requestUrl, init });

    if (requestUrl.startsWith('https://example.com/page')) {
      return new Response('<html><head></head><body>Human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (requestUrl.includes('/v1/resolve/event')) return new Response(null, { status: 204 });
    if (requestUrl.includes('/v1/resolve?')) {
      return Response.json({ links: [], inline: {} });
    }
    throw new Error(`Unexpected fetch: ${requestUrl}`);
  };

  try {
    // No utm_source at all, so nothing worth geolocating — the country
    // should not be attached even though the edge geolocation is available.
    // (Whether a *present* utm_source is actually a recognized assistant is
    // now the Vicevers API's call, not this Worker's — see worker-api.)
    const request = new Request('https://example.com/page', {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/140.0' },
    });
    request.cf = { country: 'AR' };

    await worker.fetch(
      request,
      { VICEVERS_API: 'https://api.vicevers.dev/v1/resolve', VICEVERS_SITE_KEY: 'vvsk_test' },
      { waitUntil: (promise) => promise }
    );

    const eventRequest = requests.find(({ url }) => url.includes('/v1/resolve/event'));
    assert.equal(JSON.parse(eventRequest.init.body).country, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwards an unrecognized utm_source as-is instead of filtering it locally', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    requests.push({ url: requestUrl, init });

    if (requestUrl.startsWith('https://example.com/page')) {
      return new Response('<html><head></head><body>Human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (requestUrl.includes('/v1/resolve/event')) return new Response(null, { status: 204 });
    if (requestUrl.includes('/v1/resolve?')) {
      return Response.json({ links: [], inline: {} });
    }
    throw new Error(`Unexpected fetch: ${requestUrl}`);
  };

  try {
    // An ordinary marketing UTM, not an AI assistant. This Worker no longer
    // decides that — it just forwards what was on the URL and lets the
    // Vicevers API recognize (or, here, not recognize) it.
    await worker.fetch(
      new Request('https://example.com/page?utm_source=newsletter', {
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/140.0' },
      }),
      { VICEVERS_API: 'https://api.vicevers.dev/v1/resolve', VICEVERS_SITE_KEY: 'vvsk_test' },
      { waitUntil: (promise) => promise }
    );

    const eventRequest = requests.find(({ url }) => url.includes('/v1/resolve/event'));
    assert.equal(JSON.parse(eventRequest.init.body).utm_source, 'newsletter');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('leaves utm_source empty for an ordinary visit with no utm_source at all', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    requests.push({ url: requestUrl, init });

    if (requestUrl.startsWith('https://example.com/page')) {
      return new Response('<html><head></head><body>Human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (requestUrl.includes('/v1/resolve/event')) return new Response(null, { status: 204 });
    if (requestUrl.includes('/v1/resolve?')) {
      return Response.json({ links: [], inline: {} });
    }
    throw new Error(`Unexpected fetch: ${requestUrl}`);
  };

  try {
    await worker.fetch(
      new Request('https://example.com/page', { headers: { 'user-agent': 'Mozilla/5.0 Chrome/140.0' } }),
      { VICEVERS_API: 'https://api.vicevers.dev/v1/resolve', VICEVERS_SITE_KEY: 'vvsk_test' },
      { waitUntil: (promise) => promise }
    );

    const eventRequest = requests.find(({ url }) => url.includes('/v1/resolve/event'));
    assert.equal(JSON.parse(eventRequest.init.body).utm_source, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
