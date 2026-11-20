// Punto de montaje del conector FunnelOS dentro de FunnelOS (CommonJS → carga el módulo ESM bajo demanda).
// Aislamiento: si algo falla aquí responde 503 y FunnelOS sigue igual.
module.exports = function funnelosMcp() {
  let cargando = null;
  const cargar = () => (cargando ||= import('./handler.mjs').then((m) => m.default));

  return async function funnelosMcpMiddleware(req, res) {
    try {
      const handler = await cargar();
      await handler(req, res);
    } catch (e) {
      cargando = null;
      console.error('[FUNNELOS-MCP]', e.message);
      if (!res.headersSent) res.status(503).json({ error: 'FUNNELOS-MCP no disponible' });
    }
  };
};
