#!/usr/bin/env node
// Conector MCP: Claude <-> ERP RMG Parts (v0.2, nov 2026)
// v0.2: + crear cliente, + crear OC (borrador, ligada a nota de venta), + factura de compra contra una OC, + pago de OC.
//       + autorizar nota de venta (administrador), + recepción de OC, + avanzar OC.
//       Las autorizaciones de OC y de pago siguen siendo solo del gerente en el ERP.
// Transporte stdio (Claude Desktop local). Sin dependencias del ERP: solo HTTP.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Generado por herramientas/envolver.mjs desde:
//   /mnt/user-data/uploads/erp-parts-mcp/server.js
// Única diferencia con el conector local: se quitó el transporte stdio y el
// cuerpo quedó dentro de createServer(). La lógica y las herramientas son
// idénticas — no editar a mano, regenerar con el script.
// ─────────────────────────────────────────────────────────────────────────────
export function createServer() {

const BASE = (process.env.PARTS_URL || 'https://rmg-parts-erp.onrender.com').replace(/\/$/, '');
const USER = process.env.PARTS_USER;
const PASS = process.env.PARTS_PASS;
const TIMEOUT_MS = 60000; // Render puede estar dormido: la 1ª llamada tarda
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BITACORA = path.join(HERE, 'bitacora_escrituras.jsonl');

// ───────────── Cliente HTTP ─────────────
let token = null;

async function http(method, url, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + url, {
      method, headers, signal: ctl.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  } finally { clearTimeout(t); }
}

async function login() {
  if (!USER || !PASS) throw new Error('Faltan PARTS_USER / PARTS_PASS en la config del conector.');
  const r = await http('POST', '/api/auth/login', { email: USER, password: PASS }, false);
  if (r.status !== 200 || !r.data?.token) {
    throw new Error(`Login falló (${r.status}): ${r.data?.error || JSON.stringify(r.data)}`);
  }
  token = r.data.token;
}

// Guardia de seguridad: lectura libre (GET /api/...) y lista blanca de escritura.
const WRITE_ALLOW = [
  { method: 'POST', re: /^\/api\/flujo-caja\/manual$/ },
  { method: 'POST', re: /^\/api\/cotizaciones$/ },
  { method: 'POST', re: /^\/api\/oc$/ },                    // crear OC suelta (nace en borrador)
  { method: 'POST', re: /^\/api\/oc\/desde-pedido\/[^/]+$/ }, // crear OC ligada a una nota de venta autorizada
  { method: 'POST', re: /^\/api\/clientes$/ },               // crear cliente
  { method: 'POST', re: /^\/api\/pedidos\/[^/]+\/autorizar$/ }, // autorizar nota de venta (rol administrador, lo valida el ERP)
  { method: 'POST', re: /^\/api\/oc\/[^/]+\/recepcion$/ },      // recepción de mercadería
  { method: 'POST', re: /^\/api\/oc\/[^/]+\/factura$/ },    // factura de compra contra una OC recibida
  { method: 'PATCH', re: /^\/api\/oc\/[^/]+\/estado$/ },    // solo se usa para pasar a 'pagada' (ver parts_registrar_pago_oc)
];

async function erp(method, url, body) {
  if (!url.startsWith('/api/')) throw new Error('Ruta no permitida');
  if (method !== 'GET' && !WRITE_ALLOW.some(w => w.method === method && w.re.test(url))) {
    throw new Error(`Escritura bloqueada por el conector: ${method} ${url}`);
  }
  if (!token) await login();
  const run = async () => {
    let r = await http(method, url, body);
    if (r.status === 401) { await login(); r = await http(method, url, body); }
    return r;
  };
  let r;
  try { r = await run(); }
  catch (e) {
    // Reintento único (servidor dormido / corte de red). Solo para lecturas.
    if (method !== 'GET') throw e;
    r = await run();
  }
  if (r.status >= 400) throw new Error(`ERP ${r.status}: ${r.data?.error || JSON.stringify(r.data)}`);
  return r.data;
}

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const rowsOf = (d) => Array.isArray(d) ? d : (d?.data || d?.items || d?.rows || d?.movimientos || null);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] });
const safe = (fn) => async (args) => { try { return ok(await fn(args || {})); } catch (e) { return fail(e); } };

// Recorta listas grandes y avisa el total real.
function lista(d, { q, campos, limite = 50 } = {}) {
  let rows = rowsOf(d);
  if (!rows) return d;
  if (q) {
    const n = norm(q);
    rows = rows.filter(r => (campos || Object.keys(r)).some(k => norm(r[k]).includes(n)));
  }
  return { total: rows.length, mostrando: Math.min(limite, rows.length), filas: rows.slice(0, limite) };
}

function bitacora(entry) {
  try { fs.appendFileSync(BITACORA, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* no bloquea */ }
}

// ───────────── Servidor MCP ─────────────
const server = new McpServer({ name: 'erp-parts', version: '0.1.0' });
const L = z.number().int().min(1).max(200).default(50).describe('Máximo de filas (1-200)');

// ——— Lectura ———
server.tool('parts_lista_precios',
  'Lista de precios maestra de RMG Parts (SKU, descripción, marca, costo, precio neto sin IVA). Filtra por texto.',
  { q: z.string().optional().describe('Texto a buscar en código/descripción/marca'), limite: L },
  safe(async ({ q, limite }) => lista(await erp('GET', '/api/lista-precios'), { q, limite, campos: ['codigo_sku', 'codigo', 'descripcion', 'marca', 'categoria', 'proveedor'] })));

server.tool('parts_stock',
  'Stock actual por SKU en bodega (cantidades, costo y precio neto).',
  { q: z.string().optional(), limite: L },
  safe(async ({ q, limite }) => lista(await erp('GET', '/api/inventario/stock'), { q, limite, campos: ['codigo', 'descripcion', 'marca', 'categoria', 'proveedor'] })));

server.tool('parts_alertas_stock',
  'Alertas de inventario (quiebres / bajo mínimo).',
  {}, safe(async () => erp('GET', '/api/inventario/alertas')));

server.tool('parts_movimientos_bodega',
  'Movimientos de bodega (ingresos por OC, salidas por venta, ajustes).',
  { limite: L }, safe(async ({ limite }) => lista(await erp('GET', '/api/bodega/movimientos'), { limite })));

server.tool('parts_cotizaciones',
  'Lista cotizaciones. Estados típicos: borrador, aprobada. Con id/número devuelve el detalle con ítems.',
  { estado: z.string().optional(), id_o_numero: z.string().optional().describe('Ej: COT-2026-014'), q: z.string().optional(), limite: L },
  safe(async ({ estado, id_o_numero, q, limite }) => {
    if (id_o_numero) return erp('GET', `/api/cotizaciones/${encodeURIComponent(id_o_numero)}`);
    return lista(await erp('GET', '/api/cotizaciones' + qs({ estado })), { q, limite, campos: ['numero', 'cliente', 'cliente_rut', 'estado'] });
  }));

server.tool('parts_ventas',
  'Ventas (notas de venta). Filtra por mes YYYY-MM, estado logístico o cliente. Con id devuelve el detalle.',
  { id: z.string().optional(), mes: z.string().optional().describe('YYYY-MM'), estado_logistico: z.string().optional(), cliente_id: z.string().optional(), limite: L },
  safe(async ({ id, mes, estado_logistico, cliente_id, limite }) => {
    if (id) return erp('GET', `/api/ventas/${encodeURIComponent(id)}`);
    return lista(await erp('GET', '/api/ventas' + qs({ mes, estado_logistico, cliente_id })), { limite });
  }));

server.tool('parts_flujo_caja',
  'Movimientos de caja. Usa mes (YYYY-MM) o fecha_inicio/fecha_fin (YYYY-MM-DD). Sin filtros: mes actual. Incluye reales y proyectados.',
  { mes: z.string().optional(), fecha_inicio: z.string().optional(), fecha_fin: z.string().optional(), q: z.string().optional(), limite: L },
  safe(async ({ mes, fecha_inicio, fecha_fin, q, limite }) =>
    lista(await erp('GET', '/api/flujo-caja' + qs({ mes, fecha_inicio, fecha_fin })), { q, limite, campos: ['descripcion', 'categoria', 'tipo', 'estado', 'cuenta_bancaria'] })));

server.tool('parts_caja_resumen',
  'Saldo actual de caja (solo confirmado) e ingresos/egresos proyectados a 30 días.',
  {}, safe(async () => erp('GET', '/api/flujo-caja/resumen')));

server.tool('parts_estado_resultado',
  'Estado de resultados del mes: ingresos, costo, margen, gastos fijos/variables, resultado operacional, CxC y CxP.',
  { mes: z.string().describe('YYYY-MM') }, safe(async ({ mes }) => erp('GET', '/api/edr' + qs({ mes }))));

server.tool('parts_cuentas_por_cobrar',
  'CxC: facturas pendientes, resumen o cuentas corrientes por cliente.',
  { vista: z.enum(['facturas', 'resumen', 'clientes', 'ventas_pendientes']).default('resumen'), limite: L },
  safe(async ({ vista, limite }) => {
    const ruta = { facturas: '', resumen: '/resumen', clientes: '/clientes', ventas_pendientes: '/ventas' }[vista];
    return lista(await erp('GET', '/api/cxc' + ruta), { limite });
  }));

server.tool('parts_cuentas_por_pagar',
  'CxP: facturas de proveedores por pagar.',
  { limite: L }, safe(async ({ limite }) => lista(await erp('GET', '/api/compras/cxp'), { limite })));

server.tool('parts_ordenes_compra',
  'Órdenes de compra. Con id devuelve el detalle.',
  { id: z.string().optional(), q: z.string().optional(), limite: L },
  safe(async ({ id, q, limite }) => id ? erp('GET', `/api/oc/${encodeURIComponent(id)}`)
    : lista(await erp('GET', '/api/oc'), { q, limite, campos: ['numero', 'proveedor', 'estado'] })));

server.tool('parts_clientes',
  'Maestro de clientes. Busca por nombre/RUT/email.',
  { q: z.string().optional(), id: z.string().optional(), limite: L },
  safe(async ({ q, id, limite }) => id ? erp('GET', `/api/clientes/${encodeURIComponent(id)}`)
    : lista(await erp('GET', '/api/clientes'), { q, limite, campos: ['razon_social', 'contacto_nombre', 'rut', 'email', 'comuna'] })));

server.tool('parts_prospeccion',
  'Pipeline de prospección B2B: estadísticas y listado de prospectos.',
  { vista: z.enum(['stats', 'lista']).default('stats'), q: z.string().optional(), limite: L },
  safe(async ({ vista, q, limite }) => vista === 'stats' ? erp('GET', '/api/prospeccion/stats')
    : lista(await erp('GET', '/api/prospeccion'), { q, limite })));

server.tool('parts_dashboard',
  'Dashboard del ERP.',
  { seccion: z.enum(['resumen', 'ventas', 'productos', 'clientes', 'caja', 'alertas']).default('resumen') },
  safe(async ({ seccion }) => erp('GET', `/api/dashboard/${seccion}`)));

server.tool('parts_consulta_lectura',
  'Consulta GET libre a cualquier ruta /api/... del ERP (solo lectura). Úsala para explorar lo que no tiene herramienta propia.',
  { ruta: z.string().describe('Ej: /api/pricing o /api/pipeline/stats'), params: z.record(z.string()).optional(), limite: L },
  safe(async ({ ruta, params, limite }) => lista(await erp('GET', ruta + qs(params || {})), { limite })));

// ——— Escritura (dos pasos: vista previa → confirmar) ———
server.tool('parts_registrar_movimiento_caja',
  'Registra un INGRESO o EGRESO manual en el flujo de caja. Dos pasos: primero SIN confirmar (vista previa); solo con confirmar=true cuando el usuario diga "sí".',
  {
    tipo: z.enum(['ingreso', 'egreso']),
    descripcion: z.string().min(3),
    monto: z.number().positive().describe('CLP, entero'),
    categoria: z.string().optional(),
    fecha_pago: z.string().optional().describe('YYYY-MM-DD; por defecto hoy'),
    estado: z.enum(['confirmado', 'proyectado']).optional().describe('Por defecto: confirmado si la fecha es hoy o pasada, proyectado si es futura'),
    cuenta_bancaria: z.string().optional(),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    const fecha = a.fecha_pago || hoy();
    const payload = {
      tipo: a.tipo, descripcion: a.descripcion, monto: Math.round(a.monto),
      categoria: a.categoria, fecha_pago: fecha,
      estado: a.estado || (fecha <= hoy() ? 'confirmado' : 'proyectado'),
      cuenta_bancaria: a.cuenta_bancaria,
    };
    if (!a.confirmar) {
      return { vista_previa: payload, aviso: 'NO registrado. Pide confirmación al usuario y vuelve a llamar con confirmar=true.' };
    }
    const creado = await erp('POST', '/api/flujo-caja/manual', payload);
    bitacora({ accion: 'caja.manual', payload, resultado_id: creado?.id });
    return { registrado: creado };
  }));

server.tool('parts_crear_cotizacion',
  'Crea una cotización en BORRADOR. Precios NETO sin IVA; el IVA 19% se calcula aquí. Dos pasos: vista previa y luego confirmar=true con el "sí" del usuario.',
  {
    cliente_id: z.string().optional().describe('id del maestro de clientes (usa parts_clientes para buscarlo)'),
    cliente: z.string().optional().describe('Nombre si no hay cliente_id'),
    condicion_pago: z.string().default('Contado'),
    canal_origen: z.string().optional(),
    notas: z.string().optional(),
    items: z.array(z.object({
      codigo: z.string().describe('SKU de la lista de precios'),
      descripcion: z.string(),
      cantidad: z.number().positive(),
      precio_unitario: z.number().nonnegative().describe('Neto sin IVA'),
      descuento_pct: z.number().min(0).max(100).default(0),
      costo_unitario: z.number().nonnegative().default(0),
    })).min(1),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    if (!a.cliente_id && !a.cliente) throw new Error('Falta cliente_id o cliente');
    const items = a.items.map(i => ({
      ...i,
      subtotal: Math.round(i.cantidad * i.precio_unitario * (1 - (i.descuento_pct || 0) / 100)),
    }));
    const neto = items.reduce((s, i) => s + i.subtotal, 0);
    const iva = Math.round(neto * 0.19);
    const payload = {
      cliente_id: a.cliente_id, cliente: a.cliente, estado: 'borrador',
      condicion_pago: a.condicion_pago, canal_origen: a.canal_origen, notas: a.notas,
      neto, iva, total: neto + iva, items,
    };
    if (!a.confirmar) {
      return { vista_previa: payload, aviso: 'NO creada. Pide confirmación al usuario y vuelve a llamar con confirmar=true.' };
    }
    const creada = await erp('POST', '/api/cotizaciones', payload);
    bitacora({ accion: 'cotizacion.crear', numero: creada?.numero, total: payload.total });
    return { creada };
  }));

// ——— Órdenes de compra y facturas de compra (v0.2) ———
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const clp = (n) => Math.round(Number(n || 0));

// Acepta número ("OC-2026-0015") o id (uuid) y devuelve la OC con ítems.
async function resolverOC(ref) {
  const r = String(ref || '').trim();
  if (!r) throw new Error('Falta la OC (número OC-AAAA-NNNN o id)');
  if (/^OC-/i.test(r)) {
    const rows = rowsOf(await erp('GET', '/api/oc')) || [];
    const f = rows.find(o => String(o.numero).toUpperCase() === r.toUpperCase());
    if (!f) throw new Error(`OC ${r} no encontrada`);
    return erp('GET', `/api/oc/${encodeURIComponent(f.id)}`);
  }
  return erp('GET', `/api/oc/${encodeURIComponent(r)}`);
}

const resumenOC = (oc) => ({
  numero: oc.numero, proveedor: oc.proveedor, estado: oc.estado,
  neto: oc.neto, iva: oc.iva, total: oc.total,
  medio_pago: oc.medio_pago, numero_factura: oc.numero_factura || null,
});

server.tool('parts_crear_oc',
  'Crea una ORDEN DE COMPRA al proveedor en BORRADOR. Lo normal es ligarla a una NOTA DE VENTA ya autorizada (nota_venta): así queda calzada con el cliente y la cotización y copia las líneas con su costo. Solo sin nota_venta si es una compra sin venta asociada (sin_nota_venta=true). No la envía a autorización ni al proveedor. Precios NETO sin IVA. Dos pasos: vista previa y luego confirmar=true con el "sí" del usuario.',
  {
    nota_venta: z.string().optional().describe('Número (NV-2026-010) o id de la nota de venta de origen'),
    sin_nota_venta: z.boolean().default(false).describe('true solo si la OC no corresponde a ninguna venta'),
    proveedor: z.string().min(2).describe('Nombre del proveedor (ej: VISTONY)'),
    proveedor_id: z.string().optional().describe('id del maestro de proveedores; si falta se busca por nombre'),
    medio_pago: z.string().default('Contado').describe('Ej: Contado, Crédito 30 días'),
    fecha_requerida: z.string().optional().describe('YYYY-MM-DD'),
    observaciones: z.string().optional(),
    notas: z.string().optional(),
    items: z.array(z.object({
      codigo: z.string().describe('SKU'),
      descripcion: z.string(),
      cantidad: z.number().positive(),
      precio_unitario: z.number().nonnegative().describe('Costo de compra NETO sin IVA'),
    })).optional().describe('Con nota_venta es opcional: si falta se copian las líneas de la nota de venta con su costo'),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    if (a.fecha_requerida && !FECHA_RE.test(a.fecha_requerida)) throw new Error('fecha_requerida debe ser YYYY-MM-DD');
    if (!a.nota_venta && !a.sin_nota_venta) throw new Error('Indica la nota_venta a la que se liga la OC (las OC van calzadas a la cotización). Si de verdad no hay venta asociada, usa sin_nota_venta=true.');
    if (!a.nota_venta && !(a.items && a.items.length)) throw new Error('Sin nota de venta hay que indicar los items');
    const avisos = [];
    let bloqueo = null;

    let proveedor_id = a.proveedor_id;
    if (!proveedor_id) {
      const provs = rowsOf(await erp('GET', '/api/compras/proveedores')) || [];
      const n = norm(a.proveedor);
      const hits = provs.filter(p => norm(p.razon_social).includes(n) || n.includes(norm(p.razon_social)));
      if (hits.length === 1) proveedor_id = hits[0].id;
      else if (hits.length > 1) throw new Error(`Proveedor ambiguo: ${hits.map(h => h.razon_social).join(' | ')}. Indica proveedor_id.`);
      else avisos.push('El proveedor no está en el maestro: la OC quedaría solo con el nombre, sin proveedor_id.');
    }

    let origen = null;
    let lineas = a.items;
    if (a.nota_venta) {
      const nv = await erp('GET', `/api/pedidos/${encodeURIComponent(a.nota_venta.trim())}`);
      origen = {
        nota_venta: nv.numero, id: nv.id, estado: nv.estado, cliente: nv.cliente,
        cotizacion_id: nv.cotizacion_id || null, neto_venta: nv.neto,
        ocs_existentes: (nv.ocs || []).map(o => `${o.numero} (${o.estado})`),
      };
      if (!['autorizado', 'oc_emitida', 'oc_validada'].includes(nv.estado)) {
        bloqueo = `BLOQUEADO: la nota de venta ${nv.numero} está en "${nv.estado}". La OC al proveedor solo se emite cuando el administrador la autorizó.`;
      }
      if ((nv.ocs || []).some(o => !['anulada', 'rechazada'].includes(o.estado))) {
        avisos.push(`La nota de venta ya tiene OC al proveedor: ${origen.ocs_existentes.join(', ')}. Verifica que no sea un duplicado.`);
      }
      if (!lineas || !lineas.length) {
        lineas = (nv.items || []).map(i => ({ codigo: i.codigo_sku, descripcion: i.descripcion, cantidad: i.cantidad, precio_unitario: Number(i.costo_unitario) || 0 }));
        if (lineas.some(l => !l.precio_unitario)) avisos.push('Hay líneas sin costo en la nota de venta (costo 0): revisa los precios de compra antes de confirmar.');
      }
    }
    const items = lineas.map(i => ({ ...i, subtotal: clp(i.cantidad * i.precio_unitario) }));
    const neto = items.reduce((s, i) => s + i.subtotal, 0);
    const iva = Math.round(neto * 0.19);
    if (origen && origen.neto_venta && neto > Number(origen.neto_venta)) avisos.push(`El costo de compra ($${neto}) supera el neto de la venta ($${clp(origen.neto_venta)}): margen negativo.`);

    const payload = { proveedor_id, proveedor: a.proveedor, medio_pago: a.medio_pago, fecha_requerida: a.fecha_requerida, observaciones: a.observaciones, notas: a.notas };
    if (a.items && a.items.length) payload.items = a.items;
    if (bloqueo) avisos.unshift(bloqueo);
    if (!a.confirmar) {
      return { vista_previa: { ...payload, origen: origen || 'sin nota de venta (no calza con ninguna cotización)', items: items, neto, iva, total: neto + iva, estado_inicial: 'borrador' }, avisos,
        aviso: 'NO creada. Pide confirmación al usuario y vuelve a llamar con confirmar=true. La OC nace en borrador: la autorización la hace el gerente en el ERP.' };
    }
    if (bloqueo) throw new Error(bloqueo);
    const creada = a.nota_venta
      ? await erp('POST', `/api/oc/desde-pedido/${encodeURIComponent(origen.id)}`, payload)
      : await erp('POST', '/api/oc', { ...payload, items: a.items });
    bitacora({ accion: 'oc.crear', numero: creada?.numero, proveedor: a.proveedor, total: neto + iva, nota_venta: origen?.nota_venta || null });
    return { creada: resumenOC(creada), id: creada?.id, ligada_a: origen ? { nota_venta: origen.nota_venta, cotizacion_id: creada?.cotizacion_id || origen.cotizacion_id } : null };
  }));

server.tool('parts_crear_cliente',
  'Crea un CLIENTE en el maestro. Antes de crear busca duplicados por RUT o razón social. Dos pasos: vista previa y luego confirmar=true con el "sí" del usuario.',
  {
    razon_social: z.string().min(2),
    rut: z.string().optional(),
    segmento: z.enum(['taller', 'flota', 'concesionario']).describe('Segmento comercial'),
    etapa_pipeline: z.string().default('prospecto').describe('prospecto, contactado, cliente...'),
    contacto_nombre: z.string().optional(),
    contacto_cargo: z.string().optional(),
    telefono: z.string().optional(),
    whatsapp: z.string().optional(),
    email: z.string().optional(),
    direccion: z.string().optional(),
    comuna: z.string().optional(),
    giro: z.string().optional(),
    credito_activo: z.boolean().default(false),
    dias_credito: z.number().int().nonnegative().default(0),
    limite_credito: z.number().nonnegative().default(0),
    notas: z.string().optional(),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    const { confirmar, ...payload } = a;
    const todos = rowsOf(await erp('GET', '/api/clientes')) || [];
    const limpio = (s) => String(s || '').replace(/[.\-\s]/g, '').toLowerCase();
    const dup = todos.filter(c =>
      (a.rut && limpio(c.rut) && limpio(c.rut) === limpio(a.rut)) ||
      norm(c.razon_social) === norm(a.razon_social));
    const avisos = dup.length ? [`Posible duplicado: ${dup.map(c => `${c.razon_social} (${c.rut || 'sin RUT'}, id ${c.id})`).join(' | ')}. Si es el mismo, usa ese cliente_id en vez de crear otro.`] : [];
    if (!confirmar) {
      return { vista_previa: payload, avisos, aviso: 'NO creado. Pide confirmación al usuario y vuelve a llamar con confirmar=true.' };
    }
    if (dup.length) throw new Error(avisos[0]);
    const creado = await erp('POST', '/api/clientes', payload);
    bitacora({ accion: 'cliente.crear', id: creado?.id, razon_social: a.razon_social });
    return { creado: { id: creado?.id, razon_social: creado?.razon_social, rut: creado?.rut, segmento: creado?.segmento, etapa_pipeline: creado?.etapa_pipeline } };
  }));

server.tool('parts_registrar_factura_compra',
  'Ingresa la FACTURA DE COMPRA de un proveedor contra una OC que ya fue RECIBIDA (recibida_total o recibida_parcial). Crea la cuenta por pagar y el egreso proyectado en caja. No sirve para facturas de venta. Dos pasos: vista previa y luego confirmar=true con el "sí" del usuario.',
  {
    oc: z.string().describe('Número de OC (OC-2026-0015) o id'),
    numero_factura: z.string().min(1),
    fecha_factura: z.string().describe('YYYY-MM-DD'),
    fecha_vencimiento_pago: z.string().describe('YYYY-MM-DD'),
    monto_total: z.number().positive().describe('Total de la factura CON IVA, CLP'),
    modo_pago: z.string().describe('Ej: Contado, Crédito 30 días, Transferencia'),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    if (!FECHA_RE.test(a.fecha_factura) || !FECHA_RE.test(a.fecha_vencimiento_pago)) throw new Error('Las fechas deben ser YYYY-MM-DD');
    const oc = await resolverOC(a.oc);
    const monto = clp(a.monto_total);
    const puede = ['recibida_total', 'recibida_parcial'].includes(oc.estado);
    const avisos = [];
    if (!puede) avisos.push(`BLOQUEADO: la OC está en "${oc.estado}". Solo se factura desde recibida_total o recibida_parcial (primero hay que registrar la recepción en el ERP).`);
    if (oc.numero_factura) avisos.push(`La OC ya tiene la factura ${oc.numero_factura} registrada.`);
    if (Math.abs(monto - clp(oc.total)) > 1) avisos.push(`El monto ($${monto}) no coincide con el total de la OC ($${clp(oc.total)}). Revisa si es factura parcial o hay diferencia de precio.`);
    if (a.fecha_vencimiento_pago < a.fecha_factura) avisos.push('El vencimiento es anterior a la fecha de factura.');
    const payload = { numero_factura: a.numero_factura, fecha_factura: a.fecha_factura, fecha_vencimiento_pago: a.fecha_vencimiento_pago, monto_total: monto, modo_pago: a.modo_pago };
    if (!a.confirmar) {
      return { vista_previa: { oc: resumenOC(oc), factura: payload }, avisos,
        aviso: 'NO registrada. Pide confirmación al usuario y vuelve a llamar con confirmar=true.' };
    }
    if (!puede) throw new Error(avisos[0]);
    if (oc.numero_factura) throw new Error(avisos.find(x => x.startsWith('La OC ya tiene')));
    await erp('POST', `/api/oc/${encodeURIComponent(oc.id)}/factura`, payload);
    // El ERP traga errores internos al crear CxP/caja: se verifica leyendo de vuelta.
    const despues = await erp('GET', `/api/oc/${encodeURIComponent(oc.id)}`);
    const cxp = (rowsOf(await erp('GET', '/api/compras/cxp')) || []).find(f => f.oc_id === oc.id);
    const verificacion = {
      oc_estado: despues.estado,
      oc_facturada: despues.estado === 'facturada' && despues.numero_factura === a.numero_factura,
      cxp_creada: !!cxp,
    };
    bitacora({ accion: 'oc.factura_compra', oc: oc.numero, numero_factura: a.numero_factura, monto, verificacion });
    return { registrada: resumenOC(despues), cxp: cxp || null, verificacion,
      aviso: 'Siguiente paso (gerente, en el ERP): autorizar el pago. Luego usa parts_registrar_pago_oc.' };
  }));

server.tool('parts_registrar_pago_oc',
  'Registra el PAGO de una OC cuyo pago YA fue autorizado por el gerente (estado pago_autorizado): la pasa a "pagada", cierra la cuenta por pagar y confirma el egreso en caja. No autoriza pagos. Dos pasos: vista previa y luego confirmar=true con el "sí" del usuario.',
  {
    oc: z.string().describe('Número de OC (OC-2026-0015) o id'),
    forma_pago: z.string().optional().describe('Ej: Transferencia, Efectivo'),
    cuenta_bancaria: z.string().optional(),
    observaciones: z.string().optional(),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    const oc = await resolverOC(a.oc);
    const avisos = [];
    const puede = oc.estado === 'pago_autorizado';
    if (!puede) avisos.push(oc.estado === 'facturada'
      ? 'BLOQUEADO: la OC está facturada pero el pago aún no está autorizado. Debe autorizarlo el gerente en el ERP.'
      : `BLOQUEADO: la OC está en "${oc.estado}"; solo se paga desde pago_autorizado.`);
    const payload = { nuevo_estado: 'pagada', forma_pago: a.forma_pago || oc.forma_pago || undefined, cuenta_bancaria: a.cuenta_bancaria || oc.cuenta_bancaria || undefined, observaciones: a.observaciones };
    if (!a.confirmar) {
      return { vista_previa: { oc: resumenOC(oc), pago: payload, monto_egreso_caja: clp(oc.total) }, avisos,
        aviso: 'NO registrado. Pide confirmación al usuario y vuelve a llamar con confirmar=true. Al confirmar, el egreso pasa a "confirmado" en caja con fecha de hoy.' };
    }
    if (!puede) throw new Error(avisos[0]);
    const pagada = await erp('PATCH', `/api/oc/${encodeURIComponent(oc.id)}/estado`, payload);
    bitacora({ accion: 'oc.pago', oc: oc.numero, total: oc.total, forma_pago: payload.forma_pago });
    return { pagada: resumenOC(pagada) };
  }));

// ——— Flujo comercial: autorización de nota de venta, recepción y avance de OC (v0.2) ———
server.tool('parts_autorizar_nota_venta',
  'AUTORIZA una nota de venta (acción del ADMINISTRADOR: habilita emitir la OC al proveedor). El ERP valida el rol con el usuario del conector (debe ser administrador). Dos pasos: vista previa y luego confirmar=true SOLO cuando el usuario diga explícitamente que autoriza.',
  {
    nota_venta: z.string().describe('Número (NV-2026-010) o id'),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    const nv = await erp('GET', `/api/pedidos/${encodeURIComponent(a.nota_venta.trim())}`);
    const autorizable = ['pendiente', 'confirmado', 'en_autorizacion', 'rechazado'].includes(nv.estado);
    const avisos = [];
    if (!autorizable) avisos.push(`BLOQUEADO: la nota de venta está en "${nv.estado}"; solo se autoriza desde pendiente, confirmado, en_autorizacion o rechazado.`);
    if (!nv.oc_cliente) avisos.push('No tiene la OC del cliente adjunta en el ERP.');
    if (!(nv.items || []).length) avisos.push('BLOQUEADO: no tiene ítems.');
    if (nv.margen && nv.margen.pct !== null && nv.margen.pct < 0) avisos.push(`Margen estimado negativo (${Math.round(nv.margen.pct * 1000) / 10}%).`);
    const resumen = {
      nota_venta: nv.numero, estado: nv.estado, cliente: nv.cliente, neto: nv.neto, total: nv.total,
      condicion_pago: nv.condicion_pago, oc_cliente_adjunta: nv.oc_cliente ? nv.oc_cliente.nombre_archivo : null,
      margen: nv.margen ? { monto: nv.margen.monto, pct: nv.margen.pct } : null,
      items: (nv.items || []).map(i => ({ codigo: i.codigo_sku, descripcion: i.descripcion, cantidad: i.cantidad, precio: i.precio_unitario, costo: i.costo_unitario })),
    };
    if (!a.confirmar) {
      return { vista_previa: resumen, avisos, aviso: 'NO autorizada. Muestra el resumen y pide al usuario que autorice explícitamente; luego vuelve a llamar con confirmar=true.' };
    }
    if (!autorizable || !(nv.items || []).length) throw new Error(avisos.find(x => x.startsWith('BLOQUEADO')));
    const r = await erp('POST', `/api/pedidos/${encodeURIComponent(nv.id)}/autorizar`, {});
    bitacora({ accion: 'nv.autorizar', nota_venta: nv.numero, cliente: nv.cliente, total: nv.total });
    return { autorizada: { nota_venta: r?.numero, estado: r?.estado, autorizado_at: r?.autorizado_at }, aviso: 'Siguiente paso: parts_crear_oc con nota_venta para emitir la OC al proveedor.' };
  }));

server.tool('parts_registrar_recepcion_oc',
  'Registra la RECEPCIÓN de mercadería de una OC (estado enviada_proveedor o recibida_parcial). SUBE el stock en bodega y, si queda recibida al 100%, crea la cuenta por pagar pendiente. Sin "lineas" se recibe todo lo pendiente. Dos pasos: vista previa y luego confirmar=true con el "sí" del usuario.',
  {
    oc: z.string().describe('Número de OC (OC-2026-0015) o id'),
    lineas: z.array(z.object({
      codigo: z.string().describe('SKU de la línea'),
      cantidad_recibida: z.number().positive(),
    })).optional().describe('Recepción parcial: solo estas líneas. Si falta, se recibe todo lo pendiente'),
    observacion: z.string().optional(),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    const oc = await resolverOC(a.oc);
    const puede = ['enviada_proveedor', 'recibida_parcial'].includes(oc.estado);
    const avisos = [];
    if (!puede) avisos.push(`BLOQUEADO: la OC está en "${oc.estado}"; solo se recibe desde enviada_proveedor o recibida_parcial.`);
    const pendientes = (oc.items || []).map(i => ({ id: i.id, codigo: i.codigo, descripcion: i.descripcion, pedida: i.cantidad, recibida: i.cantidad_recibida_total || 0, pendiente: i.cantidad - (i.cantidad_recibida_total || 0) }));
    let lineas;
    if (a.lineas && a.lineas.length) {
      lineas = a.lineas.map(l => {
        const it = pendientes.find(p => p.codigo === l.codigo);
        if (!it) throw new Error(`El SKU ${l.codigo} no está en la OC ${oc.numero}`);
        if (l.cantidad_recibida > it.pendiente) avisos.push(`SKU ${l.codigo}: se recibirían ${l.cantidad_recibida} pero solo hay ${it.pendiente} pendientes (el ERP topa en ${it.pendiente}).`);
        return { linea_oc_id: it.id, codigo: it.codigo, cantidad_recibida: Math.min(l.cantidad_recibida, it.pendiente) };
      });
    } else {
      lineas = pendientes.filter(p => p.pendiente > 0).map(p => ({ linea_oc_id: p.id, codigo: p.codigo, cantidad_recibida: p.pendiente }));
    }
    if (!lineas.length) avisos.push('BLOQUEADO: no hay nada pendiente por recibir.');
    if (!a.confirmar) {
      return { vista_previa: { oc: resumenOC(oc), recepcion: lineas.map(l => ({ codigo: l.codigo, cantidad_recibida: l.cantidad_recibida })), lineas_oc: pendientes.map(({ id, ...r }) => r), observacion: a.observacion }, avisos,
        aviso: 'NO registrada. Pide confirmación al usuario y vuelve a llamar con confirmar=true. Al confirmar, el stock de bodega sube.' };
    }
    if (!puede || !lineas.length) throw new Error(avisos.find(x => x.startsWith('BLOQUEADO')));
    const r = await erp('POST', `/api/oc/${encodeURIComponent(oc.id)}/recepcion`, {
      observacion: a.observacion, lineas: lineas.map(l => ({ linea_oc_id: l.linea_oc_id, cantidad_recibida: l.cantidad_recibida })),
    });
    bitacora({ accion: 'oc.recepcion', oc: oc.numero, lineas: lineas.map(l => `${l.codigo}x${l.cantidad_recibida}`) });
    return { recibida: resumenOC(r), advertencias_erp: r?.advertencias || [],
      aviso: r?.estado === 'recibida_total' ? 'OC recibida al 100%. Ya se puede ingresar la factura de compra.' : 'Recepción parcial: faltan unidades por recibir.' };
  }));

const AVANCES_OC = { pendiente_autorizacion: 'borrador', enviada_proveedor: 'autorizada' };
server.tool('parts_avanzar_oc',
  'Avanza una OC en su flujo SIN autorizar nada: borrador → pendiente_autorizacion (la deja lista para que el gerente la autorice) o autorizada → enviada_proveedor (marca que fue enviada al proveedor; no manda el correo). Las autorizaciones de OC y de pago son del gerente y NO se hacen desde aquí. Dos pasos: vista previa y luego confirmar=true con el "sí" del usuario.',
  {
    oc: z.string().describe('Número de OC (OC-2026-0015) o id'),
    nuevo_estado: z.enum(['pendiente_autorizacion', 'enviada_proveedor']),
    confirmar: z.boolean().default(false),
  },
  safe(async (a) => {
    const oc = await resolverOC(a.oc);
    const requerido = AVANCES_OC[a.nuevo_estado];
    const puede = oc.estado === requerido;
    const avisos = [];
    if (!puede) avisos.push(`BLOQUEADO: para pasar a ${a.nuevo_estado} la OC debe estar en "${requerido}" y está en "${oc.estado}".`);
    if (!a.confirmar) {
      return { vista_previa: { oc: resumenOC(oc), de: oc.estado, a: a.nuevo_estado }, avisos, aviso: 'NO cambiada. Pide confirmación al usuario y vuelve a llamar con confirmar=true.' };
    }
    if (!puede) throw new Error(avisos[0]);
    const r = await erp('PATCH', `/api/oc/${encodeURIComponent(oc.id)}/estado`, { nuevo_estado: a.nuevo_estado });
    bitacora({ accion: 'oc.avanzar', oc: oc.numero, de: oc.estado, a: a.nuevo_estado });
    return { actualizada: resumenOC(r) };
  }));



  return server;
}
