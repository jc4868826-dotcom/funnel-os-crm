# Conectores MCP de RMG — arquitectura y operación

Documento maestro. Si vas a tocar cualquier conector MCP (erp-rmg, erp-parts, funnelos),
lee esto primero: evita redescubrir desde cero dónde vive el código y cómo se despliega.

Última actualización: 13-11-2026.

---

## 1. Dónde vive todo

Un solo servicio en Render sirve los tres conectores.

| Qué | Valor |
|---|---|
| Servicio Render | `rmg-mcp-gateway` (Node, plan Free, Oregon) |
| URL | `https://rmg-mcp-gateway.onrender.com` |
| Service ID | `srv-dbr440lbedkc73cf756g` |
| Repo | `github.com/jc4868826-dotcom/funnel-os-crm`, rama `main` |
| Root Directory | `rmg-mcp-gateway` |
| Build Command | `npm install` |
| Repo local | `~/Desktop/negocio sistemas` |

El **Root Directory** es clave: Render solo construye desde `rmg-mcp-gateway/` y solo
auto-despliega cuando cambia algo **dentro de esa carpeta**. Un commit que toque otra
parte del repo no dispara despliegue del gateway.

### Estructura del gateway

```
rmg-mcp-gateway/
├── index.mjs              # enrutador: resuelve la identidad según el secreto recibido
├── herramientas/
│   └── envolver.mjs
├── conectores/
│   ├── erp-rmg/           # ← conector del ERP RMG Autos
│   │   ├── tools.js       #   definición de todas las tools
│   │   ├── erp-client.js  #   login, llamadas al ERP, lista blanca de escrituras
│   │   ├── analisis.js    #   motor de análisis genérico
│   │   └── erp-config.json
│   ├── erp-parts.mjs
│   └── funnelos.mjs
├── package.json
└── LEEME.md
```

### Identidades

Cada conector expone dos identidades, **`principal` (JC)** y **`raul`**, resueltas por el
secreto que manda el cliente MCP. Comparten el mismo código; lo que cambia son las
credenciales del ERP, y por lo tanto los permisos que el propio ERP aplica.

**Consecuencia:** al desplegar, los conectores de JC y de Raúl se actualizan juntos.
Nadie instala nada. No hay forma hoy de exponer tools distintas por identidad.

Verificar estado en cualquier momento:

```bash
curl -s https://rmg-mcp-gateway.onrender.com/health
```

Responde `ok: true` y el detalle por conector e identidad. El plan Free duerme el
servicio por inactividad: la primera llamada puede tardar ~50 segundos.

---

## 2. Carpetas que YA NO se usan (trampas conocidas)

Estas existen en el Mac y en el repo, y **no son el código vivo**. No las edites esperando
que algo cambie en producción:

| Ruta | Qué es | Estado |
|---|---|---|
| `~/Downloads/rmg-erp-mcp/` | Versión original stdio (Claude Desktop local) | Histórica. Útil solo como copia de trabajo |
| `~/Downloads/rmg-erp-mcp/subir-a-github/` | Intento de desplegar como servicio propio | **Abandonado**, quedó en v0.2.0 con 7 tools |
| `~/Downloads/rmg-erp-mcp/erp-mcp/` | Intento de montar el conector dentro de FunnelOS en `/erp-mcp` | **Abandonado** en favor del gateway |
| `<repo>/erp-mcp/` | Copia del anterior en el repo | **Abandonado**, no se despliega |

Si el conector vivo expone más tools que una de estas carpetas, esa carpeta está vieja.
El código vivo es siempre `rmg-mcp-gateway/conectores/`.

---

## 3. El ERP RMG Autos (`gestion.rmgautos.cl`)

Sistema de terceros ("Gestión Automotriz", de Alejandro Carcasson). El conector habla con
su API genérica.

### Forma de la API

Todo pasa por un único endpoint:

```
POST https://gestion.rmgautos.cl/api/controller.php
{ "destino": "<tabla>", "accion": "<operación>", "dataForm": {...},
  "id": "", "id2": "", "estado": "T", "estado2": "T" }
```

Autenticación por token (login con usuario y clave en variables de entorno `ERP_USER` /
`ERP_PASS`; la clave viaja en MD5 según lo que exige el ERP). El cliente reintenta el login
una vez si el ERP responde 401/403 o un mensaje de sesión expirada.

### Lecturas y escrituras

`erp-client.js` separa ambas en dos funciones distintas:

- **`call()`** — solo acciones de lectura: cualquier `get*`, más las excepciones listadas
  en `LECTURA_EXTRA` (hoy `notaventa.estadoresultado`).
- **`escribir()`** — solo las acciones de la lista blanca `ESCRITURAS_PERMITIDAS`:

```js
new Set(['gastosingresos.add', 'notaventa.updateEstado'])
```

**Cualquier escritura nueva requiere agregarla explícitamente a esa lista.** Es la única
puerta de escritura; no hay otra forma de que el conector modifique el ERP.

### Cómo descubrir una acción nueva del ERP

El ERP no tiene documentación. El método que funciona, y el único confiable:

1. Abrir el ERP en Chrome con la sesión iniciada.
2. Inyectar un interceptor de `XMLHttpRequest.send` / `fetch` que guarde los bodies.
3. Hacer la acción a mano en la interfaz.
4. Leer el payload capturado: de ahí salen `destino`, `accion` y la forma exacta de `dataForm`.

No adivinar nombres de acciones ni formas de payload contra producción.

---

## 4. Reglas de negocio del ERP

Estas no son opcionales: los reportes salen mal si se ignoran.

- **La venta se asigna al mes según la FECHA DE FACTURA**, nunca según la fecha de registro
  de la nota.
- **Precio real de venta = `ventadescuentos`** (precio lista menos bonos y descuentos).
  `ventaiva` es precio lista. El precio de lista es precio contado; con crédito existe un
  "precio crédito" con descuento asociado, por eso siempre difieren CRM y ERP.
- **Total que paga el cliente = `ventadescuentosyotros`** = precio con descuentos + gastos
  con cargo al cliente (transferencia, TAG).
- **Margen ERP** = lo que paga el cliente − costo total del auto (compra + reparación y
  activación) − costo real de los gastos de la nota.
- **Las notas VIGENTES sin factura son reservas**, no venta del mes: pipeline hasta que se
  facturen.
- **Facturar en el ERP no emite ninguna factura.** La emisión real se hace en el sitio del
  SII; en el ERP solo se cambia el estado a FACTURADA y se registra el número de la factura
  ya emitida. Por eso no es una acción restringida: Raúl y quien corresponda la hacen
  normalmente.

### Estados de nota de venta (`estadonv`)

| id | nombre |
|---|---|
| 1 | VIGENTE |
| 2 | ANULADA |
| 3 | FACTURADA |

---

## 5. Tools del conector erp-rmg

**Lectura:** `erp_catalogo`, `erp_notas_venta`, `erp_detalle_nota_venta`, `erp_inventario`,
`erp_clientes`, `erp_estado_resultado`, `erp_caja_movimientos`, `erp_cuentas_por_cobrar`,
`erp_saldos`, `erp_gastos_por_auto`, `erp_rotacion`, `erp_precio_toma`,
`erp_ventas_por_comuna`, `erp_analisis`, `erp_consulta_lectura`.

**Escritura (2):**

| Tool | Acción ERP | Qué hace |
|---|---|---|
| `erp_registrar_movimiento_caja` | `gastosingresos.add` | Registra ingreso o egreso en caja |
| `erp_facturar_nota_venta` | `notaventa.updateEstado` | Cambia estado de la nota y registra N° y fecha de la factura emitida en el SII |

### Patrón obligatorio para toda tool de escritura

Las dos lo cumplen, y cualquiera nueva debe cumplirlo:

1. **Dos pasos.** `confirmar=false` por defecto devuelve una vista previa sin escribir nada.
   Solo con aprobación explícita del usuario en ese turno se llama con `confirmar=true`.
2. **Validación previa.** Si hay una condición de negocio que deba cumplirse, se chequea
   antes y se bloquea si no cuadra (`erp_facturar_nota_venta` exige que los ingresos
   validados cubran el total; se salta solo con `forzar=true`).
3. **Verificación posterior.** Se relee el registro desde el ERP y se informa
   `verificado: true/false`.
4. **Bitácora.** Se escribe una línea en `bitacora-escrituras.jsonl`.

### Payload de `notaventa.updateEstado`

`dataForm` es **el objeto completo de la nota** (lo que devuelve `notaventa.getid`), sin los
campos de auditoría `registro`, `usuregistro`, `idusuarios_crea_fk`, `idusuarios_cierra_fk1`,
y con estos tres sobrescritos:

```js
idestadonv_fk   // 1 | 2 | 3
estadonv        // "VIGENTE" | "ANULADA" | "FACTURADA"
nrofactura      // string
fechafactura    // "AAAA-MM-DD"
```

**Detalle de fechas:** el formulario del ERP muestra la fecha de factura un día antes de la
real (problema de zona horaria solo en la visualización). El payload se envía como
`AAAA-MM-DD` sin conversión y la base guarda ese mismo día. Confiar en el dato de la API,
no en lo que muestra el formulario.

---

## 6. Desplegar un cambio

```bash
cd "$HOME/Desktop/negocio sistemas" && git pull --ff-only && \
node --check rmg-mcp-gateway/conectores/erp-rmg/tools.js && \
node --check rmg-mcp-gateway/conectores/erp-rmg/erp-client.js && \
git --no-pager diff --stat rmg-mcp-gateway/
```

Revisar que el diff sea solo lo esperado, y recién entonces:

```bash
cd "$HOME/Desktop/negocio sistemas" && \
git add rmg-mcp-gateway/ && \
git commit -m "erp-rmg: <qué cambió>" && \
git push
```

Render auto-despliega en ~1 minuto. Verificar:

```bash
curl -s https://rmg-mcp-gateway.onrender.com/health
```

**Último paso, fácil de olvidar:** claude.ai cachea la lista de tools por conversación. Una
tool nueva **no aparece en el chat donde se hizo el cambio** — hay que abrir un chat nuevo.

---

## 7. Variables de entorno (Render → Environment)

`ERP_USER`, `ERP_PASS` por identidad, y los secretos que `index.mjs` usa para resolver
identidad. No viven en el repo. Si faltan, el conector responde 503 y lo informa en
`/health` con `listo: false`.
