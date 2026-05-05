// Cloudflare Worker: HTTPS proxy for the Pulse IPTV Tester
//
// Deploy:
//   1. Sign in at https://dash.cloudflare.com
//   2. Workers & Pages -> Create -> Create Worker
//   3. Name it (e.g. "iptv-tester-proxy") and click Deploy
//   4. Click "Edit code", replace the contents with this entire file, click Deploy
//   5. Copy the URL (e.g. https://iptv-tester-proxy.<your-name>.workers.dev)
//   6. Paste it into index.html as the value of PROXY

// Origins allowed to use this proxy. Browsers send the Origin header on
// cross-origin fetches; if it isn't in this list we reject. Requests with no
// Origin (curl, direct browser navigation) are allowed for debugging.
const ALLOWED_ORIGINS = new Set([
  'https://kiicki.github.io',
  'null',          // file:// in some browsers
]);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow any localhost / 127.0.0.1 port for local development.
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');

    if (!isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': origin || '*',
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'X-Proxy-Status',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');

    if (!target) {
      return json({ error: 'Missing url parameter' }, 400, corsHeaders);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return json({ error: 'Invalid URL' }, 400, corsHeaders);
    }

    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      return json({ error: 'Only HTTP and HTTPS are allowed' }, 400, corsHeaders);
    }

    try {
      const upstream = await fetch(targetUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 IPTV-Tester',
          // Ask for one byte so servers that honor Range avoid sending full body.
          'Range': 'bytes=0-0',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });

      // The client only needs the status. Discard the body to avoid spending
      // bandwidth and CPU streaming response payloads through the worker.
      if (upstream.body) {
        try { await upstream.body.cancel(); } catch {}
      }

      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: { ...corsHeaders, 'X-Proxy-Status': 'ok' },
      });
    } catch (e) {
      return json(
        { error: e.name === 'TimeoutError' ? 'Upstream timeout' : 'Upstream unreachable' },
        502,
        { ...corsHeaders, 'X-Proxy-Status': 'error' }
      );
    }
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
