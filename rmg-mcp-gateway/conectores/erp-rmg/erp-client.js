import fs from 'node:fs';
import crypto from 'node:crypto';

const cfg = JSON.parse(fs.readFileSync(new URL('./erp-config.json', import.meta.url), 'utf8'));

// Las variables de entorno ERP_BASE_URL / ERP_LOGIN_URL permiten apuntar a un servidor de pruebas.
const BASE_URL = process.env.ERP_BASE_URL || cfg.baseUrl;
const LOGIN_URL = process.env.ERP_LOGIN_URL || cfg.login.url;

let session = { token: null, cookies: [], prefix: null };

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// Reemplaza {{USER}}, {{PASS}} y {{PASS_MD5}} en cualquier string del cuerpo de login.
const fill = (v) => {
  if (typeof v === 'string') {
    return v
      .replaceAll('{{USER}}', process.env.ERP_USER)
      .replaceAll('{{PASS_MD5}}', md5(process.env.ERP_PASS))
      .replaceAll('{{PASS}}', process.env.ERP_PASS);
  }
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
};

const TOKEN_CANDIDATOS = [
  'token', 'jwt', 'access_token', 'accessToken',
  'data.token', 'data.jwt', 'data.access_token', 'data.accessToken', 'result.token',
];

function buscarToken(json, tokenPath) {
  if (tokenPath && tokenPath !== 'auto') {
    const t = getPath(json, tokenPath);
    if (typeof t === 'string' && t) return t;
  }
  for (const c of TOKEN_CANDIDATOS) {
    const t = getPath(json, c);
    if (typeof t === 'string' && t.length > 20) return t;
  }
  return null;
}

async function login() {
  if (!process.env.ERP_USER || !process.env.ERP_PASS) {
    throw new Error('Faltan las variables ERP_USER y ERP_PASS');
  }
  const l = cfg.login;
  if (l.body && '__PEGAR_AQUI__' in l.body) {
    throw new Error('Falta completar login.body en erp-config.json (ver README, paso 2)');
  }
  const res = await fetch(LOGIN_URL, {
    method: l.method || 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(fill(l.body)),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Login: la respuesta no es JSON (HTTP ${res.status})`);
  }
  const token = buscarToken(json, l.tokenPath);
  if (!res.ok || !token) {
    // Solo nombres de campos y el mensaje del ERP: nunca valores sensibles.
    const campos = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    const msg = typeof json?.message === 'string' ? ` Mensaje del ERP: ${json.message.slice(0, 120)}.` : '';
    throw new Error(`Login fallido (HTTP ${res.status}). Campos de la respuesta: ${campos}.${msg}`);
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  session = { token, cookies: setCookies.map((c) => c.split(';')[0]), prefix: null };
}

// Acciones de lectura que no empiezan con "get" (verificadas en el ERP).
const LECTURA_EXTRA = new Set(['notaventa.estadoresultado']);

export const esLectura = (destino, accion) =>
  /^get\w*$/i.test(accion) || LECTURA_EXTRA.has(`${destino}.${accion}`);

/**
 * Llama a una acción de LECTURA del ERP.
 * Solo se permiten acciones "get*" y las de LECTURA_EXTRA: la escritura queda bloqueada en esta versión.
 */
export async function call(destino, accion, dataForm = {}, extra = {}) {
  if (!/^\w+$/.test(destino)) throw new Error('destino inválido');
  if (!esLectura(destino, accion)) throw new Error('Solo se permiten acciones de lectura en esta versión');
  const json = await peticion(destino, accion, dataForm, extra);
  if (json === null) return [];
  return json.data;
}

// Única lista de escrituras permitidas. Cualquier otra acción de escritura queda bloqueada.
export const ESCRITURAS_PERMITIDAS = new Set(['gastosingresos.add']);

/** Escribe en el ERP: solo acciones de ESCRITURAS_PERMITIDAS. Devuelve el JSON completo del ERP. */
export async function escribir(destino, accion, dataForm = {}, extra = {}) {
  if (!ESCRITURAS_PERMITIDAS.has(`${destino}.${accion}`)) throw new Error(`Escritura no permitida: ${destino}.${accion}`);
  return peticion(destino, accion, dataForm, extra);
}

async function peticion(destino, accion, dataForm, extra) {
  let fallos = 0;
  while (true) {
    if (!session.token) await login();

    // Primero con el prefijo configurado (Bearer); si el ERP lo rechaza, prueba el token sin prefijo.
    const prefix = session.prefix ?? (cfg.login.authHeaderPrefix ?? 'Bearer ');
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: prefix + session.token,
    };
    if (session.cookies.length) headers.Cookie = session.cookies.join('; ');

    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ destino, accion, dataForm, id: '', id2: '', estado: 'T', estado2: 'T', ...extra }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* se maneja abajo */
    }

    const authFail =
      res.status === 401 ||
      res.status === 403 ||
      (json && json.estado === 'NOK' && /token|sesi[oó]n|autoriz|expir/i.test(json.message || '')) ||
      (json && /access denied|acceso denegado|login failed|no autorizado/i.test(json.message || ''));

    if (authFail) {
      fallos++;
      if (fallos === 1 && prefix !== '') {
        session.prefix = ''; // reintenta con el mismo token, sin "Bearer "
        continue;
      }
      if (fallos <= 2) {
        session = { token: null, cookies: [], prefix: null }; // login nuevo
        continue;
      }
      throw new Error('No autorizado: revisar usuario y permisos del ERP');
    }

    if (!json) throw new Error(`Respuesta del ERP no es JSON (HTTP ${res.status})`);

    if (json.estado === 'NOK') {
      const msg = json.message || 'Error del ERP';
      if (/no se encontraron/i.test(msg)) return null; // lista vacía, no es error
      throw new Error(msg);
    }
    return json;
  }
}
