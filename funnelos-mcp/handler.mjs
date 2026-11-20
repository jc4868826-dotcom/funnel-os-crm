// Manejador HTTP del conector MCP de FunnelOS (Streamable HTTP, sin estado).
// Montado en /funnelos-mcp:  GET /funnelos-mcp/health  y  POST /funnelos-mcp  (protocolo MCP).
// Variables de entorno: FUNNEL_MCP_SECRET (≥32 car.), FUNNEL_MCP_USER, FUNNEL_MCP_PASS, FUNNEL_MCP_TENANT (opcional).
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './tools.js';

const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
};
const rpcError = (res, code, message) => json(res, code, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });

const iguales = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Acepta "Authorization: Bearer <FUNNEL_MCP_SECRET>" o "X-API-Key: <FUNNEL_MCP_SECRET>".
function autorizado(req, secret) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  return Boolean((bearer && iguales(bearer, secret)) || (apiKey && iguales(apiKey, secret)));
}

export default async function handler(req, res) {
  const ruta = (req.path || req.url || '/').split('?')[0];
  const secret = process.env.FUNNEL_MCP_SECRET || '';
  const configurado = secret.length >= 32 && Boolean(process.env.FUNNEL_MCP_USER) && Boolean(process.env.FUNNEL_MCP_PASS);

  if (req.method === 'GET' && ruta === '/health') return json(res, 200, { ok: true, configurado });
  if (ruta !== '/' && ruta !== '') return json(res, 404, { error: 'No encontrado' });
  if (!configurado) return rpcError(res, 503, 'FUNNELOS-MCP sin configurar (FUNNEL_MCP_SECRET, FUNNEL_MCP_USER, FUNNEL_MCP_PASS)');
  if (!autorizado(req, secret)) return rpcError(res, 401, 'No autorizado');
  if (req.method !== 'POST') return rpcError(res, 405, 'Método no permitido');

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
