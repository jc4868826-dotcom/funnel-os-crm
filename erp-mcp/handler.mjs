// Manejador HTTP del conector MCP del ERP (Streamable HTTP, sin estado).
// Montado por FunnelOS en /erp-mcp:  GET /erp-mcp/health  y  POST /erp-mcp  (protocolo MCP).
// Variables de entorno propias: ERP_USER, ERP_PASS, MCP_SECRET (≥32 caracteres).
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

// Acepta "Authorization: Bearer <MCP_SECRET>" o "X-API-Key: <MCP_SECRET>".
function autorizado(req, secret) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  return Boolean((bearer && iguales(bearer, secret)) || (apiKey && iguales(apiKey, secret)));
}

export default async function handler(req, res) {
  const ruta = (req.path || req.url || '/').split('?')[0];
  const secret = process.env.MCP_SECRET || '';
  const configurado = secret.length >= 32 && Boolean(process.env.ERP_USER) && Boolean(process.env.ERP_PASS);

  if (req.method === 'GET' && ruta === '/health') return json(res, 200, { ok: true, configurado });
  if (ruta !== '/' && ruta !== '') return json(res, 404, { error: 'No encontrado' });
  if (!configurado) return rpcError(res, 503, 'ERP-MCP sin configurar (ERP_USER, ERP_PASS, MCP_SECRET)');
  if (!autorizado(req, secret)) return rpcError(res, 401, 'No autorizado');
  if (req.method !== 'POST') return rpcError(res, 405, 'Método no permitido');

  // Modo sin estado: un servidor y un transporte por petición.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  // FunnelOS ya parsea JSON con express.json(); se pasa ese cuerpo al transporte.
  await transport.handleRequest(req, res, req.body);
}
