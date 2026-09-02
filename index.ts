// worker-client/index.ts

/**
 * Vicevers Worker — deployed to the customer's Cloudflare account.
 *
 * What it does:
 *  1. Passes the request through to the origin normally.
 *  2. Asks the Vicevers API whether structured content exists for the
 *     requested host and path.
 *  3. For each link the API returns, injects it wherever the API says it
 *     should go: as a <link> element in <head> ("html"), as an HTTP Link
 *     response header ("header"), or both. It also injects JSON-LD inline
 *     when the API includes it under its configured size threshold.
 *  4. On any Vicevers resolution or injection error, returns the untouched
 *     origin response. This fail-open behavior ensures that Vicevers never
 *     takes down the partner's site.
 *
 * This Worker contains no business logic and does not make account, pricing,
 * placement, or content decisions. Those belong to the Vicevers API — this
 * Worker only renders what it is told.
 */

// Which utm_source values actually belong to a recognized AI assistant is
// classified by the Vicevers API, not here: this Worker only forwards the
// raw utm_source it saw on the URL (see trackResolution below). Keeping that
// allowlist server-side means it can grow without a client Worker redeploy,
// and keeps it out of this file, which is published standalone.
function rawUtmSource(url: URL): string {
  return (url.searchParams.get('utm_source') || '').trim().toLowerCase();
}

interface VicevesLink {
  rel: string;
  type: string;
  href: string;
  targets: string[];
}

interface VicevesResolveData {
  links?: VicevesLink[];
  inline?: {
    json_ld?: unknown;
  };
  agent_delivery?: {
    mode?: unknown;
    format?: unknown;
    href?: unknown;
    bot_name?: unknown;
  };
}

interface AgentDelivery {
  mode: 'agent';
  format: 'markdown' | 'json_ld';
  href: string;
  botName: string;
}

interface Env {
  VICEVERS_API: string;
  VICEVERS_SITE_KEY: string;
}

const WORKER_VERSION = '7';

function isValidLink(link: unknown): link is VicevesLink {
  if (!link || typeof link !== 'object') return false;
  const candidate = link as Record<string, unknown>;
  return (
    typeof candidate.href === 'string' &&
    candidate.href.length > 0 &&
    typeof candidate.rel === 'string' &&
    typeof candidate.type === 'string' &&
    Array.isArray(candidate.targets)
  );
}

function isHtmlTarget(link: VicevesLink): boolean {
  return link.targets.includes('html');
}

function isHeaderTarget(link: VicevesLink): boolean {
  return link.targets.includes('header');
}

function resolvedAgentDelivery(data: VicevesResolveData, links: VicevesLink[]): AgentDelivery | null {
  const delivery = data?.agent_delivery;
  if (!delivery || delivery.mode !== 'agent') return null;
  if (delivery.format !== 'markdown' && delivery.format !== 'json_ld') return null;
  if (typeof delivery.href !== 'string' || typeof delivery.bot_name !== 'string') return null;

  const expectedType = delivery.format === 'markdown' ? 'text/markdown' : 'application/ld+json';
  const matchingLink = links.find((link) => link.href === delivery.href && link.type === expectedType);
  if (!matchingLink) return null;

  try {
    const href = new URL(delivery.href);
    if (href.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  return {
    mode: 'agent',
    format: delivery.format,
    href: delivery.href,
    botName: delivery.bot_name,
  };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function withDiscoveryContext(
  href: string,
  source: 'link-tag' | 'header' | 'agent',
  correlationId: string
): string {
  try {
    const url = new URL(href);
    url.searchParams.set('src', source);
    url.searchParams.set('cid', correlationId);
    return url.toString();
  } catch {
    return href;
  }
}

// Short digest used to key the edge cache of the resolve fetch below by a
// value that isn't itself safe to put in a URL — today the visitor's User-
// Agent and Accept header. `cf.cacheEverything` caches purely by URL, so
// without this two visitors sharing a cache-eligible URL but sending
// different UA/Accept would get served each other's cached decision.
async function shortDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 8), (value) => value.toString(16).padStart(2, '0')).join('');
}

function appendVary(headers: Headers, token: string): void {
  const values = (headers.get('vary') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === token.toLowerCase())) values.push(token);
  headers.set('vary', values.join(', '));
}

function agentResponse(
  response: Response,
  pageUrl: URL,
  delivery: AgentDelivery
): Response {
  const headers = new Headers(response.headers);
  const canonical = new URL(pageUrl);
  canonical.search = '';
  canonical.hash = '';

  headers.set(
    'content-type',
    delivery.format === 'markdown'
      ? 'text/markdown; charset=utf-8'
      : 'application/ld+json; charset=utf-8'
  );
  headers.set('cache-control', 'public, max-age=300');
  headers.set('link', `<${canonical.toString()}>; rel="canonical"`);
  headers.delete('x-robots-tag');
  headers.set('x-vicevers-worker', WORKER_VERSION);
  headers.set('x-vicevers-mode', 'agent');
  headers.set('x-vicevers-format', delivery.format === 'markdown' ? 'markdown' : 'json_ld');
  headers.set('x-vicevers-bot', delivery.botName.replace(/[\r\n]/g, ''));
  appendVary(headers, 'User-Agent');
  // The representation now also depends on what the visitor's Accept header
  // asked for (see worker-api's selectDeliveryFormat), not just its UA.
  appendVary(headers, 'Accept');

  return new Response(response.body, { status: 200, headers });
}

function hasExpectedAgentContentType(response: Response, delivery: AgentDelivery): boolean {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const expectedType = delivery.format === 'markdown' ? 'text/markdown' : 'application/ld+json';
  return contentType.includes(expectedType);
}

function renderLinkTag(link: VicevesLink, correlationId: string): string {
  const href = withDiscoveryContext(link.href, 'link-tag', correlationId);
  return `<link rel="${escapeAttr(link.rel)}" type="${escapeAttr(link.type)}" href="${escapeAttr(href)}" />`;
}

function renderLinkHeaderValue(link: VicevesLink, correlationId: string): string {
  // Header field values must not contain raw CR/LF; href/rel/type are
  // expected to be plain tokens or URLs, so this only guards against a
  // malformed API response smuggling a header injection.
  const sanitize = (value: string) => value.replace(/[\r\n]/g, '');
  const href = withDiscoveryContext(link.href, 'header', correlationId);
  return `<${sanitize(href)}>; rel="${sanitize(link.rel)}"; type="${sanitize(link.type)}"`;
}

class HeadInjector {
  private readonly links: VicevesLink[];
  private readonly inlineJsonLd: unknown;
  private readonly correlationId: string;

  constructor(links: VicevesLink[], inlineJsonLd: unknown, correlationId: string) {
    this.links = links;
    this.inlineJsonLd = inlineJsonLd;
    this.correlationId = correlationId;
  }

  element(el: Element) {
    for (const link of this.links) {
      if (isHtmlTarget(link)) {
        el.append(renderLinkTag(link, this.correlationId), { html: true });
      }
    }

    if (this.inlineJsonLd) {
      // `</script>` inside a JSON string is recognized by the HTML parser
      // even inside a string literal, so every `<` is escaped to keep the
      // payload as inert JSON text.
      const serialized = JSON.stringify(this.inlineJsonLd).replace(/</g, '\\u003c');
      el.append(`<script type="application/ld+json">${serialized}</script>`, { html: true });
    }
  }
}

function withLinkHeader(
  response: Response,
  links: VicevesLink[],
  correlationId: string
): Response {
  const headerLinks = links
    .filter(isHeaderTarget)
    .map((link) => renderLinkHeaderValue(link, correlationId));
  if (headerLinks.length === 0) return response;

  const headers = new Headers(response.headers);
  headers.append('Link', headerLinks.join(', '));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function trackResolution(
  ctx: ExecutionContext,
  env: Env,
  request: Request,
  url: URL,
  result: 'hit' | 'miss',
  correlationId: string,
  isInternalTest: boolean
) {
  const eventUrl = new URL(env.VICEVERS_API);
  eventUrl.pathname = `${eventUrl.pathname.replace(/\/$/, '')}/event`;
  eventUrl.search = '';
  // Read here, not on `url.pathname` above: this is the only place that
  // still has the incoming request's query string, which is where an
  // assistant's citation link carries `utm_source`. Forwarded raw — whether
  // it names a recognized assistant is decided by the Vicevers API (see
  // rawUtmSource above).
  const utmSource = rawUtmSource(url);
  // Cloudflare's own edge geolocation of this request — present on every
  // Workers request via `request.cf` at no extra cost, no external IP
  // lookup involved. Sent whenever the click carries a utm_source at all;
  // the Vicevers API is the one that knows the allowlist and drops it again
  // unless the utm_source turns out to name a recognized assistant, so it
  // never ends up attached to an ordinary visit — that's the one signal
  // this was asked for, and it keeps what's actually retained to a minimum.
  const country = utmSource
    ? (request as unknown as { cf?: { country?: string } }).cf?.country || ''
    : '';
  ctx.waitUntil(
    fetch(eventUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Vicevers-Site-Key': env.VICEVERS_SITE_KEY,
        'X-Vicevers-Worker-Version': WORKER_VERSION,
      },
      body: JSON.stringify({
        host: url.hostname,
        path: url.pathname,
        result,
        cid: correlationId,
        ua: request.headers.get('user-agent') || '',
        test: isInternalTest,
        utm_source: utmSource,
        country,
      }),
    }).catch((error) => console.error('vicevers-worker analytics error:', error))
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const bypassInjection = url.searchParams.getAll('vicevers').includes('off');
    let originRequest = request;

    if (bypassInjection) {
      const originUrl = new URL(url);
      originUrl.searchParams.delete('vicevers');
      originRequest = new Request(originUrl.toString(), request);
    }

    let originResponse: Response;
    try {
      originResponse = await fetch(originRequest);
    } catch (e) {
      // There is no response to transform when the origin fetch itself fails.
      console.error('vicevers-worker origin fetch error:', e);
      return new Response('Bad Gateway', { status: 502 });
    }

    try {
      // A per-request bypass for A/B testing. The control parameter is removed
      // before reaching the origin, and the response is returned untouched.
      if (bypassInjection) {
        return originResponse;
      }

      // Each site has its own key so it can be managed independently.
      const siteKey = env.VICEVERS_SITE_KEY;
      if (!siteKey) {
        console.error('vicevers-worker: VICEVERS_SITE_KEY is not configured');
        return originResponse;
      }

      // Semantic alternates describe HTML pages. Skip assets and other
      // response types before contacting Vicevers so a page load does not
      // resolve every stylesheet, script, image, font, or API response.
      const contentType = originResponse.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('text/html')) {
        return originResponse;
      }

      // One opaque ID per HTML response connects this resolution event with
      // any alternate URL subsequently fetched from this response.
      const correlationId = crypto.randomUUID();
      const userAgent = request.headers.get('user-agent') || '';
      // Absent Accept means "accepts anything" per HTTP semantics, and
      // worker-api's selectDeliveryFormat treats '' that way — see there.
      const acceptHeader = request.headers.get('accept') || '';

      // Internal QA/dev traffic self-tags with this header so it keeps
      // flowing through the exact same code path (nothing about delivery
      // changes) but lands in Analytics Engine marked as synthetic, kept out
      // of the metrics a site owner sees by default. Never trust this from
      // an untrusted caller for anything security-sensitive — it only ever
      // affects reporting, not access or delivery.
      const isInternalTest = request.headers.get('X-Vicevers-Internal-Test') === '1';

      // Confirms the Worker is installed and active, independent of whether
      // this specific path resolves to any content — used by the dashboard's
      // "verify installation" check.
      originResponse = new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: new Headers(originResponse.headers),
      });
      originResponse.headers.set('X-Vicevers-Worker', WORKER_VERSION);

      const resolveUrl =
        `${env.VICEVERS_API}?host=${encodeURIComponent(url.hostname)}` +
        `&path=${encodeURIComponent(url.pathname)}` +
        `&ua_key=${await shortDigest(userAgent)}` +
        `&accept_key=${await shortDigest(acceptHeader)}`;

      const resolveResponse = await fetch(resolveUrl, {
        headers: {
          'X-Vicevers-Site-Key': siteKey,
          'X-Vicevers-Worker-Version': WORKER_VERSION,
          'X-Vicevers-Visitor-UA': userAgent,
          'X-Vicevers-Visitor-Accept': acceptHeader,
        },
        // Cache API resolutions at the edge for five minutes.
        cf: { cacheTtl: 300, cacheEverything: true },
        // Keep API failures from noticeably delaying the origin response.
        signal: AbortSignal.timeout(1200),
      });

      if (!resolveResponse.ok) {
        if (resolveResponse.status === 404) {
          trackResolution(ctx, env, request, url, 'miss', correlationId, isInternalTest);
        }
        console.error('vicevers-worker resolve failed:', resolveResponse.status);
        return originResponse;
      }

      const data = (await resolveResponse.json()) as VicevesResolveData;
      const links = Array.isArray(data?.links) ? data.links.filter(isValidLink) : [];
      const inlineJsonLd = data?.inline?.json_ld ?? null;
      const delivery = resolvedAgentDelivery(data, links);

      if (links.length === 0 && !inlineJsonLd) {
        trackResolution(ctx, env, request, url, 'miss', correlationId, isInternalTest);
        return originResponse;
      }

      trackResolution(ctx, env, request, url, 'hit', correlationId, isInternalTest);

      if (request.method === 'GET' && originResponse.status === 200 && delivery) {
        try {
          const alternateResponse = await fetch(
            withDiscoveryContext(delivery.href, 'agent', correlationId),
            {
              headers: {
                'user-agent': userAgent,
                ...(isInternalTest ? { 'X-Vicevers-Internal-Test': '1' } : {}),
              },
              cf: { cacheTtl: 300, cacheEverything: true },
              signal: AbortSignal.timeout(1200),
            }
          );
          if (alternateResponse.ok && hasExpectedAgentContentType(alternateResponse, delivery)) {
            return agentResponse(alternateResponse, url, delivery);
          }
          console.error('vicevers-worker agent delivery failed:', alternateResponse.status);
        } catch (error) {
          console.error('vicevers-worker agent delivery error:', error);
        }
      }

      // Add the HTTP Link header before rewriting the same HTML response.
      const withLink = withLinkHeader(originResponse, links, correlationId);

      return new HTMLRewriter()
        .on('head', new HeadInjector(links, inlineJsonLd, correlationId))
        .transform(withLink);
    } catch (e) {
      // Fail open with the origin response for any resolution or rewrite error.
      console.error('vicevers-worker resolve error:', e);
      return originResponse;
    }
  },
};
