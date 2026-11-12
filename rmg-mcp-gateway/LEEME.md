# rmg-mcp-gateway — tus conectores MCP por URL (teléfono, voz, y para el equipo)

Publica **los mismos conectores que corren en el Mac**, pero por HTTPS, para que Claude
los vea desde cualquier parte. En producción desde el 12-11-2026.

URL base: `https://rmg-mcp-gateway.onrender.com`

| Ruta | Conector | Herramientas | Sistema al que llama |
|---|---|---|---|
| `/erp-parts` | ERP RMG Parts | 25 | https://rmg-parts-erp.onrender.com |
| `/funnelos` | CRM FunnelOS | 7 | https://body-elite-giftcards.onrender.com |
| `/erp-rmg` | ERP RMG Autos | 16 | https://gestion.rmgautos.cl |

**Cotizador MP no está aquí**: su conector lee SQLite, Excel y Python locales
(`data/oportunidades.db`, `data/precios.xlsx`, `.venv/bin/python`). Publicarlo exige migrar
esos datos a la nube — proyecto aparte, no un cambio de transporte.

## Identidades: cada persona con su propio usuario

Cada ruta acepta **varios secretos**, y cada secreto entra al sistema con **sus propias
credenciales**. Así cada persona usa su usuario del ERP, con sus permisos, y se le puede
revocar el acceso sin tocar el de los demás.

El nombre de la identidad es el sufijo del secreto:

```
MCP_SECRET_PARTS            →  PARTS_USER        / PARTS_PASS         (identidad "principal")
MCP_SECRET_PARTS_RAUL       →  PARTS_USER_RAUL   / PARTS_PASS_RAUL    (identidad "raul")
MCP_SECRET_FUNNELOS_RAUL    →  FUNNELOS_USER_RAUL / FUNNELOS_PASS_RAUL
MCP_SECRET_RMG_RAUL         →  ERP_USER_RAUL     / ERP_PASS_RAUL
```

Una identidad con nombre **no hereda** las credenciales de la principal: si le faltan, no
se monta. Es deliberado — evita que alguien entre con el usuario de otro por un olvido.

Variables opcionales por identidad: `PARTS_URL`, `FUNNELOS_URL`, `FUNNELOS_TENANT`,
`ERP_BASE_URL`, `ERP_LOGIN_URL`, con el mismo sufijo.

`GET /health` lista los nombres de las identidades y cuáles están listas. Nunca muestra
secretos ni usuarios.

### Para sumar a alguien al equipo

1. Crear su usuario en el ERP que corresponda, con los permisos que deba tener.
2. En Render, agregar `MCP_SECRET_<RUTA>_<NOMBRE>` (32+ caracteres, distinto al de todos)
   más sus `USER` y `PASS` con el mismo sufijo.
3. Pasarle la URL de la ruta y **su** secreto. Él lo agrega en su cuenta:
   claude.ai → Plugins → Agregar → Agregar conector personalizado → "Sin inicio de sesión"
   → encabezado `Authorization` con valor `Bearer <su secreto>`.

Para quitarle el acceso: borrar sus variables en Render. No afecta a nadie más.

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

## Cómo quedó montado en Render

Servicio `rmg-mcp-gateway`, plan Free, desde el repo `jc4868826-dotcom/funnel-os-crm`:

| Campo | Valor |
|---|---|
| Root Directory | `rmg-mcp-gateway` |
| Build Command | `npm install` |
| Start Command | `node index.mjs` |

El **Root Directory** es lo que lo hace independiente del servicio de FunnelOS, aunque
vivan en el mismo repo. El servicio de FunnelOS no se toca.

## Notas

- Modo sin estado: se crea un `McpServer` nuevo por petición.
- Las credenciales de cada identidad se inyectan por petición con `AsyncLocalStorage`, de
  modo que dos personas usando el gateway a la vez nunca se cruzan. Por eso `index.mjs`
  envuelve `process.env` en un Proxy: permite que los conectores lean sus credenciales
  como siempre, sin tocar su código.
- Cada ruta valida solo sus propios secretos, con comparación de tiempo constante.
- Plan Free: el servicio se duerme tras ~15 min sin uso y tarda ~50 s en despertar.
- `erp-parts` escribe una bitácora local (`bitacora_escrituras.jsonl`). En Render el disco
  es efímero, así que se pierde en cada reinicio. Va en `try/catch`, no bloquea nada.
- `erp-parts` y `erp-rmg` incluyen herramientas de escritura (caja, cotizaciones, OC).
  Trata sus secretos como claves de producción y da a cada persona el usuario que
  corresponda, no uno de administrador por comodidad.
