# Vicevers Worker

This Worker is installed in **your own Cloudflare account** and runs in front
of your domain. Vicevers does not take control of your DNS or hosting
infrastructure.

## What it does

For each HTML page request, the Worker asks the Vicevers API whether structured
content is available for that specific URL. When available, it adds alternate
JSON-LD and Markdown references to the page `<head>` and may include JSON-LD
inline when it is small enough.

Alternate URLs injected in the HTML use `src=link-tag`; URLs exposed through
the HTTP `Link` header use `src=header`. These optional parameters let
Vicevers measure which discovery mechanism led to a successful content fetch.
Each HTML response also receives a random, opaque `cid` that is included in
both discovery mechanisms and in the HTML resolution event. This allows the
HTML request and a subsequent alternate fetch to be correlated without using
an IP address or another persistent visitor identifier.

If the Vicevers API is slow, unavailable, or returns an error, the original
website response is served unchanged. The integration is fail-open and never
depends on Vicevers to keep your website available.

## Testing bypass

Append `?vicevers=off` to a URL to compare the page with and without the
integration. The Worker removes this control parameter before requesting the
page from your origin and returns the origin response without any Vicevers
injection.

For example:

```text
https://example.com/page?vicevers=off
```

Other query parameters are preserved.

## Analytics and privacy

For each resolved HTML page, the Worker sends Vicevers the hostname, path,
whether generated content was available, and the request `User-Agent`. The
`User-Agent` is classified in memory as an AI bot, traditional crawler, or
browser; its original value is not stored.

Analytics retain only the site, path, resolution result, visitor category, and
detected bot name when applicable. Events are sent in the background and do
not delay or determine the website response. Metrics are retained for up to
90 days.

## Installation: Deploy to Cloudflare

1. Open the **Integration** page for your verified site in the
   [Vicevers dashboard](https://app.vicevers.dev) and select
   **Deploy to Cloudflare**.
2. Authorize the deployment with your Cloudflare account. Cloudflare copies
   the Worker into your account, where you remain in control of the code and
   deployment.
3. When prompted for `VICEVERS_SITE_KEY`, paste the site key shown in the
   Vicevers dashboard. Cloudflare stores it as an encrypted secret.
4. Complete the deployment.
5. In Cloudflare, open the new Worker and go to
   **Settings > Domains & Routes > Add > Route**. Add `example.com/*` and, if
   applicable, `www.example.com/*`.

The Worker starts processing traffic only after its route is attached to your
domain.

## Multiple sites

Use a separate Worker deployment and `VICEVERS_SITE_KEY` for each site. This
keeps credentials and lifecycle management independent: disabling one site
does not affect any other site in the same Cloudflare account.

## Manual installation

```bash
git clone https://github.com/ViceversDev/worker-client.git
cd worker-client
npx wrangler login
npx wrangler secret put VICEVERS_SITE_KEY
npx wrangler deploy
```

After deployment, add the domain route from
**Cloudflare > Workers & Pages > vicevers-worker > Settings > Domains & Routes**.
Use the route shown on the Integration page in the Vicevers dashboard.

## Updates

This Worker intentionally contains no pricing, account, or content-generation
logic. Those decisions remain in the Vicevers API, so most service updates do
not require redeploying the Worker.

When a new Worker version is required, review the release and deploy it from
your Cloudflare account.

## Removal

If a Vicevers site is disabled, its site key stops resolving content and the
Worker continues serving the original website unchanged. To remove the
integration completely, delete its Cloudflare route and Worker deployment.

Learn more at [vicevers.dev](https://vicevers.dev).
