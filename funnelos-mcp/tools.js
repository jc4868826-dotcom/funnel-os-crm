import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { get } from './funnel-client.js';

// Servidor MCP con las herramientas de FunnelOS (solo lectura).
export function createServer() {
  const server = new McpServer({ name: 'funnelos-rmg-autos', version: '0.1.0' });

  const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] });
  const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] });
  const tool = (name, description, shape, fn) =>
    server.tool(name, description, shape, async (args) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail(e);
      }
    });

  const rango = {
    desde: z.string().optional().describe('Fecha inicio (el mismo formato que usa el portal, p. ej. AAAA-MM-DD)'),
    hasta: z.string().optional().describe('Fecha fin (mismo formato)'),
  };
  const limiteSchema = z.number().int().min(1).max(200).default(50).describe('Máximo de filas (1-200)');

  // Quita los arreglos pesados (chat y notas) y deja solo sus conteos.
  const liviano = (l) => {
    const { chatHistory, notes, ...resto } = l;
    return { ...resto, n_mensajes: Array.isArray(chatHistory) ? chatHistory.length : 0, n_notas: Array.isArray(notes) ? notes.length : 0 };
  };

  tool(
    'funnelos_leads',
    'Lista leads del CRM FunnelOS (sin chat ni notas completas). Filtros: estado (Nuevo, Contactado, Calificado, Agendado, Negociación, Seguimiento, Cerrado…), vendedor (username), texto libre y rango de fechas. modo=gestion trae leads con actividad en el rango en vez de creados en el rango.',
    {
      estado: z.string().optional(),
      vendedor: z.string().optional().describe('username del vendedor asignado'),
      texto: z.string().optional().describe('Texto parcial a buscar en los campos del lead'),
      modo: z.enum(['creados', 'gestion']).default('creados'),
      ...rango,
      limite: limiteSchema,
    },
    async ({ estado, vendedor, texto, modo, desde, hasta, limite }) => {
      let leads = await get('/api/leads', { start: desde, end: hasta, seller: vendedor, mode: modo === 'gestion' ? 'gestion' : undefined });
      if (estado) leads = leads.filter((l) => String(l.status).toLowerCase() === estado.toLowerCase());
      if (texto) {
        const t = texto.toLowerCase();
        leads = leads.filter((l) => JSON.stringify({ ...l, chatHistory: undefined, notes: undefined }).toLowerCase().includes(t));
      }
      return { total: leads.length, mostrando: Math.min(limite, leads.length), leads: leads.slice(0, limite).map(liviano) };
    },
  );

  tool(
    'funnelos_lead_detalle',
    'Detalle de un lead por id: todos los campos, notas y los últimos mensajes del chat.',
    { id: z.union([z.string(), z.number()]), ultimos_mensajes: z.number().int().min(0).max(100).default(15) },
    async ({ id, ultimos_mensajes }) => {
      const l = await get(`/api/leads/${encodeURIComponent(String(id))}`);
      const chat = Array.isArray(l.chatHistory) ? l.chatHistory : [];
      return { ...l, chatHistory: chat.slice(-ultimos_mensajes), total_mensajes: chat.length };
    },
  );

  tool(
    'funnelos_leads_resumen',
    'KPIs generales del CRM: total, activos, cerrados, calificados, sin leer y semáforo SLA (fresh/risk/critical). Requiere usuario admin o supervisor.',
    { ...rango },
    async ({ desde, hasta }) => get('/api/dashboard/kpis', { start: desde, end: hasta }),
  );

  tool(
    'funnelos_embudo',
    'Embudo / pipeline de ventas del CRM por etapa, con rango de fechas opcional.',
    { ...rango },
    async ({ desde, hasta }) => get('/api/pipeline', { start: desde, end: hasta }),
  );

  tool(
    'funnelos_equipo',
    'Desempeño por vendedor: leads, cerrados, conversión, tiempo medio de respuesta y SLA. Requiere usuario admin o supervisor.',
    { ...rango },
    async ({ desde, hasta }) => get('/api/dashboard/team', { start: desde, end: hasta }),
  );

  tool(
    'funnelos_analytics_canales',
    'Analítica por canal de origen de los leads (opcionalmente filtrada por vendedor). Requiere usuario admin o supervisor.',
    { vendedor: z.string().optional(), ...rango },
    async ({ vendedor, desde, hasta }) => get('/api/analytics/channels', { start: desde, end: hasta, seller: vendedor }),
  );

  return server;
}
