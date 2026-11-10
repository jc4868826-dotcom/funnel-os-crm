// Prueba rápida: inicia sesión con ERP_USER / ERP_PASS y consulta el catálogo de estados.
// Uso:  ERP_USER=usuario ERP_PASS=clave node probar.js
import { call } from './erp-client.js';

try {
  const estados = await call('estadonv', 'getall');
  console.log('Conexión OK. Estados de nota de venta:');
  for (const e of estados) console.log(`  ${e.idestadonv}: ${e.estadonv}`);

  const facturadas = estados.find((e) => /facturad/i.test(e.estadonv));
  if (facturadas) {
    const notas = await call('notaventa', 'getall', {
      notaventa: null, patente: null, nombrecliente: null, rut: null,
      estado: facturadas.idestadonv, mes: null, anno: null,
    });
    console.log(`Notas de venta ${facturadas.estadonv}: ${notas.length}`);
    if (notas[0]) {
      const detalle = await call('notaventadocumento', 'getid', {}, { id: notas[0].idnotaventa });
      console.log(`Documentos adjuntos de la nota ${notas[0].idnotaventa}: ${Array.isArray(detalle) ? detalle.length : 'respuesta inesperada'}`);
    }
  }
} catch (e) {
  console.error('Fallo:', e.message);
  process.exit(1);
}
