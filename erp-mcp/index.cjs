// Punto de montaje del conector ERP dentro de FunnelOS (CommonJS → carga el módulo ESM bajo demanda).
// Aislamiento: no toca /var/data ni el estado de FunnelOS. Si algo falla aquí, responde 503 y FunnelOS sigue igual.
module.exports = function erpMcp() {
  let cargando = null;
  const cargar = () => (cargando ||= import('./handler.mjs').then((m) => m.default));

  return async function erpMcpMiddleware(req, res) {
    try {
      const handler = await cargar();
      await handler(req, res);
    } catch (e) {
      cargando = null; // permite reintentar la carga en la próxima petición
      console.error('[ERP-MCP]', e.message);
      if (!res.headersSent) res.status(503).json({ error: 'ERP-MCP no disponible' });
    }
  };
};
