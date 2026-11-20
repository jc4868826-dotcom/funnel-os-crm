'use strict';
/* ============================================================
   Cata — búsqueda de stock sobre ERP RMG (normalización + difuso + LLM)
   Fuente única de verdad: ERP RMG. Sin web, sin datos estáticos.
   ============================================================ */

// Palabras de relleno: se descartan antes de comparar.
const RELLENO = new Set(['hola','buenas','buenos','dias','tardes','noches','gracias','porfa','favor',
'tengo','tienes','tiene','hay','queda','quedan','esta','estan','existe','existen','disponible',
'disponibles','stock','busco','buscaba','quiero','quisiera','necesito','interesa','interesaria',
'interesado','me','te','se','le','lo','la','el','los','las','un','una','unos','unas','de','del','al',
'para','por','con','sin','en','y','o','u','que','cual','cuales','cuanto','cuanta','cuesta','vale',
'valor','precio','pesos','plata','auto','autos','vehiculo','vehiculos','camioneta','camionetas',
'modelo','modelos','version','versiones','marca','ano','anno','year','km','kilometraje','kilometros',
'mil','info','informacion','mas','ver','saber','decir','consultar','puedes','podrias','podria',
'serian','seria','si','no','ok','aun','todavia','ese','esa','eso','este','esta','algo','alguno',
'alguna','tal','vez','buena','bueno','ustedes','uds','usted','ahi','aca','alla','favorcito']);

// Equivalencias de escritura hablada / fonética chilena.
const ALIAS = [
  [/\bequis\b/g, 'x'],
  [/\bdoble\s*cabina\b/g, 'dc'],
  [/\bautomatic[oa]\b/g, 'at'],
  [/\bmecanic[oa]\b/g, 'mt'],
  [/\bdiesel\b/g, 'dsl'],
  [/\bcuatro\s*por\s*cuatro\b/g, '4x4'],
  [/\bcuatro\s*por\s*dos\b/g, '4x2'],
];

/** Minúsculas, sin tildes, sin guiones/puntos/espacios, sin relleno. */
function normalizar(texto) {
  return tokenizar(texto).join('');
}

/** Igual que normalizar() pero devuelve los tokens útiles. */
function tokenizar(texto) {
  if (texto === null || texto === undefined) return [];
  let s = String(texto).toLowerCase();
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');   // tildes
  s = s.replace(/ñ/g, 'n');
  for (const [re, rep] of ALIAS) s = s.replace(re, rep);
  s = s.replace(/[^a-z0-9]+/g, ' ');                        // guiones, puntos, slashes, tabs
  return s.split(' ').filter(t => t && !RELLENO.has(t));
}

const esAnno = t => /^(19|20)\d{2}$/.test(t);

/* ---------------- Levenshtein ---------------- */
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
const tolerancia = len => (len <= 3 ? 0 : len <= 5 ? 1 : len <= 8 ? 2 : 3);

/** ¿aparece `aguja` dentro de `pajar` (compacto) aceptando errores de tipeo? */
function contieneDifuso(pajar, aguja) {
  if (aguja.length < 3) return false;
  if (pajar.includes(aguja)) return true;
  if (/^\d+$/.test(aguja)) return false;   // 3008 != 2008 != 5008: numéricos exactos
  const tol = tolerancia(aguja.length);
  if (!tol) return false;
  for (let L = aguja.length - tol; L <= aguja.length + tol; L++) {
    if (L < 3) continue;
    for (let i = 0; i + L <= pajar.length; i++) {
      if (lev(aguja, pajar.substr(i, L)) <= tol) return true;
    }
  }
  return false;
}

/* ---------------- Índice del stock ---------------- */
function indexar(stock) {
  return stock.map(v => {
    const tMarca = tokenizar(v.marca);
    const tModelo = tokenizar(v.modelo);
    const tVersion = tokenizar(v.version);
    return {
      v,
      tMarca, tModelo, tVersion,
      cMarca: tMarca.join(''),
      cModelo: tModelo.join(''),
      cVersion: tVersion.join(''),
      cTodo: normalizar(`${v.marca} ${v.modelo} ${v.version}`),
      anno: String(v.anno || ''),
    };
  });
}

function puntuar(ix, qTokens) {
  let marca = 0, modelo = 0, version = 0, anno = 0, annoChoque = false;
  for (const qt of qTokens) {
    if (esAnno(qt)) {
      if (qt === ix.anno) anno += 3; else annoChoque = true;
      continue;
    }
    if (qt.length < 2) continue;
    const numerico = /^\d+$/.test(qt);
    const ex = arr => arr.includes(qt);
    const fz = arr => !numerico && arr.some(t => t.length >= 3 && !/^\d+$/.test(t) &&
      lev(qt, t) <= tolerancia(Math.max(qt.length, t.length)));
    if (ex(ix.tModelo) || contieneDifuso(ix.cModelo, qt)) { modelo += 3; continue; }
    if (fz(ix.tModelo)) { modelo += 2; continue; }
    if (ex(ix.tVersion) || contieneDifuso(ix.cVersion, qt)) { version += 2; continue; }
    if (fz(ix.tVersion)) { version += 1; continue; }
    if (ex(ix.tMarca) || fz(ix.tMarca)) { marca += 2; continue; }
    // último recurso: la consulta pegada ("xtrail") contra todo el auto pegado
    if (contieneDifuso(ix.cTodo, qt)) { modelo += 2; }
  }
  return { marca, modelo, version, anno, annoChoque, total: marca + modelo + version + anno };
}

/* ---------------- Paso (a): normalizado + difuso ---------------- */
function matchDeterminista(mensaje, stock) {
  const qTokens = tokenizar(mensaje);
  if (!qTokens.length) return [];
  const qCompacto = qTokens.join('');
  const cand = [];
  for (const ix of indexar(stock)) {
    // patente escrita directa
    if (ix.v.patente && qCompacto.includes(normalizar(ix.v.patente))) {
      cand.push({ v: ix.v, score: 99 }); continue;
    }
    const s = puntuar(ix, qTokens);
    // exige señal de modelo/versión: la marca sola no basta para afirmar un auto
    if (s.modelo === 0 && s.version === 0) continue;
    if (s.annoChoque && s.anno === 0 && s.modelo < 3) continue;
    cand.push({ v: ix.v, score: s.total, detalle: s });
  }
  cand.sort((a, b) => b.score - a.score);
  const top = cand.length ? cand[0].score : 0;
  return cand.filter(c => c.score >= Math.max(3, top - 2)).map(c => c.v);
}

/* ---------------- Paso (b): LLM sobre el stock completo ---------------- */
function fichaParaLLM(v) {
  return {
    patente: v.patente,
    marca: String(v.marca || '').trim(),
    modelo: String(v.modelo || '').trim(),
    version: String(v.version || '').trim(),
    anno: v.anno,
    km: v.kilometraje,
    color: v.color,
    precio_clp: v.ventaiva,
  };
}

const PROMPT_MATCH = `Eres el buscador de stock de una automotora chilena.
Recibes el mensaje de un cliente y la lista COMPLETA de autos DISPONIBLES.
Identifica qué auto o autos de la lista pide el cliente, aunque lo escriba mal,
abreviado, fonéticamente o con otro nombre comercial.
Responde SOLO JSON: {"patentes":["AAAA11"],"razon":"breve"}
Si de verdad ninguno corresponde, responde {"patentes":[],"razon":"breve"}.
No inventes autos que no estén en la lista.`;

/**
 * @param {string} mensaje
 * @param {Array} stock  autos DISPONIBLES del ERP
 * @param {object} opts  { llm: async ({system,user}) => string, log: fn }
 */
async function buscarStock(mensaje, stock, opts = {}) {
  const log = opts.log || console.log;
  const disponibles = stock.filter(v => String(v.estadostock || '').toUpperCase() === 'DISPONIBLE');

  const paso1 = matchDeterminista(mensaje, disponibles);
  if (paso1.length) return { autos: paso1, via: 'determinista' };

  if (typeof opts.llm !== 'function') return { autos: [], via: 'sin_llm' };

  let patentes = [];
  try {
    const raw = await opts.llm({
      system: PROMPT_MATCH,
      user: JSON.stringify({ mensaje, stock_disponible: disponibles.map(fichaParaLLM) }),
    });
    const j = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
    patentes = Array.isArray(j.patentes) ? j.patentes : [];
    var razon = j.razon || '';
  } catch (e) {
    log(`[CATA-STOCK-LLM-ERROR] ${e.message} | msg="${mensaje}"`);
    return { autos: [], via: 'llm_error' };
  }

  const set = new Set(patentes.map(p => normalizar(p)));
  const autos = disponibles.filter(v => set.has(normalizar(v.patente)));

  if (autos.length) {
    // (5) log de variante nueva: el paso difuso no la encontró, el LLM sí
    log(`[CATA-STOCK-VARIANTE] msg="${mensaje}" norm="${normalizar(mensaje)}" ` +
        `resuelto_por=LLM patentes=${autos.map(a => a.patente).join(',')} razon="${razon}"`);
    return { autos, via: 'llm' };
  }
  log(`[CATA-STOCK-SIN-MATCH] msg="${mensaje}" norm="${normalizar(mensaje)}" razon="${razon}"`);
  return { autos: [], via: 'ninguno' };
}

/* ---------------- Respuesta con datos reales del ERP ---------------- */
const clp = n => '$' + Number(n || 0).toLocaleString('es-CL');
const miles = n => Number(n || 0).toLocaleString('es-CL');

function fichaTexto(v) {
  const mk = String(v.marca || '').trim();
  const md = String(v.modelo || '').trim();
  const vr = String(v.version || '').trim().replace(/\s+/g, ' ');
  return `*${mk} ${md} ${v.anno}*${vr ? `\n${vr}` : ''}\n${miles(v.kilometraje)} km · ${String(v.color || '').trim()}\n${clp(v.ventaiva)}`;
}

function respuestaStock(autos) {
  if (!autos.length) return null;
  if (autos.length === 1) return `Sí, lo tenemos 👇\n\n${fichaTexto(autos[0])}`;
  return `Sí, tenemos ${autos.length} opciones 👇\n\n` + autos.map(fichaTexto).join('\n\n');
}

module.exports = { normalizar, tokenizar, lev, contieneDifuso, matchDeterminista, buscarStock, respuestaStock, fichaTexto, fichaParaLLM, PROMPT_MATCH };
