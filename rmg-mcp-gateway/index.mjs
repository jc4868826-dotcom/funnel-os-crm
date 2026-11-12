// Gateway MCP de RMG — expone los mismos conectores que corren en el Mac, pero por HTTPS,
// para que funcionen tambien desde el telefono y en modo voz.
//
//   GET  /health                 estado de cada conector (sin secretos)
//   POST /erp-parts              ERP RMG Parts    (lectura + escrituras ya permitidas en el conector)
//   POST /funnelos               CRM FunnelOS     (solo lectura)
//   POST /erp-rmg                ERP RMG Autos    (solo lectura)
//
// Cada ruta exige su propio secreto: Authorization: Bearer <SECRETO>  (o X-Api-Key).
// Un conector sin sus variables configuradas no se monta y responde 503.
import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = express();
app.use(express.json({ limit: '4mb' }));
app.set('trust proxy', true);

const hay = (...vars) => vars.every((v) => Boolean(process.env[v]));

// Definicion de los conectores. `credenciales` son las variables que el conector original
// ya leia en el Mac: se mantienen con el mismo nombre para no cambiar su codigo.
const CONECTORES = [
  {
    ruta: 'erp-parts',
    titulo: 'ERP RMG Parts',
    secreto: 'MCP_SECRET_PARTS',
    credenciales: ['PARTS_USER', 'PARTS_PASS'],
    cargar: () => import('./conectores/erp-parts.mjs'),
  },
  {
    ruta: 'funnelos',
    titulo: 'CRM FunnelOS',
    secreto: 'MCP_SECRET_FUNNELOS',
    credenciales: ['FUNNELOS_USER', 'FUNNELOS_PASS'],
    cargar: () => import('./conectores/funnelos.mjs'),
  },
  {
    ruta: 'erp-rmg',
    titulo: 'ERP RMG Autos',
    secreto: 'MCP_SECRET_RMG',
    credenciales: ['ERP_USER', 'ERP_PASS'],
    cargar: () => import('./conectores/erp-rmg/tools.js'),
  },
];

const iguales = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function autorizado(req, secreto) {
  const cabecera = String(req.headers.authorization || '');
  const bearer = cabecera.toLowerCase().startsWith('bearer ') ? cabecera.slice(7).trim() : '';
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  return Boolean((bearer && iguales(bearer, secreto)) || (apiKey && iguales(apiKey, secreto)));
}

const rpcError = (res, code, message) =>
  res.status(code).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

const estado = (c) => {
  const secreto = process.env[c.secreto] || '';
  if (secreto.length < 32) return { listo: false, motivo: `falta ${c.secreto} (minimo 32 caracteres)` };
  if (!hay(...c.credenciales)) return { listo: false, motivo: `faltan ${c.credenciales.join(', ')}` };
  return { listo: true };
};

for (const c of CONECTORES) {
  // Cache del modulo: se importa una vez, pero se crea un McpServer nuevo por peticion
  // (modo sin estado, igual que el conector /erp-mcp que ya corre en produccion).
  let modulo = null;
  const cargar = () => (modulo ||= c.cargar());

  app.get(`/${c.ruta}/health`, (req, res) => res.json({ conector: c.ruta, titulo: c.titulo, ...estado(c) }));

  app.post(`/${c.ruta}`, async (req, res) => {
    const st = estado(c);
    if (!st.listo) return rpcError(res, 503, `${c.titulo} sin configurar: ${st.motivo}`);
    if (!autorizado(req, process.env[c.secreto])) return rpcError(res, 401, 'No autorizado');

    try {
      const { createServer } = await cargar();
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      modulo = null; // permite reintentar la carga en la proxima peticion
      console.error(`[${c.ruta}]`, e.message);
      if (!res.headersSent) rpcError(res, 500, `Error en ${c.titulo}: ${e.message}`);
    }
  });

  // Metodos distintos de POST en la ruta del conector.
  app.all(`/${c.ruta}`, (req, res) => rpcError(res, 405, 'Metodo no permitido'));
}

app.get('/health', (req, res) =>
  res.json({
    ok: true,
    servicio: 'rmg-mcp-gateway',
    conectores: Object.fromEntries(CONECTORES.map((c) => [c.ruta, estado(c)])),
  }),
);

app.get('/', (req, res) =>
  res.json({ servicio: 'rmg-mcp-gateway', rutas: CONECTORES.map((c) => `/${c.ruta}`) }),
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[rmg-mcp-gateway] escuchando en :${PORT}`);
  for (const c of CONECTORES) {
    const st = estado(c);
    console.log(`  /${c.ruta.padEnd(10)} ${st.listo ? 'listo' : 'SIN CONFIGURAR — ' + st.motivo}`);
  }
});
