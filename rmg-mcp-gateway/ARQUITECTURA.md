# Conectores MCP de RMG — arquitectura y operación

Documento maestro. Si vas a tocar cualquier conector MCP (erp-rmg, erp-parts, funnelos,
mail-rmg), lee esto primero: evita redescubrir desde cero dónde vive el código y cómo se
despliega.

Última actualización: 17-11-2026.

---

## 1. Dónde vive todo

Un solo servicio en Render sirve los cuatro conectores.

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

### Ojo: hay otro servicio en Render que NO es este

`rmg-autos-bot` (`srv-d7ptvcgk1i2s738cadj0`) es un servicio aparte, con su propio juego de
variables (`IMAP_*`, `WA_*`, `OPENAI_API_KEY`, `MCP_SECRET` a secas, etc.). **No es el
gateway.** El 17-11-2026 las variables del correo se cargaron ahí por error y el conector
no levantaba; el síntoma fue `/mail-rmg/health` respondiendo `no hay ningun
MCP_SECRET_MAIL configurado` con el código ya desplegado. Antes de pelear con el código,
confirmar que las variables están en el servicio correcto.

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
│   ├── funnelos.mjs
│   └── mail-rmg.mjs       # ← correo de RMG Autos por IMAP/SMTP (ver sección 8)
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

---

## 8. El conector de correo (`mail-rmg`)

Cuarta ruta del gateway: `/mail-rmg`. Correo de RMG Autos, el mismo buzón que se ve en
`mail.rmgautos.cl` vía Roundcube.

**Estado:** operativo desde el 17-11-2026 contra `juancarlos.contreras@rmgautos.cl`.
Lectura IMAP verificada de punta a punta y conector registrado en claude.ai. Commits
`2320926` (conector) y el de precarga + traza. **SMTP todavía sin probar.**

### Por qué IMAP y no Roundcube

**Roundcube no tiene API.** Es un cliente web sobre el buzón, igual que el conector: la URL
`.../3rdparty/roundcube/?_task=mail` incluye un `cpsess` que es un token de sesión de cPanel
y caduca. Automatizar contra esa URL obligaría a mantener una sesión de navegador viva, y
eso no existe en el móvil ni en voz.

El conector habla **IMAP** (lectura, puerto 993 SSL) y **SMTP** (envío, puerto 465 SSL)
directo contra el servidor de correo. Es el mismo protocolo que usa Roundcube por debajo,
sin navegador en medio. Lo que se hace desde el conector se ve en Roundcube y al revés.

### Tools (8: 4 de lectura, 4 de escritura)

**Lectura:**

| Tool | Qué hace |
|---|---|
| `mail_carpetas` | Carpetas con total y no leídos; resuelve los nombres reales de Enviados/Papelera/Spam |
| `mail_buscar` | Lista cabeceras con filtros combinables (fechas, de, para, asunto, texto, no leídos, con adjuntos). **No trae el cuerpo** |
| `mail_leer` | Un mensaje completo por `uid`: cabeceras, cuerpo en texto, nombres de adjuntos |
| `mail_resumen` | Panorama de un rango: recibidos, sin leer, por día y remitentes más frecuentes |

**Escritura:**

| Tool | Qué hace | Confirmación |
|---|---|---|
| `mail_enviar` | Correo nuevo por SMTP | Dos pasos |
| `mail_responder` | Responde manteniendo el hilo (`In-Reply-To`/`References`), cita el original y marca `\Answered` | Dos pasos |
| `mail_mover` | Mueve mensajes entre carpetas, incluida la papelera | Dos pasos |
| `mail_marcar` | Leído / no leído / destacado | **Directa** |

`mail_marcar` es una **excepción deliberada** al patrón de dos pasos de la sección 5:
cambiar una marca es reversible y no manda nada al exterior. Pedir confirmación por
mensaje haría la tool inútil. Las otras tres sí cumplen el patrón completo: vista previa
con `confirmar=false`, verificación posterior y línea en `bitacora-escrituras.jsonl`.

**`mail_leer` no marca como leído por defecto** (`marcar_leido=false`). Es a propósito:
revisar el correo desde Claude no debe hacer desaparecer los no leídos de Roundcube sin
que JC lo decida.

**Los adjuntos no se descargan.** `mail_leer` los nombra, con tipo y tamaño. Para bajar uno
hay que abrir Roundcube.

**No hay borrado definitivo.** `mail_mover` a la papelera es lo más destructivo que existe,
y es recuperable. No se implementó `expunge` a propósito.

### Cómo son las carpetas de verdad en este cPanel

Confirmado el 17-11-2026 en la cuenta de JC:

```
INBOX            (\Inbox)
INBOX.Sent       (\Sent)        INBOX.Drafts   (\Drafts)
INBOX.Trash      (\Trash)       INBOX.Archive  (\Archive)
INBOX.spam       (\Junk)        INBOX.Junk     (sin atributo, vacía)
INBOX.Notes      (sin atributo)
```

Dos cosas que importan:

1. **Todo cuelga del prefijo `INBOX.`** — es `INBOX.Sent`, nunca `Sent`.
2. **Hay dos carpetas de spam.** La real es `INBOX.spam` (lleva el atributo `\Junk`);
   `INBOX.Junk` existe y está vacía. Por eso `especiales` se resuelve **por atributo IMAP
   y nunca por nombre**: resolver por nombre elegiría la carpeta vacía y el spam se vería
   siempre en cero. Si alguna vez se toca esa lógica en `especiales()`, no cambiarla a
   coincidencia por nombre.

### Una casilla por persona (decisión, 17-11-2026)

Cada persona usa **su propia casilla** a través de su propia identidad. Raúl ve solo la
suya, Victor la suya, JC la suya. Nadie lee el correo de otro.

Esto **no requiere código**: es el mismo esquema de identidades de la sección 1. Agregar a
alguien son tres variables en Render, con el sufijo en mayúsculas:

```
MCP_SECRET_MAIL_RAUL   / MAIL_USER_RAUL   / MAIL_PASS_RAUL
MCP_SECRET_MAIL_VICTOR / MAIL_USER_VICTOR / MAIL_PASS_VICTOR
```

Cada uno registra la **misma URL** en su cuenta de claude.ai con **su propio secreto**.
Para cortarle el acceso a alguien se borra su `MCP_SECRET_MAIL_*` y listo; los demás no se
tocan. Una identidad con sufijo no hereda nada de la principal: si le falta
`MAIL_PASS_VICTOR` no se monta, y `/mail-rmg/health` dice exactamente qué falta.

Se evaluó y se descartó la alternativa de que una identidad opere varias casillas (un
parámetro `casilla` en las 8 tools). Si alguna vez hace falta, eso sí requiere cambiar el
conector **y** `index.mjs`, porque hoy el gateway solo pasa al conector las variables
declaradas en `credenciales.obligatorias` y `.opcionales`.

Ojo con cPanel: si la clave de una casilla se cambia desde cPanel, el conector responde
error de login hasta que se actualice el `MAIL_PASS*` correspondiente en Render.

### Variables en Render

| Variable | Obligatoria | Por defecto |
|---|---|---|
| `MCP_SECRET_MAIL` | sí | — (mínimo 32 caracteres) |
| `MAIL_USER` | sí | — dirección completa |
| `MAIL_PASS` | sí | — |
| `MAIL_IMAP_HOST` | no | `mail.rmgautos.cl` |
| `MAIL_IMAP_PORT` | no | `993` |
| `MAIL_SMTP_HOST` | no | `mail.rmgautos.cl` |
| `MAIL_SMTP_PORT` | no | `465` |
| `MAIL_FROM` | no | el valor de `MAIL_USER` |

### Dependencias nuevas

`imapflow` (IMAP), `nodemailer` (SMTP) y `mailparser` (parseo de MIME) se agregaron a
`package.json`. El build de Render corre `npm install`, así que las instala solo; no hace
falta tocar `package-lock.json` a mano.

### Registrar el conector en claude.ai (leer esto antes de pelear con el formulario)

La ruta cambió: ya **no** es Configuración → Conectores. Ahora es
**Plugins → Agregar → Agregar conector personalizado**.

Procedimiento que funciona, con las trampas marcadas:

1. Nombre y URL (`https://rmg-mcp-gateway.onrender.com/<ruta>`) → **Continuar**.
2. claude.ai sondea el servidor. Como el gateway responde 401 sin credenciales, marca
   **"Iniciar sesión ahora" como "Detectado"**. *Es OAuth y está mal para este gateway.*
   Cambiar a **"Sin inicio de sesión"**.
3. Agregar encabezado. **Usar `x-api-key`, no `authorization`.** El gateway acepta los
   dos (`index.mjs` → `autenticar()`), pero con `authorization` hay que escribir
   `Bearer ` + secreto, y el espacio que falta o sobra es la causa más común de 401. Con
   `x-api-key` se pega el secreto crudo y no hay nada más que equivocar.
4. El valor se copia **con el botón de copiar de Render**, nunca seleccionando el texto a
   mano ni regenerándolo. Tiene que ser exactamente el `MCP_SECRET_MAIL` que está en el
   servicio, byte a byte.
5. Llenar el campo Valor **antes** de apretar Agregar.

Tres cosas que confunden y hacen perder horas:

- **El panel del conector muestra "Autorización: Requiere iniciar sesión" aunque hayas
  elegido "Sin inicio de sesión".** Es el resultado del sondeo, no la configuración
  guardada. No sirve como indicador de que algo quedó mal.
- **claude.ai reporta un 401 como "No se pudo conectar al servidor".** No distingue entre
  servidor caído, URL mala y secreto incorrecto. El mensaje engaña: manda a revisar la URL
  cuando el problema es la credencial.
- **Un conector no se puede editar.** El menú solo ofrece Desconectar y Quitar. Si quedó
  mal configurado hay que quitarlo y rehacerlo — y **quitarlo desenlaza las tareas
  programadas que lo usaban** (el diálogo de confirmación las nombra; hay que volver a
  asociarlas después).

### Diagnosticar con los logs del gateway

`index.mjs` deja una línea por petición, sin secretos ni cuerpo:

```
[mail-rmg] 200 metodo=tools/list identidad=principal 31ms
[mail-rmg] 401 metodo=initialize
```

Con eso el diagnóstico es de tres salidas, sin adivinar:

| Qué se ve en los logs | Qué significa |
|---|---|
| `401` | El secreto del encabezado no coincide con el de Render |
| `200` y claude.ai igual falla | El gateway respondió bien; el problema es del cliente |
| Nada | La petición nunca llegó al servidor |

Fue exactamente así como se resolvió el 17-11-2026: tres `401 metodo=initialize` en los
logs cerraron un problema que llevaba una hora pareciendo timeout, OAuth mal configurado
y módulo pesado.

### Pre-carga de módulos

`index.mjs` precarga los módulos de los cuatro conectores al arrancar. Antes el import
ocurría dentro de la primera petición: ~3 ms para los conectores livianos, pero **1703 ms
para mail-rmg en Render** (imapflow + mailparser + nodemailer). No fue la causa del
problema de registro, pero sí un riesgo real de timeout en el plan Free. El tiempo de
pre-carga de cada conector queda en el log de arranque.

### Probar el conector sin registrarlo en claude.ai

Prueba directa contra el endpoint MCP, útil para separar "falla el correo" de "falla
claude.ai":

```bash
printf 'MCP_SECRET_MAIL: '; read -s SEC; echo
curl -sN https://rmg-mcp-gateway.onrender.com/mail-rmg \
  -H "Authorization: Bearer $SEC" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mail_carpetas","arguments":{}}}' \
  | sed -n 's/^data: //p'
```

Devuelve la cuenta y las carpetas. Si eso responde, IMAP está bien y cualquier problema
restante es del registro del conector en claude.ai.

### Si el conector no conecta

En orden de probabilidad:

1. **Las variables están en el servicio equivocado.** Ver la sección 1. Fue la causa real
   la primera vez.
2. **Clave incorrecta** en `MAIL_PASS`, o la casilla pide clave de aplicación. Síntoma:
   `Invalid credentials` / `AUTHENTICATIONFAILED`.
3. **Puerto bloqueado o IP filtrada.** Síntoma: timeout o `ECONNREFUSED`. El plan Free de
   Render permite salida TCP, pero si el host de correo filtra por IP hay que habilitar la
   IP de salida de Render en cPanel.
4. **Nombre de carpeta.** Usar siempre `mail_carpetas` antes de buscar en una carpeta que
   no sea INBOX.

Verificar siempre primero:

```bash
curl -s https://rmg-mcp-gateway.onrender.com/mail-rmg/health
```

Recordar que `/health` solo confirma que las variables **existen**, no que cPanel acepte la
clave. La prueba real es el `curl` de más arriba.
