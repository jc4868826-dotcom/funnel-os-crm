// Cliente de solo lectura hacia la API de FunnelOS por loopback (127.0.0.1:PORT).
// Inicia sesión con un usuario dedicado y reintenta una vez si el token expiró
// (las sesiones de FunnelOS viven en memoria y se pierden al reiniciar Render).
let token = null;

const base = () => `http://127.0.0.1:${process.env.PORT || 3000}`;

async function login() {
  const r = await fetch(`${base()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.FUNNEL_MCP_USER,
      password: process.env.FUNNEL_MCP_PASS,
      tenant: process.env.FUNNEL_MCP_TENANT || undefined,
    }),
  });
  if (!r.ok) throw new Error(`Login FunnelOS falló (${r.status})`);
  token = (await r.json()).token;
}

// Solo GET: este conector nunca escribe en FunnelOS.
export async function get(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${base()}${path}${qs ? `?${qs}` : ''}`;
  for (let intento = 0; intento < 2; intento++) {
    if (!token) await login();
    const r = await fetch(url, { headers: { 'X-Auth-Token': token } });
    if (r.status === 401 && intento === 0) {
      token = null;
      continue;
    }
    if (!r.ok) throw new Error(`FunnelOS ${path} respondió ${r.status}`);
    return r.json();
  }
  throw new Error('No se pudo autenticar en FunnelOS');
}
