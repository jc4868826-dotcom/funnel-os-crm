// Almacen temporal de adjuntos y ruta publica para bajarlos.
//
// Por que existe: un adjunto no puede viajar dentro de la respuesta de una tool. Un PDF de
// 2 MB en base64 son ~2,7 millones de caracteres: revienta la ventana de contexto del
// cliente MCP y arruina la conversacion completa. Lo que viaja de vuelta es un ENLACE; los
// bytes quedan aqui, en memoria del gateway, y se sirven por HTTPS cuando el usuario hace
// clic. Asi el costo de un adjunto es una linea de texto, no el archivo entero.
//
// Deliberadamente en memoria y no en disco: Render borra el disco en cada despliegue y el
// plan Free duerme el servicio, asi que un archivo en disco tampoco sobrevive. En memoria
// el ciclo de vida es explicito y no deja basura.
//
// Consecuencia asumida: tras un redespliegue o un reinicio, los enlaces vigentes mueren.
// Se vuelve a pedir el adjunto desde Claude y se genera uno nuevo.
import crypto from 'node:crypto';
import express from 'express';

const TTL_MS = 30 * 60 * 1000;        // vida de un enlace
const MAX_DESCARGAS = 5;              // cuantas veces sirve el mismo enlace
const TOPE_TOTAL = 64 * 1024 * 1024;  // techo del almacen, para no quedarse sin memoria

const guardados = new Map(); // token -> { nombre, tipo, buffer, uid, carpeta, vence, descargas }

const vivo = (e) => !!e && e.vence > Date.now() && e.descargas < MAX_DESCARGAS;

function limpiar() {
  for (const [token, e] of guardados) if (!vivo(e)) guardados.delete(token);
}

function pesoTotal() {
  let n = 0;
  for (const e of guardados.values()) n += e.buffer.length;
  return n;
}

// Guarda el adjunto y devuelve el token con el que se arma su enlace.
export function guardarAdjunto({ nombre, tipo, buffer, uid, carpeta }) {
  limpiar();
  // Si no cabe, salen primero los mas proximos a vencer.
  while (guardados.size && pesoTotal() + buffer.length > TOPE_TOTAL) {
    const [tokenViejo] = [...guardados.entries()].sort((a, b) => a[1].vence - b[1].vence)[0];
    guardados.delete(tokenViejo);
  }
  const token = crypto.randomBytes(32).toString('hex');
  guardados.set(token, {
    nombre, tipo, buffer, uid, carpeta,
    vence: Date.now() + TTL_MS,
    descargas: 0,
  });
  return { token, vence_en_minutos: Math.round(TTL_MS / 60000), descargas_disponibles: MAX_DESCARGAS };
}

const basePublica = () =>
  String(process.env.GATEWAY_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://rmg-mcp-gateway.onrender.com')
    .replace(/\/+$/, '');

export const enlaceDe = (ruta, token) => `${basePublica()}/${ruta}/adjunto/${token}`;

// Nombre seguro para la cabecera Content-Disposition.
const limpio = (s) => String(s || 'adjunto').replace(/[\r\n"\\/]+/g, '_').slice(0, 180);

// Router con la ruta de descarga de un conector, ej. GET /mail-rmg/adjunto/<token>.
//
// Va sin cabecera de autorizacion a proposito: el enlace tiene que abrirse con un clic
// desde el telefono, donde no hay forma de mandar un Bearer. La proteccion es el token de
// 32 bytes aleatorios, el vencimiento a 30 minutos y el tope de descargas.
export function rutaAdjuntos(ruta) {
  const router = express.Router();
  router.get(`/${ruta}/adjunto/:token`, (req, res) => {
    limpiar();
    const e = guardados.get(req.params.token);
    if (!vivo(e)) {
      return res.status(404).type('text/plain')
        .send('Enlace vencido o inexistente. Vuelve a pedir el adjunto desde Claude.');
    }
    e.descargas++;
    res.setHeader('Content-Type', e.tipo || 'application/octet-stream');
    res.setHeader('Content-Length', e.buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${limpio(e.nombre)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(e.buffer);
  });
  return router;
}

export const estadoAlmacen = () => {
  limpiar();
  return { adjuntos_en_memoria: guardados.size, bytes: pesoTotal(), tope_bytes: TOPE_TOTAL };
};
