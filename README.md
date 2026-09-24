# Kagerai Stream Proxy

Lightweight Cloudflare Worker for proxying HLS playlists and video segments.
The proxy adds the upstream request headers needed by locked-down media CDNs
and returns permissive CORS headers for the Kagerai client.

## Requirements

- Node.js 18+
- npm
- A Cloudflare account for deployment

## Local development

```sh
npm install
npm run dev
```

The Worker is available at `http://localhost:8787` by default.

Health check:

```sh
curl http://localhost:8787/health
```

Proxy a playlist or segment:

```text
http://localhost:8787/proxy?url=https%3A%2F%2Fcdn.example.com%2Fmaster.m3u8&referer=https%3A%2F%2Fexample.com%2F
```

Both query parameters must be URL-encoded. The proxy supports `GET` and
browser CORS preflight `OPTIONS` requests.

Resolve a stream:

```text
http://localhost:8787/stream?type=anime&id=https%3A%2F%2Fcdn.example.com%2Fmaster.m3u8
```

`type` accepts `movie`, `tv`, or `anime`. A URL-valued `id` (or an explicit
`url` parameter) is returned directly. Numeric IDs require an upstream
resolver configured with the `STREAM_RESOLVER_URL` Worker variable. That
resolver receives the same `type`, `id`, `season`, and `episode` parameters
and must return JSON containing a string `url` property.

## Deployment

Authenticate Wrangler once, then deploy:

```sh
npx wrangler login
npm run deploy
```

Update `name` in `wrangler.jsonc` before deploying if this Worker name is
already used in your Cloudflare account.