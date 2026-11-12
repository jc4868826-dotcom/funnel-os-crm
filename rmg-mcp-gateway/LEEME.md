# rmg-mcp-gateway — tus conectores MCP por URL (teléfono y modo voz)

Publica **los mismos conectores que corren en tu Mac**, pero por HTTPS, para que Claude
los vea también desde el teléfono y en modo voz. No reemplaza nada: los locales siguen
funcionando igual.

| Ruta | Conector | Herramientas | Sistema al que llama |
|---|---|---|---|
| `/erp-parts` | ERP RMG Parts | 25 | https://rmg-parts-erp.onrender.com |
| `/funnelos` | CRM FunnelOS | 7 | https://body-elite-giftcards.onrender.com |
| `/erp-rmg` | ERP RMG Autos | 16 | https://gestion.rmgautos.cl |

**Cotizador MP no está aquí**: su conector lee SQLite, Excel y Python locales
(`data/oportunidades.db`, `data/precios.xlsx`, `.venv/bin/python`). Para publicarlo hay que
migrar esos datos a la nube primero — es un proyecto aparte, no un cambio de transporte.

## De dónde sale el código

Los conectores no se reescribieron. `herramientas/envolver.mjs` toma el archivo del
conector local, le quita el transporte stdio y envuelve el resto en `createServer()`.
Nada más cambia: mismas herramientas, misma lógica, mismos nombres.

Cuando cambies un conector en el Mac, regenera su copia:

```
cd "/Users/juancarloscontreras/Desktop/negocio sistemas/rmg-mcp-gateway"
node herramientas/envolver.mjs ~/erp-parts-mcp/server.js  conectores/erp-parts.mjs
node herramientas/envolver.mjs ~/funnelos-mcp/server.mjs  conectores/funnelos.mjs
cp ~/Downloads/rmg-erp-mcp/{tools.js,erp-client.js,erp-config.json,analisis.js} conectores/erp-rmg/
```

`erp-rmg` ya exportaba `createServer()`, así que se copia tal cual, sin transformar.

## Paso 1 — subir al repo

```
cd "/Users/juancarloscontreras/Desktop/negocio sistemas"
git add rmg-mcp-gateway
git commit -m "feat: gateway MCP para usar los conectores desde telefono y voz"
git push
```

No toca `server.js`, `bot.json` ni nada de FunnelOS. Es una carpeta nueva e independiente.

## Paso 2 — crear el servicio en Render

Render → New → Web Service → repo `bodyelite/funnel-os-crm`:

| Campo | Valor |
|---|---|
| Name | `rmg-mcp-gateway` |
| **Root Directory** | `rmg-mcp-gateway` |
| Build Command | `npm install` |
| Start Command | `node index.mjs` |

El **Root Directory** es lo que hace que este servicio sea independiente del de FunnelOS,
aunque vivan en el mismo repo. El servicio actual de FunnelOS no se toca.

## Paso 3 — variables de entorno en Render

Tres secretos (mínimo 32 caracteres cada uno, distintos entre sí) y las credenciales que
ya usan tus conectores locales. Las credenciales están en tu Mac, en
`~/Library/Application Support/Claude/claude_desktop_config.json`, dentro de cada conector.

| Variable | Qué va |
|---|---|
| `MCP_SECRET_PARTS` | secreto para la ruta `/erp-parts` |
| `MCP_SECRET_FUNNELOS` | secreto para la ruta `/funnelos` |
| `MCP_SECRET_RMG` | secreto para la ruta `/erp-rmg` |
| `PARTS_USER` / `PARTS_PASS` | tu usuario del ERP de RMG Parts |
| `FUNNELOS_USER` / `FUNNELOS_PASS` | usuario de FunnelOS |
| `FUNNELOS_TENANT` | opcional, por defecto `demo_automotora` |
| `ERP_USER` / `ERP_PASS` | usuario del ERP de Autos (Clauderaul) |

Las URL de los tres sistemas ya vienen por defecto en el código; solo defínelas
(`PARTS_URL`, `FUNNELOS_URL`, `ERP_BASE_URL`) si alguna cambia.

Para generar los secretos:

```
node -e "for(const n of ['PARTS','FUNNELOS','RMG'])console.log('MCP_SECRET_'+n+'='+require('crypto').randomBytes(32).toString('hex'))"
```

Un conector sin sus variables no se monta: responde 503 y los otros siguen funcionando.
`GET /health` muestra cuál quedó listo y cuál no, sin exponer secretos.

## Paso 4 — registrar los conectores en claude.ai

Configuración → Conectores → Agregar conector personalizado. Uno por ruta:

| Nombre | URL | Header |
|---|---|---|
| ERP RMG Parts | `https://rmg-mcp-gateway.onrender.com/erp-parts` | `Authorization: Bearer <MCP_SECRET_PARTS>` |
| CRM FunnelOS | `https://rmg-mcp-gateway.onrender.com/funnelos` | `Authorization: Bearer <MCP_SECRET_FUNNELOS>` |
| ERP RMG Autos | `https://rmg-mcp-gateway.onrender.com/erp-rmg` | `Authorization: Bearer <MCP_SECRET_RMG>` |

Sin OAuth ("No sign in"). Desde ahí quedan disponibles en el teléfono, en voz y en la web.

Ojo: ya tienes un conector llamado **"ERP RMG"** registrado (hoy en `needs_reconnect`),
que apunta a la ruta `/erp-mcp` del servicio de FunnelOS. Cuando `/erp-rmg` de este
gateway funcione, conviene borrar el viejo para no tener dos conectores del mismo ERP.

## Pendiente conocido de `/erp-rmg`

El firewall de `gestion.rmgautos.cl` responde **403 a las IPs de Render**. El conector de
Autos va a desplegarse bien, pero fallará al llamar al ERP hasta que Carcasson libere esas
IPs. Las IP de salida estáticas aparecen en Render → el servicio → Connect → Outbound.
Los otros dos conectores no dependen de eso.

## Notas

- Modo sin estado: se crea un `McpServer` nuevo por petición, igual que el conector
  `/erp-mcp` que ya corre en producción.
- Cada ruta valida solo su propio secreto, con comparación de tiempo constante. El token
  de una ruta no sirve en otra.
- `erp-parts` escribe una bitácora local (`bitacora_escrituras.jsonl`). En Render el disco
  es efímero, así que esa bitácora se pierde en cada reinicio. La escritura va en
  `try/catch` y no bloquea ninguna operación; si la quieres persistente, hay que montar un
  disco o mandarla al ERP.
- `erp-parts` y `erp-rmg` incluyen herramientas de escritura (caja, cotizaciones, OC).
  Trata `MCP_SECRET_PARTS` y `MCP_SECRET_RMG` como claves de producción.
