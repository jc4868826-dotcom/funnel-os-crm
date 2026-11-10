import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { call } from './erp-client.js';

// Crea un servidor MCP con todas las herramientas del ERP (solo lectura).
export function createServer() {
  const server = new McpServer({ name: 'erp-rmg-autos', version: '0.2.0' });

  const ok = (data) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
  });
  const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] });

  const tool = (name, description, shape, fn) =>
    server.tool(name, description, shape, async (args) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail(e);
      }
    });

  // Devuelve máximo `limite` filas (y solo las columnas pedidas) para no inundar la conversación.
  const recorta = (rows, campos, limite) => {
    if (!Array.isArray(rows)) return rows;
    let filas = rows.slice(0, limite);
    if (campos?.length) filas = filas.map((r) => Object.fromEntries(campos.map((c) => [c, r[c]])));
    return { total: rows.length, mostrando: filas.length, filas };
  };

  const nn = (v) => (v === undefined || v === '' ? null : v);
  const limiteSchema = z.number().int().min(1).max(200).default(50).describe('Máximo de filas a devolver (1-200)');

  const NV_CAMPOS = [
    'idnotaventa', 'registro', 'estadonv', 'vendedor', 'cliente', 'rut', 'telefono', 'mail',
    'marca', 'modelo', 'version', 'patente', 'anno', 'tipoauto', 'sucursal', 'formapago',
    'entidadfinanciera', 'pie', 'plazo', 'autopartepago', 'ventaiva', 'costoiva', 'nrofactura', 'fechafactura',
  ];
  const CLIENTE_CAMPOS = [
    'idclientes', 'nombres', 'apellidos', 'rut', 'telefono', 'mail', 'estado', 'registro',
    'descripcionorigencliente', 'marca', 'modelo', 'vendedor_asignado', 'proximotoque', 'cnt_gestion', 'cliente_compra',
  ];

  const CATALOGOS = [
    'bonos', 'tipoingreso', 'tipogastonv', 'formapago', 'entidadfinanciera', 'estadonv', 'cargogasto',
    'origencliente', 'tipodocumentos', 'gastosingresostipo', 'gastosingresosperiodo', 'salidasotrosconceptos',
  ];

  tool(
    'erp_catalogo',
    'Lista un catálogo del ERP: estadonv (estados de nota de venta con sus ids), formapago, entidadfinanciera, tipoingreso, tipogastonv, bonos, cargogasto, origencliente, tipodocumentos (tipos de documento adjuntable), gastosingresostipo, gastosingresosperiodo, salidasotrosconceptos (cuentas por cobrar / otras cuentas).',
    { nombre: z.enum(CATALOGOS) },
    async ({ nombre }) => call(nombre, 'getall'),
  );

  tool(
    'erp_notas_venta',
    'Busca notas de venta. "estado" es el id numérico del estado (usar erp_catalogo con nombre=estadonv para ver ids: VIGENTE, ANULADA, FACTURADA). Devuelve un resumen por nota; con completo=true devuelve todos los campos.',
    {
      estado: z.number().int().optional().describe('Id del estado de nota de venta'),
      nro: z.string().optional().describe('Número de nota de venta'),
      patente: z.string().optional(),
      cliente: z.string().optional().describe('Nombre del cliente (texto parcial)'),
      rut: z.string().optional(),
      mes: z.number().int().min(1).max(12).optional(),
      anno: z.number().int().optional(),
      completo: z.boolean().default(false),
      limite: limiteSchema,
    },
    async (a) => {
      const rows = await call('notaventa', 'getall', {
        notaventa: nn(a.nro), patente: nn(a.patente), nombrecliente: nn(a.cliente),
        rut: nn(a.rut), estado: a.estado ?? null, mes: a.mes ?? null, anno: a.anno ?? null,
      });
      return recorta(rows, a.completo ? null : NV_CAMPOS, a.limite);
    },
  );

  tool(
    'erp_detalle_nota_venta',
    'Detalle completo de una nota de venta por su id (idnotaventa): datos de la nota, gastos, bonos/descuentos, ingresos y documentos adjuntos. Sirve de base para armar contratos e informes.',
    { id: z.number().int().describe('idnotaventa') },
    async ({ id }) => {
      const pedir = async (destino, accion) => {
        try {
          return await call(destino, accion, {}, { id });
        } catch (e) {
          return { error: e.message };
        }
      };
      const [nota, gastos, bonos, ingresos, documentos] = await Promise.all([
        pedir('notaventa', 'getid'),
        pedir('gastos', 'getid'),
        pedir('bonosdescuentos', 'getid'),
        pedir('ingresos', 'getid'),
        pedir('notaventadocumento', 'getid'),
      ]);
      return { nota, gastos, bonos, ingresos, documentos };
    },
  );

  tool(
    'erp_stock',
    'Consulta el stock de vehículos con filtros opcionales.',
    {
      patente: z.string().optional(),
      estado: z.number().int().optional().describe('Id del estado de stock'),
      marca: z.string().optional(),
      modelo: z.string().optional(),
      version: z.string().optional(),
      limite: limiteSchema,
    },
    async (a) => {
      const rows = await call('stock', 'getallfiltro', {
        patente: nn(a.patente), estado: a.estado ?? null, marca: nn(a.marca),
        modelo: nn(a.modelo), version: nn(a.version),
      });
      return recorta(rows, null, a.limite);
    },
  );

  tool(
    'erp_clientes',
    'Busca clientes y prospectos con filtros opcionales. Devuelve un resumen por cliente (datos personales: usar solo para la gestión del negocio).',
    {
      nombre: z.string().optional(),
      apellido: z.string().optional(),
      rut: z.string().optional(),
      vendedor: z.number().int().optional().describe('Id de usuario vendedor'),
      origenlead: z.number().int().optional().describe('Id de origen (ver erp_catalogo origencliente)'),
      mes: z.number().int().min(1).max(12).optional(),
      anno: z.number().int().optional(),
      compra: z.string().optional(),
      asignado: z.string().optional(),
      status: z.string().optional(),
      completo: z.boolean().default(false),
      limite: limiteSchema,
    },
    async (a) => {
      const rows = await call('clientes', 'getallfiltro', {
        nombrecliente: nn(a.nombre), apellidocliente: nn(a.apellido), rut: nn(a.rut),
        vendedor: a.vendedor ?? null, origenlead: a.origenlead ?? null, mes: a.mes ?? null,
        anno: a.anno ?? null, compra: nn(a.compra), asignado: nn(a.asignado), status: nn(a.status),
      });
      return recorta(rows, a.completo ? null : CLIENTE_CAMPOS, a.limite);
    },
  );

  tool(
    'erp_estado_resultado',
    'Estado de resultado mensual de un año (unidades vendidas, facturación, costos directos, etc.).',
    { anno: z.number().int().describe('Año, por ejemplo 2026') },
    async ({ anno }) => call('notaventa', 'estadoresultado', { anno }),
  );

  tool(
    'erp_consulta_lectura',
    'Consulta avanzada de solo lectura: llama a destino.accion con un dataForm libre. La acción debe empezar con "get". Úsala solo para explorar acciones aún sin herramienta propia.',
    {
      destino: z.string().regex(/^\w+$/),
      accion: z.string().regex(/^get\w*$/i),
      dataForm: z.record(z.any()).default({}),
      id: z.union([z.number(), z.string()]).optional(),
      limite: limiteSchema,
    },
    async (a) => {
      const rows = await call(a.destino, a.accion, a.dataForm, a.id !== undefined ? { id: a.id } : {});
      return recorta(rows, null, a.limite);
    },
  );

  return server;
}
