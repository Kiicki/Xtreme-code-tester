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
      'Access-Control-Expose-Headers': 'X-Proxy-Status, X-Portal-Status, X-Upstream-Status',
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

    const mode = reqUrl.searchParams.get('mode') || 'http';

    if (mode === 'xtream') {
      const username = reqUrl.searchParams.get('username') || targetUrl.searchParams.get('username');
      const password = reqUrl.searchParams.get('password') || targetUrl.searchParams.get('password');

      if (!username || !password) {
        return json(
          { error: 'Xtream mode requires username and password' },
          400,
          { ...corsHeaders, 'X-Proxy-Status': 'error', 'X-Portal-Status': 'missing-credentials' }
        );
      }

      return checkXtreamPortal(targetUrl, username, password, corsHeaders);
    }

    return checkHttpTarget(targetUrl, corsHeaders);
  },
};

async function checkHttpTarget(targetUrl, corsHeaders) {
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
      headers: {
        ...corsHeaders,
        'X-Proxy-Status': 'ok',
        'X-Upstream-Status': String(upstream.status),
      },
    });
  } catch (e) {
    return json(
      { error: e.name === 'TimeoutError' ? 'Upstream timeout' : 'Upstream unreachable' },
      502,
      { ...corsHeaders, 'X-Proxy-Status': 'error' }
    );
  }
}

async function checkXtreamPortal(targetUrl, username, password, corsHeaders) {
  const apiUrl = buildXtreamApiUrl(targetUrl, username, password);

  try {
    const upstream = await fetchSameHost(apiUrl, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 IPTV-Tester',
      },
      signal: AbortSignal.timeout(15000),
    });

    const baseHeaders = {
      ...corsHeaders,
      'X-Proxy-Status': 'ok',
      'X-Upstream-Status': String(upstream.status),
    };

    if (!upstream.ok) {
      if (upstream.body) {
        try { await upstream.body.cancel(); } catch {}
      }
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: { ...baseHeaders, 'X-Portal-Status': 'http-error' },
      });
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      if (upstream.body) {
        try { await upstream.body.cancel(); } catch {}
      }
      return json(
        { error: 'Portal did not return Xtream JSON' },
        502,
        { ...baseHeaders, 'X-Portal-Status': 'bad-response' }
      );
    }

    const portalStatus = getXtreamPortalStatus(payload);
    if (portalStatus !== 'ok') {
      const status = portalStatus === 'invalid-auth' ? 401 : 403;
      return new Response(null, {
        status,
        headers: { ...baseHeaders, 'X-Portal-Status': portalStatus },
      });
    }

    const categoriesUrl = new URL(apiUrl.toString());
    categoriesUrl.searchParams.set('action', 'get_live_categories');
    const categories = await fetchSameHost(categoriesUrl, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 IPTV-Tester',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!categories.ok) {
      if (categories.body) {
        try { await categories.body.cancel(); } catch {}
      }
      return new Response(null, {
        status: categories.status,
        statusText: categories.statusText,
        headers: {
          ...baseHeaders,
          'X-Upstream-Status': String(categories.status),
          'X-Portal-Status': 'categories-error',
        },
      });
    }

    if (!await isJsonArrayResponse(categories)) {
      return json(
        { error: 'Portal did not return live categories' },
        502,
        { ...baseHeaders, 'X-Portal-Status': 'categories-error' }
      );
    }

    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, 'X-Portal-Status': 'ok' },
    });
  } catch (e) {
    const portalStatus = e.message === 'Cross-host redirect' ? 'redirected' : 'unreachable';
    return json(
      { error: e.name === 'TimeoutError' ? 'Upstream timeout' : 'Upstream unreachable' },
      502,
      { ...corsHeaders, 'X-Proxy-Status': 'error', 'X-Portal-Status': portalStatus }
    );
  }
}

async function fetchSameHost(url, init, redirects = 0) {
  const response = await fetch(url.toString(), {
    method: 'GET',
    ...init,
    redirect: 'manual',
  });

  if (![301, 302, 303, 307, 308].includes(response.status)) {
    return response;
  }

  if (redirects >= 3) {
    throw new Error('Too many redirects');
  }

  const location = response.headers.get('Location');
  if (!location) {
    return response;
  }

  if (response.body) {
    try { await response.body.cancel(); } catch {}
  }

  const next = new URL(location, url);
  if (next.hostname !== url.hostname) {
    throw new Error('Cross-host redirect');
  }

  return fetchSameHost(next, init, redirects + 1);
}

function buildXtreamApiUrl(targetUrl, username, password) {
  const base = new URL(targetUrl.toString());
  base.search = '';
  base.hash = '';

  if (/\/(?:get|player_api|xmltv)\.php$/i.test(base.pathname)) {
    const directory = new URL('.', base);
    base.pathname = directory.pathname;
  } else if (!base.pathname.endsWith('/')) {
    base.pathname += '/';
  }

  const apiUrl = new URL('player_api.php', base);
  apiUrl.searchParams.set('username', username);
  apiUrl.searchParams.set('password', password);
  return apiUrl;
}

function getXtreamPortalStatus(payload) {
  const info = payload && typeof payload === 'object' ? payload.user_info : null;
  if (!info || typeof info !== 'object') return 'bad-response';

  const authed = info.auth === 1 || info.auth === '1' || info.auth === true;
  if (!authed) return 'invalid-auth';

  const status = String(info.status || '').trim().toLowerCase();
  if (status && status !== 'active') return 'inactive';

  return 'ok';
}

async function isJsonArrayResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    if (response.body) {
      try { await response.body.cancel(); } catch {}
    }
    return false;
  }

  return Array.isArray(payload);
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
