#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Generado por herramientas/envolver.mjs desde:
//   /mnt/user-data/uploads/funnelos-mcp/server.mjs
// Única diferencia con el conector local: se quitó el transporte stdio y el
// cuerpo quedó dentro de createServer(). La lógica y las herramientas son
// idénticas — no editar a mano, regenerar con el script.
// ─────────────────────────────────────────────────────────────────────────────
export function createServer() {

const BASE = (process.env.FUNNELOS_URL || "https://body-elite-giftcards.onrender.com").replace(/\/+$/, "");
const USER = process.env.FUNNELOS_USER;
const PASS = process.env.FUNNELOS_PASS;
const TENANT = process.env.FUNNELOS_TENANT || "demo_automotora";
const TZ = "America/Santiago";
let session = null;

async function http(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Auth-Token"] = token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}
async function login() {
  if (!USER || !PASS) throw new Error("Faltan FUNNELOS_USER y FUNNELOS_PASS en la configuración del conector.");
  const r = await http("POST", "/api/auth/login", { username: USER, password: PASS, tenant: TENANT });
  if (!r.ok || !r.data.token) throw new Error(r.data.error || `Login falló (HTTP ${r.status})`);
  session = { token: r.data.token };
}
async function get(path) {
  if (!session) await login();
  let r = await http("GET", path, null, session.token);
  if (r.status === 401) { await login(); r = await http("GET", path, null, session.token); }
  if (!r.ok) throw new Error(r.data.error || `Error HTTP ${r.status} en ${path.split("?")[0]}`);
  return r.data;
}
const dayCL = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
};
const qs = (p) => {
  const e = Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return e.length ? "?" + e.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : "";
};
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
async function leadsEnRango(desde, hasta) {
  const data = await get("/api/leads" + qs({ start: desde, end: hasta }));
  const all = Array.isArray(data) ? data : data.leads || [];
  return all.filter((l) => {
    const d = dayCL(l.createdAt);
    if (!d) return false;
    if (desde && d < desde) return false;
    if (hasta && d > hasta) return false;
    return true;
  });
}
const textoLead = (l) => norm([
  l.interest, l.adTracing && l.adTracing.headline,
  typeof l.notes === "string" ? l.notes : JSON.stringify(l.notes || ""),
  ...(l.chatHistory || []).filter((m) => m.role === "user").map((m) => m.content),
].join(" "));
const out = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });
const wrap = (fn) => async (args) => { try { return out(await fn(args)); } catch (e) { return fail(e); } };
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato AAAA-MM-DD").optional();
const rango = { desde: fecha.describe("Fecha de creación desde, AAAA-MM-DD, hora de Santiago"), hasta: fecha.describe("Fecha de creación hasta (inclusive), AAAA-MM-DD") };
const CERRADOS = new Set(["cerrado"]);
const MUERTOS = new Set(["abandonado", "descartado"]);

const server = new McpServer({ name: "funnelos", version: "1.0.0" });

server.tool("funnelos_embudo",
  "Embudo de leads de FunnelOS por canal: leads creados, vivos (no abandonados ni descartados), cerrados y detalle por estado. Sin datos personales.",
  { ...rango },
  wrap(async ({ desde, hasta }) => {
    const leads = await leadsEnRango(desde, hasta);
    const canales = {};
    for (const l of leads) {
      const c = (canales[l.source || "Sin canal"] ??= { leads: 0, vivos: 0, cerrados: 0, estados: {} });
      const st = l.status || "Sin estado"; const k = norm(st);
      c.leads++; c.estados[st] = (c.estados[st] || 0) + 1;
      if (!MUERTOS.has(k)) c.vivos++;
      if (CERRADOS.has(k)) c.cerrados++;
    }
    const lista = Object.entries(canales).map(([canal, v]) => ({ canal, ...v })).sort((a, b) => b.leads - a.leads);
    const total = lista.reduce((a, c) => ({ leads: a.leads + c.leads, vivos: a.vivos + c.vivos, cerrados: a.cerrados + c.cerrados }), { leads: 0, vivos: 0, cerrados: 0 });
    return { periodo: { desde: desde || null, hasta: hasta || null, zona: TZ }, total, canales: lista };
  }));

server.tool("funnelos_leads_resumen",
  "Cuenta leads agrupados por canal, estado, vendedor asignado o día. Sin datos personales.",
  { ...rango, agrupar_por: z.enum(["canal", "estado", "vendedor", "dia", "canal_estado"]).default("canal"), canal: z.string().optional(), estado: z.string().optional() },
  wrap(async ({ desde, hasta, agrupar_por, canal, estado }) => {
    let leads = await leadsEnRango(desde, hasta);
    if (canal) leads = leads.filter((l) => norm(l.source) === norm(canal));
    if (estado) leads = leads.filter((l) => norm(l.status) === norm(estado));
    const key = { canal: (l) => l.source, estado: (l) => l.status, vendedor: (l) => l.assignedTo, dia: (l) => dayCL(l.createdAt), canal_estado: (l) => `${l.source} | ${l.status}` }[agrupar_por];
    const m = new Map();
    for (const l of leads) { const k = key(l) || "(vacío)"; m.set(k, (m.get(k) || 0) + 1); }
    return { total: leads.length, agrupar_por, grupos: [...m.entries()].sort((a, b) => b[1] - a[1]).map(([grupo, cantidad]) => ({ grupo, cantidad })) };
  }));

server.tool("funnelos_consultas_vehiculo",
  "Leads que mencionan un vehículo (modelo, marca o patente) en interés, notas, anuncio o mensajes del cliente, por canal y estado. Úsalo con desde = fecha de ingreso a stock y hasta = fecha de venta.",
  { ...rango, texto: z.string().min(2).describe("Modelo, marca o patente, ej. 'mokka' o 'ABCD12'") },
  wrap(async ({ desde, hasta, texto }) => {
    const leads = await leadsEnRango(desde, hasta);
    const re = new RegExp(norm(texto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const m = leads.filter((l) => re.test(textoLead(l)));
    const porCanal = {}, porEstado = {};
    for (const l of m) { porCanal[l.source] = (porCanal[l.source] || 0) + 1; porEstado[l.status] = (porEstado[l.status] || 0) + 1; }
    return { texto, desde: desde || null, hasta: hasta || null, consultas: m.length, por_canal: porCanal, por_estado: porEstado, leads_ids: m.slice(0, 200).map((l) => l.id) };
  }));

server.tool("funnelos_leads",
  "Lista leads con filtros. Por defecto NO incluye nombre ni teléfono; pasa incluir_contacto=true solo si hace falta identificar al cliente.",
  { ...rango, canal: z.string().optional(), estado: z.string().optional(), texto: z.string().optional().describe("Busca en interés, notas y mensajes del cliente"), telefono: z.string().optional().describe("Últimos dígitos del teléfono"), nombre: z.string().optional(), incluir_contacto: z.boolean().default(false), limite: z.number().int().min(1).max(200).default(50) },
  wrap(async ({ desde, hasta, canal, estado, texto, telefono, nombre, incluir_contacto, limite }) => {
    let leads = await leadsEnRango(desde, hasta);
    if (canal) leads = leads.filter((l) => norm(l.source) === norm(canal));
    if (estado) leads = leads.filter((l) => norm(l.status) === norm(estado));
    if (texto) { const t = norm(texto); leads = leads.filter((l) => textoLead(l).includes(t)); }
    if (telefono) { const d = telefono.replace(/\D/g, ""); leads = leads.filter((l) => String(l.phone || "").replace(/\D/g, "").endsWith(d)); }
    if (nombre) { const t = norm(nombre).split(/\s+/).filter(Boolean); leads = leads.filter((l) => { const n = norm(l.name); return t.every((x) => n.includes(x)); }); }
    const filas = leads.slice(0, limite).map((l) => ({
      id: l.id, creado: dayCL(l.createdAt), canal: l.source, estado: l.status, vendedor: l.assignedTo, interes: l.interest,
      mensajes_cliente: (l.chatHistory || []).filter((m) => m.role === "user").length,
      ...(incluir_contacto ? { nombre: l.name, telefono: l.phone } : {}),
    }));
    return { total_coincidencias: leads.length, mostrando: filas.length, leads: filas };
  }));

server.tool("funnelos_lead_detalle",
  "Detalle de un lead por id: datos, notas y los últimos mensajes de la conversación.",
  { id: z.union([z.number(), z.string()]), ultimos_mensajes: z.number().int().min(0).max(50).default(10), incluir_contacto: z.boolean().default(false) },
  wrap(async ({ id, ultimos_mensajes, incluir_contacto }) => {
    const data = await get("/api/leads");
    const all = Array.isArray(data) ? data : data.leads || [];
    const l = all.find((x) => String(x.id) === String(id));
    if (!l) throw new Error(`No existe el lead ${id}`);
    const { chatHistory, name, phone, ...resto } = l;
    return { ...resto, ...(incluir_contacto ? { name, phone } : {}), total_mensajes: (chatHistory || []).length, ultimos_mensajes: (chatHistory || []).slice(-ultimos_mensajes).map((m) => ({ rol: m.role, ts: m.ts, texto: m.content })) };
  }));

server.tool("funnelos_analytics_canales",
  "KPIs por canal que calcula FunnelOS en su pestaña Analítica (respuesta cruda del servidor).",
  { ...rango },
  wrap(async ({ desde, hasta }) => get("/api/analytics/channels" + qs({ start: desde, end: hasta }))));

server.tool("funnelos_equipo",
  "Dashboard del equipo comercial de FunnelOS (respuesta cruda del servidor).",
  { ...rango },
  wrap(async ({ desde, hasta }) => get("/api/dashboard/team" + qs({ start: desde, end: hasta }))));



  return server;
}
