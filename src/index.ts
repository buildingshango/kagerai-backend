const SERVICE_NAME = "kagerai-stream-proxy";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type"
};

interface Env {
  STREAM_RESOLVER_URL?: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    }
  });
}

function withCors(headers: Headers): Headers {
  const responseHeaders = new Headers(headers);

  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(name, value);
  }

  return responseHeaders;
}

function proxyUrl(requestUrl: URL, mediaUrl: URL, referer: string): string {
  const url = new URL("/proxy", requestUrl.origin);
  url.searchParams.set("url", mediaUrl.toString());
  url.searchParams.set("referer", referer);
  return url.toString();
}

function rewritePlaylist(playlist: string, playlistUrl: URL, requestUrl: URL, referer: string): string {
  const rewrite = (value: string): string => {
    const mediaUrl = new URL(value, playlistUrl);
    return proxyUrl(requestUrl, mediaUrl, referer);
  };

  return playlist
    .split("\n")
    .map((line) => {
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) =>
          `URI="${rewrite(uri)}"`
        );
      }

      return rewrite(trimmedLine);
    })
    .join("\n");
}

function isPlaylist(response: Response, mediaUrl: URL): boolean {
  const contentType = response.headers.get("Content-Type") || "";
  return mediaUrl.pathname.toLowerCase().endsWith(".m3u8") ||
    contentType.toLowerCase().includes("mpegurl") ||
    contentType.toLowerCase().includes("vnd.apple.mpegurl");
}

async function resolveStream(
  requestUrl: URL,
  env: Env,
  type: string,
  id: string,
  season: string | null,
  episode: string | null
): Promise<string | null> {
  const directUrl = requestUrl.searchParams.get("url");

  if (directUrl) {
    return directUrl;
  }

  try {
    const idUrl = new URL(id);
    if (["http:", "https:"].includes(idUrl.protocol)) {
      return idUrl.toString();
    }
  } catch {
    // IDs are resolved through the configured resolver below.
  }

  if (!env.STREAM_RESOLVER_URL) {
    return null;
  }

  const resolverUrl = new URL(env.STREAM_RESOLVER_URL);
  resolverUrl.searchParams.set("type", type);
  resolverUrl.searchParams.set("id", id);
  if (season) resolverUrl.searchParams.set("season", season);
  if (episode) resolverUrl.searchParams.set("episode", episode);

  const response = await fetch(resolverUrl);
  if (!response.ok) {
    return null;
  }

  const payload = await response.json() as { url?: unknown };
  return typeof payload.url === "string" ? payload.url : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (requestUrl.pathname === "/health") {
      return jsonResponse({ status: "ok", service: SERVICE_NAME });
    }

    if (requestUrl.pathname === "/stream") {
      const type = requestUrl.searchParams.get("type");
      const id = requestUrl.searchParams.get("id");
      const season = requestUrl.searchParams.get("season");
      const episode = requestUrl.searchParams.get("episode");

      if (!type || !id || !["movie", "tv", "anime"].includes(type)) {
        return jsonResponse(
          { error: "type must be movie, tv, or anime, and id is required" },
          400
        );
      }

      try {
        const streamUrl = await resolveStream(
          requestUrl,
          env,
          type,
          id,
          season,
          episode
        );

        if (!streamUrl) {
          return jsonResponse(
            { error: "No stream source configured for this request" },
            404
          );
        }

        return jsonResponse({ url: streamUrl, status: "success" });
      } catch {
        return jsonResponse({ error: "Unable to resolve stream source" }, 502);
      }
    }

    if (requestUrl.pathname !== "/proxy") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    const targetUrl = requestUrl.searchParams.get("url");
    const targetReferer = requestUrl.searchParams.get("referer");

    if (!targetUrl) {
      return jsonResponse({ error: "url query parameter is required" }, 400);
    }

    let mediaUrl: URL;
    let refererUrl: URL | null = null;

    try {
      mediaUrl = new URL(targetUrl);
      if (targetReferer) {
        refererUrl = new URL(targetReferer);
      }
    } catch {
      return jsonResponse({ error: "url and referer must be valid URLs" }, 400);
    }

    if (![
      "http:",
      "https:"
    ].includes(mediaUrl.protocol) || (refererUrl && !["http:", "https:"].includes(refererUrl.protocol))) {
      return jsonResponse({ error: "url and referer must use HTTP or HTTPS" }, 400);
    }

    const referer = refererUrl?.toString() || `${mediaUrl.origin}/`;

    try {
      const upstreamResponse = await fetch(mediaUrl, {
        headers: {
          Referer: referer,
          Origin: new URL(referer).origin,
          "User-Agent": request.headers.get("User-Agent") ||
            "Mozilla/5.0 (compatible; KageraiStreamProxy/1.0)",
          ...(request.headers.get("Range")
            ? { Range: request.headers.get("Range") as string }
            : {})
        }
      });

      if (isPlaylist(upstreamResponse, mediaUrl)) {
        const playlist = await upstreamResponse.text();
        const headers = withCors(upstreamResponse.headers);
        headers.set("Content-Type", "application/vnd.apple.mpegurl");

        return new Response(
          rewritePlaylist(playlist, mediaUrl, requestUrl, referer),
          {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers
          }
        );
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: withCors(upstreamResponse.headers)
      });
    } catch {
      return jsonResponse({ error: "Unable to fetch the upstream media" }, 502);
    }
  }
};