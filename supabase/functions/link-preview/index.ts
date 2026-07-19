import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_HTML_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 8_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const normalized = ip.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  const parts = ip.split(".").map(Number);

  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS links are supported.");
  }

  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local network links are not supported.");
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Private network links are not supported.");
    }
    return;
  }

  const addresses = await Deno.resolveDns(hostname, "A").catch(
    () => [] as string[],
  );
  const ipv6Addresses = await Deno.resolveDns(hostname, "AAAA").catch(
    () => [] as string[],
  );

  if (
    [...addresses, ...ipv6Addresses].some(isPrivateIp)
  ) {
    throw new Error("Private network links are not supported.");
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code))
    )
    .replace(/\s+/g, " ")
    .trim();
}

function readMeta(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
        "i",
      ),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return decodeHtml(match[1]);
      }
    }
  }

  return null;
}

function readTitle(html: string): string | null {
  const metaTitle = readMeta(html, [
    "og:title",
    "twitter:title",
  ]);

  if (metaTitle) {
    return metaTitle;
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch?.[1]
    ? decodeHtml(titleMatch[1])
    : null;
}

async function fetchHtml(initialUrl: URL): Promise<{
  html: string;
  finalUrl: URL;
}> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    await assertPublicUrl(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );

    let response: Response;

    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; GlobalQallLinkPreview/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("The link returned an invalid redirect.");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new Error(`The page returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error("The link does not point to an HTML page.");
    }

    const contentLength = Number(
      response.headers.get("content-length") ?? 0,
    );
    if (contentLength > MAX_HTML_BYTES) {
      throw new Error("The page is too large to preview.");
    }

    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    return { html, finalUrl: currentUrl };
  }

  throw new Error("Too many redirects.");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await request.json();
    const input = typeof body?.url === "string" ? body.url.trim() : "";

    if (!input || input.length > 2048) {
      return json({ error: "A valid URL is required." }, 400);
    }

    const requestedUrl = new URL(input);
    const { html, finalUrl } = await fetchHtml(requestedUrl);

    const title = readTitle(html);
    if (!title) {
      return json({ error: "No preview metadata was found." }, 422);
    }

    const description = readMeta(html, [
      "og:description",
      "twitter:description",
      "description",
    ]);
    const siteName = readMeta(html, ["og:site_name"]);
    const image = readMeta(html, [
      "og:image:secure_url",
      "og:image",
      "twitter:image",
      "twitter:image:src",
    ]);

    let imageUrl: string | null = null;
    if (image) {
      try {
        const resolvedImage = new URL(image, finalUrl);
        if (["http:", "https:"].includes(resolvedImage.protocol)) {
          imageUrl = resolvedImage.toString();
        }
      } catch {
        imageUrl = null;
      }
    }

    return json({
      url: finalUrl.toString(),
      title: title.slice(0, 300),
      description: description?.slice(0, 600) ?? null,
      imageUrl,
      siteName:
        siteName?.slice(0, 200) ??
        finalUrl.hostname.replace(/^www\./i, ""),
    });
  } catch (error) {
    console.error("link-preview error", error);
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not create a preview.",
      },
      400,
    );
  }
});
