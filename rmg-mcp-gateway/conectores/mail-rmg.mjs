#!/usr/bin/env node
// Conector MCP del correo de RMG Autos (mail.rmgautos.cl, cPanel).
//
// Roundcube no expone API: es solo un cliente web sobre el mismo buzon. Por eso este
// conector habla IMAP (lectura) y SMTP (envio) directo contra el servidor de correo.
// Asi funciona igual desde Mac, movil y voz, sin depender de la sesion del navegador.
//
// Variables de entorno (por identidad, ver index.mjs):
//   MAIL_USER        obligatoria   direccion completa, ej. ventas@rmgautos.cl
//   MAIL_PASS        obligatoria   clave de la cuenta de correo
//   MAIL_IMAP_HOST   opcional      por defecto mail.rmgautos.cl
//   MAIL_IMAP_PORT   opcional      por defecto 993 (SSL)
//   MAIL_SMTP_HOST   opcional      por defecto mail.rmgautos.cl
//   MAIL_SMTP_PORT   opcional      por defecto 465 (SSL)
//   MAIL_FROM        opcional      remitente a mostrar, ej. "RMG Autos <ventas@rmgautos.cl>"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import fs from "node:fs";
import { guardarAdjunto, enlaceDe } from "../herramientas/adjuntos.mjs";

export function createServer() {

const TZ = "America/Santiago";

const cfg = () => {
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;
  if (!user || !pass) throw new Error("Faltan MAIL_USER y MAIL_PASS en la configuracion del conector.");
  return {
    user,
    pass,
    imapHost: process.env.MAIL_IMAP_HOST || "mail.rmgautos.cl",
    imapPort: Number(process.env.MAIL_IMAP_PORT || 993),
    smtpHost: process.env.MAIL_SMTP_HOST || "mail.rmgautos.cl",
    smtpPort: Number(process.env.MAIL_SMTP_PORT || 465),
    from: process.env.MAIL_FROM || user,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Infraestructura
// ─────────────────────────────────────────────────────────────────────────────

// Una conexion IMAP por llamada: el gateway es sin estado y cada peticion puede venir
// de una identidad distinta. Siempre se cierra, incluso si la tool falla.
async function conIMAP(fn) {
  const c = cfg();
  const client = new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    emitLogs: false,
  });
  await client.connect();
  try {
    return await fn(client, c);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// Abre una carpeta en modo lectura o escritura y libera el lock al terminar.
async function enCarpeta(client, carpeta, soloLectura, fn) {
  const lock = await client.getMailboxLock(carpeta, { readOnly: soloLectura });
  try {
    return await fn(client.mailbox);
  } finally {
    lock.release();
  }
}

const transporte = () => {
  const c = cfg();
  return nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpPort === 465,
    auth: { user: c.user, pass: c.pass },
  });
};

const out = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });
const wrap = (fn) => async (args) => { try { return out(await fn(args)); } catch (e) { return fail(e); } };

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato AAAA-MM-DD");
const fechaOpt = fecha.optional();

// IMAP SINCE/BEFORE trabajan con el dia del servidor; se envian como Date a medianoche.
const aFecha = (s) => (s ? new Date(`${s}T00:00:00`) : undefined);
const diaCL = (d) => {
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
};
const horaCL = (d) => {
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", " ");
};
const dir = (a) => (a && a.length ? a.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(", ") : null);
const recorta = (s, n) => {
  const t = String(s ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? `${t.slice(0, n)}\n[... ${t.length - n} caracteres mas; usa mail_leer con cuerpo_max mayor]` : t;
};

// Bitacora de escrituras, igual que en los otros conectores del gateway.
const bitacora = (registro) => {
  try {
    fs.appendFileSync("bitacora-escrituras.jsonl",
      `${JSON.stringify({ ts: new Date().toISOString(), conector: "mail-rmg", ...registro })}\n`);
  } catch { /* la bitacora nunca debe tumbar la operacion */ }
};

// Carpetas especiales de cPanel/Dovecot. Se resuelven por atributo IMAP, no por nombre,
// porque el servidor puede tenerlas en espanol o bajo un prefijo INBOX.
async function especiales(client) {
  const lista = await client.list();
  const porUso = {};
  for (const m of lista) {
    if (m.specialUse) porUso[m.specialUse] = m.path;
  }
  return {
    enviados: porUso["\\Sent"] || "INBOX.Sent",
    papelera: porUso["\\Trash"] || "INBOX.Trash",
    borradores: porUso["\\Drafts"] || "INBOX.Drafts",
    spam: porUso["\\Junk"] || "INBOX.spam",
    archivo: porUso["\\Archive"] || null,
    todas: lista.map((m) => m.path),
  };
}

const server = new McpServer({ name: "mail-rmg", version: "1.0.0" });

// ─────────────────────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────────────────────

server.tool("mail_carpetas",
  "Lista las carpetas del correo de RMG Autos con total de mensajes y no leidos en cada una. Usalo primero si no sabes como se llama una carpeta.",
  {},
  wrap(async () => conIMAP(async (client) => {
    const esp = await especiales(client);
    const lista = await client.list();
    const carpetas = [];
    for (const m of lista) {
      if (m.flags && m.flags.has && m.flags.has("\\Noselect")) continue;
      try {
        const st = await client.status(m.path, { messages: true, unseen: true });
        carpetas.push({ carpeta: m.path, nombre: m.name, mensajes: st.messages ?? 0, no_leidos: st.unseen ?? 0, uso: m.specialUse || null });
      } catch {
        carpetas.push({ carpeta: m.path, nombre: m.name, mensajes: null, no_leidos: null, uso: m.specialUse || null });
      }
    }
    return {
      cuenta: cfg().user,
      especiales: { enviados: esp.enviados, papelera: esp.papelera, borradores: esp.borradores, spam: esp.spam },
      carpetas: carpetas.sort((a, b) => (b.no_leidos ?? 0) - (a.no_leidos ?? 0) || a.carpeta.localeCompare(b.carpeta)),
    };
  })));

server.tool("mail_buscar",
  "Busca correos en una carpeta y devuelve la cabecera de cada uno (uid, fecha, de, para, asunto, leido, adjuntos). NO devuelve el cuerpo ni descarga adjuntos: para el cuerpo usa mail_leer con el uid, y para bajar un adjunto mail_adjuntos. Los filtros se combinan con Y.",
  {
    carpeta: z.string().default("INBOX").describe("Carpeta IMAP, ej. INBOX o INBOX.Sent. Ver mail_carpetas."),
    desde: fechaOpt.describe("Recibidos desde esta fecha, AAAA-MM-DD"),
    hasta: fechaOpt.describe("Recibidos hasta esta fecha inclusive, AAAA-MM-DD"),
    de: z.string().optional().describe("Texto en el remitente, ej. 'sii.cl' o 'juan'"),
    para: z.string().optional().describe("Texto en el destinatario"),
    asunto: z.string().optional().describe("Texto en el asunto"),
    texto: z.string().optional().describe("Texto en el cuerpo del mensaje"),
    no_leidos: z.boolean().default(false).describe("Solo mensajes sin leer"),
    con_adjuntos: z.boolean().default(false).describe("Solo mensajes que traen adjuntos"),
    limite: z.number().int().min(1).max(200).default(30).describe("Cuantos devolver, los mas recientes primero"),
  },
  wrap(async ({ carpeta, desde, hasta, de, para, asunto, texto, no_leidos, con_adjuntos, limite }) => conIMAP(async (client) =>
    enCarpeta(client, carpeta, true, async (buzon) => {
      const criterio = {};
      if (desde) criterio.since = aFecha(desde);
      // IMAP BEFORE es exclusivo: para incluir el dia "hasta" se pide el dia siguiente.
      if (hasta) { const d = aFecha(hasta); d.setDate(d.getDate() + 1); criterio.before = d; }
      if (de) criterio.from = de;
      if (para) criterio.to = para;
      if (asunto) criterio.subject = asunto;
      if (texto) criterio.body = texto;
      if (no_leidos) criterio.seen = false;
      if (!Object.keys(criterio).length) criterio.all = true;

      const uids = await client.search(criterio, { uid: true });
      if (!uids || !uids.length) {
        return { carpeta, total_en_carpeta: buzon.exists, coincidencias: 0, mensajes: [] };
      }
      // Los uid crecen con el tiempo: los mas altos son los mas recientes.
      const recientes = uids.slice().sort((a, b) => a - b).slice(-limite).reverse();

      const mensajes = [];
      for await (const m of client.fetch({ uid: recientes.join(",") },
        { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true })) {
        const adj = adjuntosDe(m.bodyStructure);
        mensajes.push({
          uid: m.uid,
          fecha: horaCL(m.envelope?.date),
          dia: diaCL(m.envelope?.date),
          de: dir(m.envelope?.from),
          para: dir(m.envelope?.to),
          asunto: m.envelope?.subject || "(sin asunto)",
          leido: !!(m.flags && m.flags.has("\\Seen")),
          respondido: !!(m.flags && m.flags.has("\\Answered")),
          destacado: !!(m.flags && m.flags.has("\\Flagged")),
          adjuntos: adj.length,
          nombres_adjuntos: adj.map((a) => a.nombre).filter(Boolean),
          tamano_kb: m.size ? Math.round(m.size / 1024) : null,
        });
      }
      const filtrados = con_adjuntos ? mensajes.filter((x) => x.adjuntos > 0) : mensajes;
      return {
        carpeta,
        total_en_carpeta: buzon.exists,
        coincidencias: uids.length,
        mostrando: filtrados.length,
        mensajes: filtrados.sort((a, b) => b.uid - a.uid),
      };
    }))));

// Recorre la estructura del mensaje y devuelve las partes que son adjuntos.
function adjuntosDe(nodo, acc = []) {
  if (!nodo) return acc;
  const disp = String(nodo.disposition || "").toLowerCase();
  const nombre = nodo.dispositionParameters?.filename || nodo.parameters?.name || null;
  if (disp === "attachment" || (nombre && disp !== "inline")) {
    acc.push({ parte: nodo.part || "1", nombre, tipo: nodo.type || null, tamano_kb: nodo.size ? Math.round(nodo.size / 1024) : null });
  }
  for (const hijo of nodo.childNodes || []) adjuntosDe(hijo, acc);
  return acc;
}

server.tool("mail_leer",
  "Lee un correo completo por uid: cabeceras, cuerpo en texto y lista de adjuntos. NO descarga los adjuntos, solo los nombra y numera: para bajar uno usa mail_adjuntos con el mismo uid y el numero o el nombre. Por defecto NO marca el mensaje como leido.",
  {
    uid: z.number().int().describe("uid del mensaje, tal como lo devuelve mail_buscar"),
    carpeta: z.string().default("INBOX"),
    cuerpo_max: z.number().int().min(200).max(50000).default(6000).describe("Maximo de caracteres del cuerpo a devolver"),
    marcar_leido: z.boolean().default(false).describe("Marca el mensaje como leido al abrirlo"),
  },
  wrap(async ({ uid, carpeta, cuerpo_max, marcar_leido }) => conIMAP(async (client) =>
    enCarpeta(client, carpeta, !marcar_leido, async () => {
      const bajada = await client.download(String(uid), undefined, { uid: true });
      if (!bajada || !bajada.content) throw new Error(`No existe el mensaje uid ${uid} en ${carpeta}`);
      const msg = await simpleParser(bajada.content);
      // La estructura da el numero de parte IMAP de cada adjunto, que es lo que necesita
      // mail_adjuntos para bajar uno solo sin traerse el mensaje entero otra vez.
      const estructura = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
      const adj = adjuntosDe(estructura?.bodyStructure).map((a, i) => ({ n: i + 1, ...a }));

      if (marcar_leido) {
        await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
        bitacora({ accion: "marcar_leido", carpeta, uid });
      }

      const cuerpo = msg.text || (msg.html ? String(msg.html).replace(/<[^>]+>/g, " ") : "");
      return {
        uid,
        carpeta,
        fecha: horaCL(msg.date),
        de: msg.from?.text || null,
        para: msg.to?.text || null,
        cc: msg.cc?.text || null,
        responder_a: msg.replyTo?.text || null,
        asunto: msg.subject || "(sin asunto)",
        message_id: msg.messageId || null,
        cuerpo: recorta(cuerpo, cuerpo_max),
        tiene_html: !!msg.html,
        marcado_leido: marcar_leido,
        adjuntos: adj,
        aviso_adjuntos: adj.length
          ? "No se descargo ningun adjunto. Si el usuario los pide, llama mail_adjuntos con este uid y el n o el nombre."
          : null,
      };
    }))));

// ─────────────────────────────────────────────────────────────────────────────
// Adjuntos, solo a peticion
//
// Ni mail_buscar ni mail_leer bajan adjuntos: solo los nombran. Bajarlos siempre seria
// carisimo e inutil — la mayoria de los correos del buzon traen firmas, logos y PDF que
// nadie pidio. Esta tool es la unica que mueve bytes, y aun asi no descarga nada si no se
// le dice cual: sin 'cual' ni todos=true devuelve el listado y se detiene.
//
// El modo por defecto es "enlace": el archivo se guarda en el gateway y vuelve una URL.
// Los modos "texto", "imagen" y "base64" meten el contenido en la conversacion, asi que
// tienen topes propios mas bajos. Son para cuando hay que LEER el adjunto (el XML de una
// factura, la foto de un siniestro), no para entregarlo.
// ─────────────────────────────────────────────────────────────────────────────

const TOPE_MB = { enlace: 25, texto: 5, imagen: 3, base64: 1 };

const esTexto = (t) => /^text\//i.test(t || "") || /(json|xml|csv|html|plain)/i.test(t || "");
const esImagen = (t) => /^image\//i.test(t || "");

const recortaTexto = (s, n) => {
  const t = String(s ?? "").replace(/\r\n/g, "\n").trim();
  return t.length > n ? `${t.slice(0, n)}\n[... ${t.length - n} caracteres mas; sube texto_max o usa devolver="enlace"]` : t;
};

// Lee el flujo del adjunto cortando en seco si pasa el tope, para que un archivo grande
// no se cargue entero en memoria antes de rechazarlo.
async function aBuffer(flujo, topeBytes, nombre) {
  const trozos = [];
  let n = 0;
  for await (const t of flujo) {
    n += t.length;
    if (n > topeBytes) {
      if (typeof flujo.destroy === "function") flujo.destroy();
      throw new Error(`El adjunto "${nombre}" supera el tope de ${(topeBytes / 1048576).toFixed(1)} MB de este modo. Usa devolver="enlace" o sube max_mb.`);
    }
    trozos.push(t);
  }
  return Buffer.concat(trozos);
}

// Resuelve 'cual' contra la lista: numero de parte IMAP, nombre exacto, indice n, o
// coincidencia parcial del nombre. En ese orden, para que "2" nunca sea ambiguo.
function elegir(lista, cual) {
  const q = String(cual).trim();
  const bajo = q.toLowerCase();
  const porParte = lista.filter((a) => String(a.parte).toLowerCase() === bajo);
  if (porParte.length) return porParte;
  const exacto = lista.filter((a) => (a.nombre || "").toLowerCase() === bajo);
  if (exacto.length) return exacto;
  if (/^\d+$/.test(q)) {
    const x = lista[Number(q) - 1];
    if (x) return [x];
  }
  const parcial = lista.filter((a) => (a.nombre || "").toLowerCase().includes(bajo));
  if (parcial.length) return parcial;
  throw new Error(`Ningun adjunto coincide con "${cual}". Hay ${lista.length}: ${lista.map((a, i) => `${i + 1}=${a.nombre || a.parte}`).join(", ")}`);
}

server.tool("mail_adjuntos",
  "Descarga adjuntos de un correo, SOLO cuando el usuario lo pide. Sin 'cual' ni todos=true no descarga nada: devuelve el listado y se detiene. Por defecto entrega un enlace de descarga y no mete el archivo en la conversacion. Usa devolver='texto' o 'imagen' unicamente si hay que leer el contenido del adjunto.",
  {
    uid: z.number().int().describe("uid del mensaje, tal como lo devuelve mail_buscar o mail_leer"),
    carpeta: z.string().default("INBOX"),
    cual: z.union([z.number().int(), z.string()]).optional()
      .describe("Que adjunto bajar: el n que muestra mail_leer, su nombre de archivo, o el numero de parte IMAP. Omitelo para solo listar."),
    todos: z.boolean().default(false).describe("Baja todos los adjuntos del correo. Pidelo solo si el usuario lo pidio asi."),
    devolver: z.enum(["enlace", "texto", "imagen", "base64"]).default("enlace")
      .describe("enlace = URL de descarga (por defecto, no gasta contexto). texto = contenido de un adjunto de texto/csv/xml/json. imagen = la imagen para poder verla. base64 = bytes crudos, solo si el usuario lo pide."),
    texto_max: z.number().int().min(200).max(100000).default(8000).describe("Solo con devolver='texto': maximo de caracteres por archivo"),
    max_mb: z.number().min(0.1).max(25).default(25).describe("Tope de tamano por adjunto, en MB. Cada modo aplica ademas su propio tope mas bajo."),
  },
  async ({ uid, carpeta, cual, todos, devolver, texto_max, max_mb }) => {
    try {
      const datos = await conIMAP(async (client) =>
        enCarpeta(client, carpeta, true, async () => {
          const est = await client.fetchOne(String(uid), { bodyStructure: true, envelope: true }, { uid: true });
          if (!est) throw new Error(`No existe el mensaje uid ${uid} en ${carpeta}`);
          const lista = adjuntosDe(est.bodyStructure).map((a, i) => ({ n: i + 1, ...a }));
          const cab = {
            uid, carpeta,
            asunto: est.envelope?.subject || "(sin asunto)",
            de: dir(est.envelope?.from),
            fecha: horaCL(est.envelope?.date),
            adjuntos: lista.length,
          };

          if (!lista.length) {
            return { ...cab, descargado: false, listado: [], aviso: "Este correo no trae adjuntos." };
          }
          if (cual === undefined && !todos) {
            return {
              ...cab, descargado: false, listado: lista,
              aviso: "Solo listado: no se descargo nada. Si el usuario quiere alguno, vuelve a llamar con cual=<n o nombre>, o todos=true.",
            };
          }

          const tope = Math.min(max_mb, TOPE_MB[devolver]) * 1048576;
          const elegidos = todos ? lista : elegir(lista, cual);
          const bajados = [];
          for (const a of elegidos) {
            const bajada = await client.download(String(uid), a.parte, { uid: true });
            if (!bajada || !bajada.content) throw new Error(`No se pudo bajar la parte ${a.parte} del uid ${uid}`);
            const nombre = bajada.meta?.filename || a.nombre || `adjunto-${a.parte}`;
            const tipo = bajada.meta?.contentType || a.tipo || "application/octet-stream";
            const buffer = await aBuffer(bajada.content, tope, nombre);
            bajados.push({ n: a.n, parte: a.parte, nombre, tipo, tamano_kb: Math.round(buffer.length / 1024), bytes: buffer.length, buffer });
          }
          return { ...cab, descargado: true, bajados };
        }));

      if (!datos.descargado) return out(datos);

      const { bajados, ...cab } = datos;
      const ficha = (a) => ({ n: a.n, nombre: a.nombre, tipo: a.tipo, tamano_kb: a.tamano_kb });

      if (devolver === "imagen") {
        const malos = bajados.filter((a) => !esImagen(a.tipo));
        if (malos.length) {
          throw new Error(`devolver="imagen" sirve solo para imagenes. No lo son: ${malos.map((a) => `${a.nombre} (${a.tipo})`).join(", ")}. Usa devolver="enlace".`);
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ ...cab, modo: "imagen", archivos: bajados.map(ficha) }, null, 1) },
            ...bajados.map((a) => ({ type: "image", data: a.buffer.toString("base64"), mimeType: a.tipo })),
          ],
        };
      }

      if (devolver === "texto") {
        const malos = bajados.filter((a) => !esTexto(a.tipo));
        if (malos.length) {
          throw new Error(`devolver="texto" sirve solo para adjuntos de texto, csv, xml, json o html. No lo son: ${malos.map((a) => `${a.nombre} (${a.tipo})`).join(", ")}. Usa devolver="enlace".`);
        }
        return out({
          ...cab, modo: "texto",
          archivos: bajados.map((a) => ({ ...ficha(a), contenido: recortaTexto(a.buffer.toString("utf8"), texto_max) })),
        });
      }

      if (devolver === "base64") {
        return out({
          ...cab, modo: "base64",
          aviso: 'base64 consume mucho contexto; para entregar el archivo al usuario es mejor devolver="enlace".',
          archivos: bajados.map((a) => ({ ...ficha(a), base64: a.buffer.toString("base64") })),
        });
      }

      // enlace (por defecto)
      const archivos = bajados.map((a) => {
        const g = guardarAdjunto({ nombre: a.nombre, tipo: a.tipo, buffer: a.buffer, uid: cab.uid, carpeta: cab.carpeta });
        bitacora({ accion: "descargar_adjunto", carpeta: cab.carpeta, uid: cab.uid, nombre: a.nombre, bytes: a.bytes });
        return {
          ...ficha(a),
          enlace: enlaceDe("mail-rmg", g.token),
          vence_en_minutos: g.vence_en_minutos,
          descargas_disponibles: g.descargas_disponibles,
        };
      });
      return out({
        ...cab, modo: "enlace", archivos,
        aviso: "Entrega los enlaces tal cual al usuario. Vencen en 30 minutos y el archivo no queda guardado en el servidor.",
      });
    } catch (e) {
      return fail(e);
    }
  });

server.tool("mail_resumen",
  "Resumen de actividad del correo en un rango de fechas: cuantos llegaron, cuantos sin leer, y los remitentes y asuntos mas frecuentes. Para ver el panorama sin leer mensajes uno por uno.",
  {
    carpeta: z.string().default("INBOX"),
    desde: fechaOpt.describe("Por defecto, los ultimos 7 dias"),
    hasta: fechaOpt,
    top: z.number().int().min(1).max(50).default(10).describe("Cuantos remitentes mostrar"),
  },
  wrap(async ({ carpeta, desde, hasta, top }) => conIMAP(async (client) =>
    enCarpeta(client, carpeta, true, async (buzon) => {
      if (!desde) {
        const d = new Date(Date.now() - 7 * 86400000);
        desde = d.toLocaleDateString("en-CA", { timeZone: TZ });
      }
      const criterio = { since: aFecha(desde) };
      if (hasta) { const d = aFecha(hasta); d.setDate(d.getDate() + 1); criterio.before = d; }

      const uids = await client.search(criterio, { uid: true });
      if (!uids || !uids.length) {
        return { carpeta, periodo: { desde, hasta: hasta || null, zona: TZ }, recibidos: 0, no_leidos: 0, por_dia: {}, remitentes: [] };
      }
      let noLeidos = 0;
      const porDia = {};
      const porRemitente = new Map();
      for await (const m of client.fetch({ uid: uids.join(",") }, { uid: true, envelope: true, flags: true }, { uid: true })) {
        const dia = diaCL(m.envelope?.date) || "(sin fecha)";
        porDia[dia] = (porDia[dia] || 0) + 1;
        const leido = !!(m.flags && m.flags.has("\\Seen"));
        if (!leido) noLeidos++;
        const correo = m.envelope?.from?.[0]?.address || "(sin remitente)";
        const r = porRemitente.get(correo) || { remitente: correo, nombre: m.envelope?.from?.[0]?.name || null, mensajes: 0, no_leidos: 0, ultimo_asunto: null, ultimo_uid: 0 };
        r.mensajes++;
        if (!leido) r.no_leidos++;
        if (m.uid > r.ultimo_uid) { r.ultimo_uid = m.uid; r.ultimo_asunto = m.envelope?.subject || "(sin asunto)"; }
        porRemitente.set(correo, r);
      }
      return {
        carpeta,
        total_en_carpeta: buzon.exists,
        periodo: { desde, hasta: hasta || null, zona: TZ },
        recibidos: uids.length,
        no_leidos: noLeidos,
        por_dia: Object.fromEntries(Object.entries(porDia).sort(([a], [b]) => a.localeCompare(b))),
        remitentes: [...porRemitente.values()].sort((a, b) => b.mensajes - a.mensajes).slice(0, top),
      };
    }))));

// ─────────────────────────────────────────────────────────────────────────────
// Escritura
//
// Patron obligatorio del gateway: confirmar=false devuelve vista previa sin escribir
// nada; solo con aprobacion explicita del usuario en el turno se llama confirmar=true.
// Despues de escribir se verifica y se deja linea en la bitacora.
//
// Excepcion deliberada: mail_marcar actua directo. Cambiar una marca de leido o
// destacado es reversible y no manda nada al exterior; pedir confirmacion por cada
// mensaje haria la tool inutil en la practica.
// ─────────────────────────────────────────────────────────────────────────────

const destinatarios = {
  para: z.string().describe("Destinatario o destinatarios separados por coma"),
  cc: z.string().optional(),
  cco: z.string().optional(),
};

server.tool("mail_enviar",
  "Envia un correo nuevo desde la cuenta de RMG Autos. Con confirmar=false (por defecto) solo muestra la vista previa sin enviar nada; pide aprobacion al usuario y recien entonces llama con confirmar=true.",
  {
    ...destinatarios,
    asunto: z.string().min(1),
    cuerpo: z.string().min(1).describe("Cuerpo en texto plano"),
    responder_a: z.string().optional().describe("Reply-To distinto del remitente"),
    confirmar: z.boolean().default(false).describe("false = vista previa; true = envia de verdad"),
  },
  wrap(async ({ para, cc, cco, asunto, cuerpo, responder_a, confirmar }) => {
    const c = cfg();
    const sobre = { from: c.from, to: para, cc: cc || undefined, bcc: cco || undefined, subject: asunto, text: cuerpo, replyTo: responder_a || undefined };
    if (!confirmar) {
      return {
        vista_previa: true, enviado: false,
        aviso: "Nada se ha enviado. Muestra esto al usuario y vuelve a llamar con confirmar=true solo si lo aprueba.",
        de: c.from, para, cc: cc || null, cco: cco || null, asunto,
        cuerpo: recorta(cuerpo, 2000), caracteres_cuerpo: cuerpo.length,
      };
    }
    const info = await transporte().sendMail(sobre);
    bitacora({ accion: "enviar", para, cc: cc || null, asunto, message_id: info.messageId });
    return {
      enviado: true, verificado: !!info.messageId,
      message_id: info.messageId || null,
      aceptados: info.accepted || [], rechazados: info.rejected || [],
      respuesta_servidor: info.response || null,
      de: c.from, para, asunto,
    };
  }));

server.tool("mail_responder",
  "Responde un correo existente manteniendo el hilo (In-Reply-To y References). Con confirmar=false solo muestra la vista previa; pide aprobacion al usuario antes de llamar con confirmar=true.",
  {
    uid: z.number().int().describe("uid del mensaje a responder"),
    carpeta: z.string().default("INBOX"),
    cuerpo: z.string().min(1).describe("Tu respuesta, en texto plano"),
    responder_a_todos: z.boolean().default(false).describe("Incluye en copia a los demas destinatarios del original"),
    citar: z.boolean().default(true).describe("Adjunta el mensaje original citado al final"),
    confirmar: z.boolean().default(false),
  },
  wrap(async ({ uid, carpeta, cuerpo, responder_a_todos, citar, confirmar }) => {
    const c = cfg();
    const orig = await conIMAP(async (client) =>
      enCarpeta(client, carpeta, true, async () => {
        const bajada = await client.download(String(uid), undefined, { uid: true });
        if (!bajada || !bajada.content) throw new Error(`No existe el mensaje uid ${uid} en ${carpeta}`);
        const m = await simpleParser(bajada.content);
        return {
          de: m.replyTo?.value?.[0]?.address || m.from?.value?.[0]?.address || null,
          deTexto: m.from?.text || null,
          to: (m.to?.value || []).map((x) => x.address),
          cc: (m.cc?.value || []).map((x) => x.address),
          asunto: m.subject || "(sin asunto)",
          messageId: m.messageId || null,
          references: m.references || null,
          fecha: horaCL(m.date),
          texto: m.text || (m.html ? String(m.html).replace(/<[^>]+>/g, " ") : ""),
        };
      }));

    if (!orig.de) throw new Error(`El mensaje uid ${uid} no tiene remitente al que responder.`);

    const mio = String(c.user).toLowerCase();
    const copias = responder_a_todos
      ? [...orig.to, ...orig.cc].filter((a) => a && a.toLowerCase() !== mio && a.toLowerCase() !== String(orig.de).toLowerCase())
      : [];
    const asunto = /^re:/i.test(orig.asunto) ? orig.asunto : `Re: ${orig.asunto}`;
    const cita = citar && orig.texto
      ? `\n\nEl ${orig.fecha}, ${orig.deTexto} escribio:\n${recorta(orig.texto, 2000).split("\n").map((l) => `> ${l}`).join("\n")}`
      : "";
    const refs = [orig.references, orig.messageId].flat().filter(Boolean).join(" ") || undefined;

    if (!confirmar) {
      return {
        vista_previa: true, enviado: false,
        aviso: "Nada se ha enviado. Muestra esto al usuario y vuelve a llamar con confirmar=true solo si lo aprueba.",
        responde_a: { uid, de: orig.deTexto, asunto: orig.asunto, fecha: orig.fecha },
        de: c.from, para: orig.de, cc: copias.length ? copias.join(", ") : null, asunto,
        cuerpo: recorta(cuerpo + cita, 2500),
      };
    }
    const info = await transporte().sendMail({
      from: c.from, to: orig.de, cc: copias.length ? copias.join(", ") : undefined,
      subject: asunto, text: cuerpo + cita,
      inReplyTo: orig.messageId || undefined, references: refs,
    });
    // Marcar el original como respondido, para que Roundcube lo muestre igual que si
    // se hubiera respondido desde la web.
    await conIMAP(async (client) =>
      enCarpeta(client, carpeta, false, () =>
        client.messageFlagsAdd({ uid: String(uid) }, ["\\Answered", "\\Seen"], { uid: true }))).catch(() => null);

    bitacora({ accion: "responder", carpeta, uid, para: orig.de, asunto, message_id: info.messageId });
    return {
      enviado: true, verificado: !!info.messageId,
      message_id: info.messageId || null,
      aceptados: info.accepted || [], rechazados: info.rejected || [],
      respondido_a: { uid, de: orig.de, asunto: orig.asunto },
      asunto, cc: copias,
    };
  }));

server.tool("mail_marcar",
  "Marca mensajes como leidos, no leidos, destacados o sin destacar. Reversible: actua de inmediato, sin confirmacion.",
  {
    uids: z.array(z.number().int()).min(1).max(200).describe("uids de los mensajes"),
    carpeta: z.string().default("INBOX"),
    marca: z.enum(["leido", "no_leido", "destacado", "sin_destacar"]),
  },
  wrap(async ({ uids, carpeta, marca }) => conIMAP(async (client) =>
    enCarpeta(client, carpeta, false, async () => {
      const lista = uids.join(",");
      const bandera = marca === "leido" || marca === "no_leido" ? "\\Seen" : "\\Flagged";
      const agregar = marca === "leido" || marca === "destacado";
      const ok = agregar
        ? await client.messageFlagsAdd({ uid: lista }, [bandera], { uid: true })
        : await client.messageFlagsRemove({ uid: lista }, [bandera], { uid: true });
      bitacora({ accion: "marcar", carpeta, uids, marca });
      return { carpeta, marca, mensajes: uids.length, aplicado: !!ok };
    }))));

server.tool("mail_mover",
  "Mueve mensajes a otra carpeta, incluida la papelera. Con confirmar=false solo muestra que se movera; pide aprobacion antes de llamar con confirmar=true. No borra en forma definitiva: mover a la papelera es recuperable.",
  {
    uids: z.array(z.number().int()).min(1).max(200),
    carpeta: z.string().default("INBOX").describe("Carpeta de origen"),
    destino: z.string().describe("Carpeta de destino, o la palabra 'papelera' para la papelera de la cuenta"),
    confirmar: z.boolean().default(false),
  },
  wrap(async ({ uids, carpeta, destino, confirmar }) => conIMAP(async (client) => {
    const esp = await especiales(client);
    const dest = destino.toLowerCase() === "papelera" ? esp.papelera : destino;
    if (!esp.todas.includes(dest)) {
      throw new Error(`La carpeta de destino "${dest}" no existe. Carpetas: ${esp.todas.join(", ")}`);
    }
    return enCarpeta(client, carpeta, !confirmar, async () => {
      const lista = uids.join(",");
      const previa = [];
      for await (const m of client.fetch({ uid: lista }, { uid: true, envelope: true }, { uid: true })) {
        previa.push({ uid: m.uid, fecha: horaCL(m.envelope?.date), de: dir(m.envelope?.from), asunto: m.envelope?.subject || "(sin asunto)" });
      }
      if (!previa.length) throw new Error(`Ninguno de esos uid existe en ${carpeta}`);

      if (!confirmar) {
        return {
          vista_previa: true, movido: false,
          aviso: "Nada se ha movido. Muestra esto al usuario y vuelve a llamar con confirmar=true solo si lo aprueba.",
          origen: carpeta, destino: dest, mensajes: previa.length, detalle: previa,
        };
      }
      const r = await client.messageMove({ uid: lista }, dest, { uid: true });
      bitacora({ accion: "mover", origen: carpeta, destino: dest, uids });
      const quedan = await client.search({ uid: lista }, { uid: true });
      return {
        movido: true, verificado: !quedan || quedan.length === 0,
        origen: carpeta, destino: dest, mensajes: previa.length,
        uids_destino: r && r.uidMap ? Object.values(r.uidMap) : null,
        detalle: previa,
      };
    });
  })));

  return server;
}
