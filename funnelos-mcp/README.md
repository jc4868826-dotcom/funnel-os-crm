# funnelos-mcp — Conector MCP de FunnelOS (solo lectura)

Carpeta aislada dentro de FunnelOS, igual que `erp-mcp/`. Solo hace GET a la propia API de FunnelOS por loopback.

- Montaje: una línea en `server.js`, junto a la de `/erp-mcp`:
  `try{app.use('/funnelos-mcp',require('./funnelos-mcp')());console.log('[FUNNELOS-MCP] montado');}catch(e){console.error('[FUNNELOS-MCP] no montado:',e.message);}`
- Build Command de Render:
  `npm install && npm install --prefix erp-mcp --omit=dev && npm install --prefix funnelos-mcp --omit=dev`
- Variables (Render → Environment): `FUNNEL_MCP_SECRET` (≥32 car.), `FUNNEL_MCP_USER`, `FUNNEL_MCP_PASS`, `FUNNEL_MCP_TENANT` (si aplica).
  Usar un usuario dedicado con rol **supervisor** (ve KPIs, equipo y canales; el conector no escribe).
- Rutas: `GET /funnelos-mcp/health` y `POST /funnelos-mcp` (Bearer `FUNNEL_MCP_SECRET`).
- claude.ai → Configuración → Conectores → conector personalizado → URL `https://<servicio>.onrender.com/funnelos-mcp`, sin OAuth, header `Authorization: Bearer <FUNNEL_MCP_SECRET>`.
- Ojo: los chats de leads traen datos personales de clientes.
