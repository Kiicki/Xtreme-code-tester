// Cloudflare Worker: HTTPS-proxy for IPTV Server Tester
//
// Deploy:
//   1. Logg inn på https://dash.cloudflare.com
//   2. Workers & Pages -> Create -> Create Worker
//   3. Gi den et navn (f.eks. "iptv-tester-proxy") og klikk Deploy
//   4. Klikk "Edit code", lim inn HELE denne filen, klikk "Deploy"
//   5. Kopier URL-en (f.eks. https://iptv-tester-proxy.<dittnavn>.workers.dev)
//   6. Lim den inn i index.html som verdien til PROXY

export default {
  async fetch(request) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
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
        headers: { 'User-Agent': 'Mozilla/5.0 IPTV-Tester' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });

      const headers = new Headers(upstream.headers);
      for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
      headers.set('X-Proxy-Status', 'ok');
      headers.delete('content-encoding');
      headers.delete('content-length');

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
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
