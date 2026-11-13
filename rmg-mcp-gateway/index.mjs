// Gateway MCP de RMG — expone los mismos conectores que corren en el Mac, pero por HTTPS,
// para que funcionen tambien desde el telefono y en modo voz.
//
//   GET  /health                 estado de cada conector e identidades configuradas
//   POST /erp-parts              ERP RMG Parts    (lectura + escrituras del conector)
//   POST /funnelos               CRM FunnelOS     (solo lectura)
//   POST /erp-rmg                ERP RMG Autos
//
// IDENTIDADES
// Cada ruta acepta varios secretos, y cada secreto entra al sistema con SUS PROPIAS
// credenciales. Asi cada persona usa su usuario del ERP, con sus permisos, y se le puede
// revocar el acceso sin tocar el de los demas.
//
//   MCP_SECRET_PARTS        -> PARTS_USER        / PARTS_PASS          (identidad por defecto)
//   MCP_SECRET_PARTS_RAUL   -> PARTS_USER_RAUL   / PARTS_PASS_RAUL     (identidad "raul")
//   MCP_SECRET_RMG_RAUL     -> ERP_USER_RAUL     / ERP_PASS_RAUL
//   ...y asi para cualquier nombre: el sufijo del secreto es el nombre de la identidad.
//
// Una identidad con nombre NO hereda las credenciales de la identidad por defecto: si le
// faltan, no se monta. Es deliberado — evita que alguien entre con el usuario de otro.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// ─────────────────────────────────────────────────────────────────────────────
// Credenciales por peticion.
// Los conectores leen sus credenciales de process.env tal como lo hacian en el Mac:
// unos al construirse y otros recien al hacer login. Para no tocar su codigo, process.env
// se envuelve en un Proxy que, dentro de una peticion, devuelve las credenciales de la
// identidad que la autentico. Fuera de una peticion se comporta como siempre.
// ─────────────────────────────────────────────────────────────────────────────
const contexto = new AsyncLocalStorage();
const entornoReal = process.env;
process.env = new Proxy(entornoReal, {
  get(destino, clave) {
    const sobreescritas = contexto.getStore();
    if (sobreescritas && typeof clave === 'string' && clave in sobreescritas) return sobreescritas[clave];
    return destino[clave];
  },
  has(destino, clave) {
    const sobreescritas = contexto.getStore();
    if (sobreescritas && typeof clave === 'string' && clave in sobreescritas) return true;
    return clave in destino;
  },
});

const app = express();
app.use(express.json({ limit: '4mb' }));
app.set('trust proxy', true);

const CONECTORES = [
  {
    ruta: 'erp-parts',
    titulo: 'ERP RMG Parts',
    prefijoSecreto: 'MCP_SECRET_PARTS',
    credenciales: { obligatorias: ['PARTS_USER', 'PARTS_PASS'], opcionales: ['PARTS_URL'] },
    cargar: () => import('./conectores/erp-parts.mjs'),
  },
  {
    ruta: 'funnelos',
    titulo: 'CRM FunnelOS',
    prefijoSecreto: 'MCP_SECRET_FUNNELOS',
    credenciales: { obligatorias: ['FUNNELOS_USER', 'FUNNELOS_PASS'], opcionales: ['FUNNELOS_TENANT', 'FUNNELOS_URL'] },
    cargar: () => import('./conectores/funnelos.mjs'),
  },
  {
    ruta: 'erp-rmg',
    titulo: 'ERP RMG Autos',
    prefijoSecreto: 'MCP_SECRET_RMG',
    credenciales: { obligatorias: ['ERP_USER', 'ERP_PASS'], opcionales: ['ERP_BASE_URL', 'ERP_LOGIN_URL'] },
    cargar: () => import('./conectores/erp-rmg/tools.js'),
  },
];

// Lee del entorno real todas las identidades de una ruta: la por defecto (sin sufijo)
// y las nombradas (MCP_SECRET_<PREFIJO>_<NOMBRE>).
function identidades(c) {
  const encontradas = [];
  for (const clave of Object.keys(entornoReal)) {
    if (clave !== c.prefijoSecreto && !clave.startsWith(`${c.prefijoSecreto}_`)) continue;
    const sufijo = clave === c.prefijoSecreto ? '' : clave.slice(c.prefijoSecreto.length + 1);
    const nombre = sufijo ? sufijo.toLowerCase() : 'principal';
    const secreto = entornoReal[clave] || '';
    const varDe = (base) => (sufijo ? `${base}_${sufijo}` : base);

    const faltantes = c.credenciales.obligatorias.filter((b) => !entornoReal[varDe(b)]);
    if (secreto.length < 32) {
      encontradas.push({ nombre, listo: false, motivo: `${clave} debe tener al menos 32 caracteres` });
      continue;
    }
    if (faltantes.length) {
      encontradas.push({ nombre, listo: false, motivo: `faltan ${faltantes.map(varDe).join(', ')}` });
      continue;
    }
    // Credenciales que veran los conectores cuando responda esta identidad.
    const entorno = {};
    for (const base of [...c.credenciales.obligatorias, ...c.credenciales.opcionales]) {
      const valor = entornoReal[varDe(base)];
      if (valor !== undefined) entorno[base] = valor;
    }
    encontradas.push({ nombre, listo: true, secreto, entorno });
  }
  return encontradas.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

const iguales = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Devuelve la identidad cuyo secreto coincide, comparando contra todas para no filtrar
// por tiempo cual existe.
function autenticar(req, lista) {
  const cabecera = String(req.headers.authorization || '');
  const bearer = cabecera.toLowerCase().startsWith('bearer ') ? cabecera.slice(7).trim() : '';
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  const entregado = bearer || apiKey;
  if (!entregado) return null;
  let encontrada = null;
  for (const id of lista) {
    if (id.listo && iguales(entregado, id.secreto)) encontrada = id;
  }
  return encontrada;
}

const rpcError = (res, code, message) =>
  res.status(code).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

// Estado publico: nombres de identidades y si estan listas. Nunca secretos ni usuarios.
const estado = (c) => {
  const lista = identidades(c);
  if (!lista.length) return { listo: false, motivo: `no hay ningun ${c.prefijoSecreto} configurado`, identidades: [] };
  const listas = lista.filter((i) => i.listo);
  return {
    listo: listas.length > 0,
    identidades: lista.map(({ nombre, listo, motivo }) => (listo ? { nombre, listo } : { nombre, listo, motivo })),
  };
};

for (const c of CONECTORES) {
  let modulo = null;
  const cargar = () => (modulo ||= c.cargar());

  app.get(`/${c.ruta}/health`, (req, res) => res.json({ conector: c.ruta, titulo: c.titulo, ...estado(c) }));

  app.post(`/${c.ruta}`, async (req, res) => {
    const lista = identidades(c);
    if (!lista.some((i) => i.listo)) return rpcError(res, 503, `${c.titulo} sin configurar`);

    const identidad = autenticar(req, lista);
    if (!identidad) return rpcError(res, 401, 'No autorizado');

    try {
      const { createServer } = await cargar();
      // Todo el manejo de la peticion corre con las credenciales de esta identidad.
      await contexto.run(identidad.entorno, async () => {
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (e) {
      modulo = null;
      console.error(`[${c.ruta}] identidad=${identidad.nombre}:`, e.message);
      if (!res.headersSent) rpcError(res, 500, `Error en ${c.titulo}: ${e.message}`);
    }
  });

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
    const detalle = st.identidades.map((i) => (i.listo ? i.nombre : `${i.nombre} (${i.motivo})`)).join(', ');
    console.log(`  /${c.ruta.padEnd(10)} ${st.listo ? 'listo' : 'SIN CONFIGURAR'} — identidades: ${detalle || 'ninguna'}`);
  }
});
