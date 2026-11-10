# erp-mcp — Conector MCP del ERP RMG Autos (solo lectura)

Carpeta aislada dentro de FunnelOS. No usa `/var/data`, no comparte estado ni dependencias con FunnelOS.

- Montaje: una línea en `server.js` → `app.use('/erp-mcp', require('./erp-mcp')())`, protegida con try/catch.
- Dependencias propias: Render las instala con el Build Command
  `npm install && npm install --prefix erp-mcp --omit=dev`.
- Variables de entorno (Render → Environment): `ERP_USER`, `ERP_PASS`, `MCP_SECRET` (≥32 caracteres).
  Sin ellas el conector responde 503 y FunnelOS sigue igual.
- Rutas: `GET /erp-mcp/health` (estado) y `POST /erp-mcp` (protocolo MCP, requiere `Authorization: Bearer <MCP_SECRET>`).
- Solo lectura: cualquier acción del ERP que no empiece con `get` queda bloqueada en `erp-client.js`.

Conector en claude.ai: Customize → Connectors → + Add → Add custom connector →
URL `https://<servicio>.onrender.com/erp-mcp`, "No sign in", Request header `Authorization: Bearer <MCP_SECRET>`.
