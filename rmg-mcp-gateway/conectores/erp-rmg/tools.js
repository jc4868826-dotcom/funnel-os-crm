import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import { call, esLectura, escribir } from './erp-client.js';
import { registrarAnalisis, limpiarCache } from './analisis.js';

// Crea un servidor MCP con todas las herramientas del ERP (solo lectura). Montos en pesos chilenos (CLP).
export function createServer() {
  const server = new McpServer({ name: 'erp-rmg-autos', version: '0.5.0' });

  const ok = (data) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data ?? null) }],
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

  // ── utilidades ─────────────────────────────────────────────────────────
  const lista = (v) => (Array.isArray(v) ? v : []);
  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
  const nn = (v) => (v === undefined || v === '' ? null : v);
  const txt = (v) => String(v ?? '').trim().toUpperCase();
  const contiene = (campo, filtro) => !filtro || txt(campo).includes(txt(filtro));
  // Precio real/final de una nota = ventadescuentos (precio venta descuento); ventaiva es precio lista.
  const precioReal = (n) => num(n.ventadescuentos) || num(n.ventaiva);
  const sumar = (rows, campo) => rows.reduce((s, r) => s + num(r[campo]), 0);

  // Devuelve máximo `limite` filas (y solo las columnas pedidas) para no inundar la conversación.
  const recorta = (rows, campos, limite) => {
    if (!Array.isArray(rows)) return rows ?? { total: 0, filas: [] };
    let filas = rows.slice(0, limite);
    if (campos?.length) filas = filas.map((r) => Object.fromEntries(campos.map((c) => [c, r[c]])));
    return { total: rows.length, mostrando: filas.length, filas };
  };

  // Agrupa y suma: { clave: total } ordenado de mayor a menor.
  const agrupar = (rows, clave, campo) => {
    const m = {};
    for (const r of rows) {
      const k = String(r[clave] ?? 'SIN DATO').trim() || 'SIN DATO';
      m[k] = (m[k] || 0) + num(r[campo]);
    }
    return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]));
  };

  const hoy = () => {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
    return { mes: d.getMonth() + 1, anno: d.getFullYear() };
  };

  // Busca el período contable (mes/año) del módulo Ingresos-Gastos. Sin mes/año: el mes actual.
  async function periodo(mes, anno) {
    const h = hoy();
    const m = mes ?? h.mes;
    const a = anno ?? h.anno;
    const p = lista(await call('gastosingresosperiodo', 'getall')).find((x) => num(x.mes) === m && num(x.anno) === a);
    if (!p) throw new Error(`No existe el período ${m}/${a} en Ingresos-Gastos`);
    return p;
  }

  const limiteSchema = z.number().int().min(1).max(500).default(50).describe('Máximo de filas a devolver (1-500)');
  const mesSchema = z.number().int().min(1).max(12).optional().describe('Mes 1-12 (por defecto, el mes actual)');
  const annoSchema = z.number().int().optional().describe('Año, por ejemplo 2026 (por defecto, el año actual)');

  const NV_CAMPOS = [
    'idnotaventa', 'registro', 'estadonv', 'vendedor', 'cliente', 'rut', 'telefono', 'mail',
    'marca', 'modelo', 'version', 'patente', 'anno', 'tipoauto', 'sucursal', 'formapago',
    'entidadfinanciera', 'pie', 'plazo', 'autopartepago', 'ventaiva', 'ventadescuentos', 'bonosrestan', 'gastoscargonegocio', 'costoiva', 'nrofactura', 'fechafactura',
  ];
  const CLIENTE_CAMPOS = [
    'idclientes', 'nombres', 'apellidos', 'rut', 'telefono', 'mail', 'estado', 'registro',
    'descripcionorigencliente', 'marca', 'modelo', 'vendedor_asignado', 'proximotoque', 'cnt_gestion', 'cliente_compra',
  ];
  const STOCK_CAMPOS = [
    'idstock', 'patente', 'marca', 'modelo', 'version', 'anno', 'kilometraje', 'color', 'tipoauto',
    'estadostock', 'sucursal', 'origenstock', 'fechaingreso', 'costoiva', 'ventaiva', 'costototal', 'margen', 'diasingreso', 'notaventa',
  ];

  const CATALOGOS = [
    'bonos', 'tipoingreso', 'tipogastonv', 'formapago', 'entidadfinanciera', 'estadonv', 'cargogasto',
    'origencliente', 'tipodocumentos', 'gastosingresostipo', 'gastosingresosperiodo', 'salidasotrosconceptos',
    'sucursales', 'tipoauto', 'usuarios',
  ];

  // ── catálogos ──────────────────────────────────────────────────────────
  tool(
    'erp_catalogo',
    'Lista un catálogo del ERP: estadonv (estados de nota de venta con ids), formapago, entidadfinanciera, tipoingreso, tipogastonv, bonos, cargogasto, origencliente, tipodocumentos, gastosingresostipo (tipos de gasto/ingreso de caja), gastosingresosperiodo (períodos mensuales con inmovilizado y por cobrar), salidasotrosconceptos (otras cuentas por cobrar), sucursales, tipoauto, usuarios.',
    { nombre: z.enum(CATALOGOS) },
    async ({ nombre }) => {
      const data = lista(await call(nombre, 'getall'));
      if (nombre !== 'usuarios') return data;
      // Usuarios: solo datos no sensibles.
      return data.map((u) => Object.fromEntries(
        Object.entries(u).filter(([k]) => !/pass|clave|token|hash/i.test(k)),
      ));
    },
  );

  // ── ventas ─────────────────────────────────────────────────────────────
  tool(
    'erp_notas_venta',
    'Busca notas de venta (negocios). "estado" es el id del estado: usar erp_catalogo nombre=estadonv (VIGENTE, ANULADA, FACTURADA). Devuelve un resumen por nota (precio real final ventadescuentos = precio venta descuento; ventaiva es precio lista; costo costoiva, pie, plazo, financiera) y totales; con completo=true devuelve todos los campos.',
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
      const rows = lista(await call('notaventa', 'getall', {
        notaventa: nn(a.nro), patente: nn(a.patente), nombrecliente: nn(a.cliente),
        rut: nn(a.rut), estado: a.estado ?? null, mes: a.mes ?? null, anno: a.anno ?? null,
      }));
      for (const r of rows) r.precio_real = precioReal(r);
      return {
        totales: {
          notas: rows.length,
          venta_total_real: sumar(rows, 'precio_real'),
          venta_total_lista_iva: sumar(rows, 'ventaiva'),
          costo_total_iva: sumar(rows, 'costoiva'),
          por_vendedor: agrupar(rows, 'vendedor', 'precio_real'),
        },
        ...recorta(rows, a.completo ? null : NV_CAMPOS, a.limite),
      };
    },
  );

  tool(
    'erp_detalle_nota_venta',
    'Detalle completo de una nota de venta por su id (idnotaventa): datos de la nota, gastos, bonos/descuentos, ingresos y documentos adjuntos. Base para contratos e informes.',
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

  // Traduce el estado de resultado del ERP (bloques r1, r3, r4, r33, r44, r55) a un formato legible por mes.
  // r1 = ventas por tipo de auto; r3/r4 = gastos operacionales por tipo / total; r33/r44 = impuestos por tipo / total;
  // r55 = partida adicional que el ERP no rotula (se informa tal cual).
  function traducirEstadoResultado(er, mesFiltro) {
    const meses = {};
    const M = (m) => (meses[m] ||= {
      mes: m, unidades_vendidas: 0, facturacion: 0, costo_compra: 0, costos_totales: 0,
      gastos_de_stock: 0, gastos_reparacion: 0, gastos_activacion: 0, cargo_al_negocio: 0,
      spread_credito: 0, margen_ventas_erp: 0, gastos_operacionales: 0, detalle_gastos_operacionales: {},
      impuestos: 0, detalle_impuestos: {}, partida_r55_sin_rotulo: 0, por_tipo_auto: {},
    });
    for (const r of lista(er?.r1)) {
      const x = M(num(r.mes));
      x.unidades_vendidas += num(r.cantidadventas);
      x.facturacion += num(r.facturado);
      x.costo_compra += num(r.costo);
      x.costos_totales += num(r.costostotal);
      x.gastos_de_stock += num(r.stockgastos);
      x.gastos_reparacion += num(r.stockgastosR);
      x.gastos_activacion += num(r.stockgastosA);
      x.cargo_al_negocio += num(r.cargonegocio);
      x.spread_credito += num(r.totalspreadcredito);
      x.margen_ventas_erp += num(r.margenunidad);
      x.por_tipo_auto[String(r.tipoauto || 'SIN DATO').trim()] = {
        unidades: num(r.cantidadventas), facturacion: num(r.facturado), margen_ventas_erp: num(r.margenunidad),
      };
    }
    for (const r of lista(er?.r3)) {
      const x = M(num(r.mes));
      const k = String(r.tipogastoingreso || 'SIN DATO').trim();
      x.detalle_gastos_operacionales[k] = (x.detalle_gastos_operacionales[k] || 0) + num(r.valor);
    }
    for (const r of lista(er?.r4)) M(num(r.mes)).gastos_operacionales += num(r.valor);
    for (const r of lista(er?.r33)) {
      const x = M(num(r.mes));
      const k = String(r.tipogastoingreso || 'SIN DATO').replace(/\s+/g, ' ').trim();
      x.detalle_impuestos[k] = (x.detalle_impuestos[k] || 0) + num(r.valor);
    }
    for (const r of lista(er?.r44)) M(num(r.mes)).impuestos += num(r.valor);
    for (const r of lista(er?.r55)) M(num(r.mes)).partida_r55_sin_rotulo += num(r.valor);

    let filas = Object.values(meses).sort((a, b) => a.mes - b.mes);
    if (mesFiltro) filas = filas.filter((f) => f.mes === mesFiltro);
    const suma = (c) => filas.reduce((s, f) => s + f[c], 0);
    return {
      nota: 'Montos en CLP tal como los calcula el ERP. margen_ventas_erp es el margen de ventas del ERP (antes de gastos operacionales e impuestos). El ERP no entrega un resultado final: si se pide, calcularlo y decir cómo.',
      acumulado: {
        unidades_vendidas: suma('unidades_vendidas'), facturacion: suma('facturacion'),
        costos_totales: suma('costos_totales'), margen_ventas_erp: suma('margen_ventas_erp'),
        gastos_operacionales: suma('gastos_operacionales'), impuestos: suma('impuestos'),
      },
      meses: filas,
    };
  }

  tool(
    'erp_estado_resultado',
    'Estado de resultado de un año, mes a mes: unidades vendidas, facturación, costo de compra, costos totales, gastos de stock (reparación y activación), spread de crédito, margen de ventas del ERP, gastos operacionales (remuneraciones fijas y variables, gastos fijos y variables, marketing, cuota crédito) e impuestos SII, con acumulado del año. Opcional: un solo mes.',
    {
      anno: z.number().int().describe('Año, por ejemplo 2026'),
      mes: z.number().int().min(1).max(12).optional().describe('Solo este mes'),
    },
    async ({ anno, mes }) => traducirEstadoResultado(await call('notaventa', 'estadoresultado', { anno }), mes),
  );

  // ── inventario ─────────────────────────────────────────────────────────
  tool(
    'erp_inventario',
    'Inventario de autos. alcance="en_stock" (por defecto): autos actualmente en stock (disponibles, bloqueados, en preparación) con costo, precio de venta (ventaiva), costo total con gastos, margen esperado y días en stock, más totales del inventario inmovilizado. alcance="historico": todos los autos que han pasado por stock, incluidos los vendidos (con su nota de venta). Filtros por texto: patente, marca, modelo, estado (p. ej. DISPONIBLE, BLOQUEADO, FACTURADO).',
    {
      alcance: z.enum(['en_stock', 'historico']).default('en_stock'),
      patente: z.string().optional(),
      marca: z.string().optional(),
      modelo: z.string().optional(),
      estado: z.string().optional().describe('Estado de stock en texto, por ejemplo DISPONIBLE'),
      completo: z.boolean().default(false),
      limite: limiteSchema,
    },
    async (a) => {
      const accion = a.alcance === 'historico' ? 'getall' : 'getInmovilizado';
      const rows = lista(await call('stock', accion)).filter((r) =>
        contiene(r.patente, a.patente) && contiene(r.marca, a.marca)
        && contiene(r.modelo, a.modelo) && contiene(r.estadostock, a.estado));
      return {
        totales: {
          autos: rows.length,
          costo_total: sumar(rows, 'costototal'),
          costo_compra_iva: sumar(rows, 'costoiva'),
          precio_venta_total: sumar(rows, 'ventaiva'),
          margen_esperado: sumar(rows, 'margen'),
          por_estado: Object.fromEntries(Object.entries(rows.reduce((m, r) => {
            const k = r.estadostock || 'SIN DATO';
            m[k] = (m[k] || 0) + 1;
            return m;
          }, {}))),
        },
        ...recorta(rows, a.completo ? null : STOCK_CAMPOS, a.limite),
      };
    },
  );

  // ── rotación ───────────────────────────────────────────────────────────
  const fecha = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const dias = (desde, hasta) => Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000);
  const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });

  // Notas de venta no anuladas, por idstock (la venta más antigua de cada auto).
  async function ventasPorStock() {
    const estados = lista(await call('estadonv', 'getall'));
    const vigentes = estados.filter((e) => !/anulad/i.test(e.estadonv)).map((e) => num(e.idestadonv));
    const mapa = new Map();
    for (const est of vigentes) {
      const notas = lista(await call('notaventa', 'getall', {
        notaventa: null, patente: null, nombrecliente: null, rut: null, estado: est, mes: null, anno: null,
      }));
      for (const n of notas) {
        const id = num(n.idstock_fk);
        const f = fecha(n.registro) || fecha(n.fechafactura);
        if (!id || !f) continue;
        const prev = mapa.get(id);
        if (!prev || f < prev.fecha_venta) {
          mapa.set(id, { fecha_venta: f, nota_venta: num(n.idnotaventa), estado_nv: n.estadonv, precio_venta: precioReal(n) });
        }
      }
    }
    return mapa;
  }

  tool(
    'erp_rotacion',
    'Rotación de inventario: toma los autos comprados (ingresados a stock) entre dos fechas, indica cuáles ya se vendieron y cuáles siguen en stock, y calcula los días de rotación (ingreso → nota de venta). Entrega un ranking por marca y modelo (y por marca) ordenado de más rápido a más lento, más el detalle por auto. Fechas en formato AAAA-MM-DD.',
    {
      desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha de ingreso desde (incluida), p. ej. 2026-09-01'),
      hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha de ingreso hasta (incluida), p. ej. 2026-09-30'),
      detalle: z.boolean().default(true).describe('Incluir el detalle auto por auto'),
      orden: z.enum(['rotacion', 'retorno', 'margen']).default('rotacion')
        .describe('Orden del ranking: rotacion (días, más rápido primero), retorno (retorno anualizado %), margen ($ total)'),
    },
    async (a) => {
      const hoyF = hoyISO();
      const ventas = await ventasPorStock();
      const enRango = lista(await call('stock', 'getall'))
        .map((r) => ({ ...r, _ingreso: fecha(r.fechaingreso) }))
        .filter((r) => r._ingreso && r._ingreso >= a.desde && r._ingreso <= a.hasta);
      // Fichas de stock anuladas (compras que no se concretaron o duplicadas): se informan aparte, no cuentan.
      const anuladas = enRango.filter((r) => /anulad/i.test(r.estadostock || ''));
      const autos = enRango
        .filter((r) => !/anulad/i.test(r.estadostock || ''))
        .map((r) => {
          const v = ventas.get(num(r.idstock));
          const vendido = Boolean(v) || /factur|vendid/i.test(r.estadostock || '');
          const dRot = v ? dias(r._ingreso, v.fecha_venta) : null;
          const costoTotal = Math.max(num(r.costototal), num(r.costoiva));
          const precio = v?.precio_venta || num(r.ventaiva);
          const margen = vendido && precio ? precio - costoTotal : null;
          return {
            patente: r.patente,
            marca: String(r.marca || '').trim(),
            modelo: String(r.modelo ?? '').trim(),
            version: String(r.version || '').trim(),
            anno: r.anno,
            fecha_ingreso: r._ingreso,
            estado_stock: r.estadostock,
            vendido,
            fecha_venta: v?.fecha_venta ?? null,
            nota_venta: v?.nota_venta ?? (num(r.notaventa) || null),
            dias_rotacion: dRot,
            dias_en_stock: vendido ? null : dias(r._ingreso, hoyF),
            costo_compra_iva: num(r.costoiva),
            costo_total: costoTotal,
            precio_venta_iva: precio,
            margen: margen,
            margen_pct: margen !== null && costoTotal ? Math.round((margen / costoTotal) * 1000) / 10 : null,
          };
        });

      const rankear = (claveFn) => {
        const g = new Map();
        for (const x of autos) {
          const k = claveFn(x);
          const e = g.get(k) || {
            grupo: k, compras: 0, vendidos: 0, en_stock: 0, _rot: [], _stock: [], _m: 0, _c: 0, _mDias: 0, _nm: 0,
          };
          e.compras++;
          if (x.vendido) {
            e.vendidos++;
            if (x.dias_rotacion !== null) e._rot.push(x.dias_rotacion);
            if (x.margen !== null && x.dias_rotacion !== null) {
              e._m += x.margen;
              e._c += x.costo_total;
              e._mDias += Math.max(x.dias_rotacion, 1);
              e._nm++;
            }
          } else {
            e.en_stock++;
            e._stock.push(x.dias_en_stock);
          }
          g.set(k, e);
        }
        const prom = (arr) => (arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null);
        return [...g.values()]
          .map(({ _rot, _stock, _m, _c, _mDias, _nm, ...e }) => {
            const rot = prom(_rot);
            const margenPct = _c ? (_m / _c) * 100 : null;
            return {
              ...e,
              rotacion_promedio_dias: rot,
              rotacion_min_dias: _rot.length ? Math.min(..._rot) : null,
              rotacion_max_dias: _rot.length ? Math.max(..._rot) : null,
              indice_rotacion_anual: rot ? Math.round((365 / Math.max(rot, 1)) * 10) / 10 : null,
              margen_total: _nm ? _m : null,
              margen_promedio: _nm ? Math.round(_m / _nm) : null,
              margen_pct: margenPct !== null ? Math.round(margenPct * 10) / 10 : null,
              margen_por_dia: _nm ? Math.round(_m / _mDias) : null,
              retorno_anual_estimado_pct: margenPct !== null && rot
                ? Math.round(margenPct * (365 / Math.max(rot, 1))) : null,
              dias_promedio_en_stock_no_vendidos: prom(_stock),
            };
          })
          .sort((x, y) => {
            const sinVenta = (z) => (z.rotacion_promedio_dias === null ? 1 : 0);
            if (sinVenta(x) !== sinVenta(y)) return sinVenta(x) - sinVenta(y);
            if (a.orden === 'retorno') return (y.retorno_anual_estimado_pct ?? -1e9) - (x.retorno_anual_estimado_pct ?? -1e9);
            if (a.orden === 'margen') return (y.margen_total ?? -1e9) - (x.margen_total ?? -1e9);
            return (x.rotacion_promedio_dias ?? Infinity) - (y.rotacion_promedio_dias ?? Infinity)
              || (y.dias_promedio_en_stock_no_vendidos ?? 0) - (x.dias_promedio_en_stock_no_vendidos ?? 0);
          })
          .map((e, i) => ({ puesto: i + 1, ...e }));
      };

      const vendidos = autos.filter((x) => x.vendido && x.dias_rotacion !== null);
      const conMargen = vendidos.filter((x) => x.margen !== null);
      const mTot = conMargen.reduce((s, x) => s + x.margen, 0);
      const cTot = conMargen.reduce((s, x) => s + x.costo_total, 0);
      return {
        periodo_ingreso: { desde: a.desde, hasta: a.hasta, calculado_al: hoyF },
        resumen: {
          autos_comprados: autos.length,
          vendidos: autos.filter((x) => x.vendido).length,
          en_stock: autos.filter((x) => !x.vendido).length,
          rotacion_promedio_dias: vendidos.length
            ? Math.round(vendidos.reduce((s, x) => s + x.dias_rotacion, 0) / vendidos.length) : null,
          margen_total: conMargen.length ? mTot : null,
          margen_pct: cTot ? Math.round((mTot / cTot) * 1000) / 10 : null,
          fichas_anuladas_excluidas: anuladas.map((r) => `${r.patente} ${String(r.marca || '').trim()} ${String(r.modelo ?? '').trim()}`),
        },
        nota: 'Rotación = días entre ingreso a stock y nota de venta (registro; si no hay, fecha de factura); notas anuladas no cuentan. Margen = precio de venta − costo total (compra + gastos del auto), ambos con IVA, solo autos vendidos; margen_pct sobre costo total. indice_rotacion_anual = 365 / rotación promedio (veces que el capital da la vuelta en un año). retorno_anual_estimado_pct = margen_pct × índice: rentabilidad anualizada del capital invertido en ese modelo. Grupos con 1-2 ventas son poco concluyentes.',
        ranking_marca_modelo: rankear((x) => `${x.marca} ${x.modelo}`.trim()),
        ranking_marca: rankear((x) => x.marca || 'SIN MARCA'),
        ...(a.detalle ? { autos: autos.sort((x, y) => (x.dias_rotacion ?? 1e9) - (y.dias_rotacion ?? 1e9)) } : {}),
      };
    },
  );

  // ── ventas por comuna ──────────────────────────────────────────────────
  async function notasNoAnuladas() {
    const estados = lista(await call('estadonv', 'getall'));
    const ids = estados.filter((e) => !/anulad/i.test(e.estadonv)).map((e) => num(e.idestadonv));
    const out = [];
    for (const est of ids) {
      out.push(...lista(await call('notaventa', 'getall', {
        notaventa: null, patente: null, nombrecliente: null, rut: null, estado: est, mes: null, anno: null,
      })));
    }
    return out;
  }

  const nombreLimpio = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toUpperCase();
  const top = (mapa, n) => Object.entries(mapa).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([nombre, ventas]) => ({ nombre, ventas }));

  tool(
    'erp_ventas_por_comuna',
    'Ranking de comunas según dónde viven los clientes que compraron (notas de venta no anuladas, por fecha de la nota). Para cada comuna: cantidad de ventas, monto vendido, participación, región, y las marcas y modelos que más compran ahí. Cruza la nota de venta con la ficha del cliente. Fechas AAAA-MM-DD; sin fechas usa el año actual.',
    {
      desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      top_comunas: z.number().int().min(1).max(200).default(30).describe('Cuántas comunas mostrar'),
      top_por_comuna: z.number().int().min(1).max(20).default(5).describe('Cuántas marcas/modelos mostrar por comuna'),
      marca: z.string().optional().describe('Filtrar ventas por marca'),
      modelo: z.string().optional().describe('Filtrar ventas por modelo'),
    },
    async (a) => {
      const anno = hoy().anno;
      const desde = a.desde ?? `${anno}-01-01`;
      const hasta = a.hasta ?? `${anno}-12-31`;
      const [notas, clientes] = await Promise.all([notasNoAnuladas(), call('clientes', 'getall')]);
      const porId = new Map(lista(clientes).map((c) => [num(c.idclientes), c]));

      const ventas = notas
        .map((n) => ({ ...n, _f: fecha(n.registro) || fecha(n.fechafactura) }))
        .filter((n) => n._f && n._f >= desde && n._f <= hasta)
        .filter((n) => contiene(n.marca, a.marca) && contiene(n.modelo, a.modelo));

      const comunas = new Map();
      let sinComuna = 0;
      for (const n of ventas) {
        const c = porId.get(num(n.idclientes_fk));
        const comuna = nombreLimpio(c?.comuna) || 'SIN COMUNA REGISTRADA';
        if (comuna === 'SIN COMUNA REGISTRADA') sinComuna++;
        const e = comunas.get(comuna) || { comuna, region: nombreLimpio(c?.region) || null, ventas: 0, monto: 0, _marcas: {}, _modelos: {} };
        e.ventas++;
        e.monto += precioReal(n);
        const marca = nombreLimpio(n.marca) || 'SIN MARCA';
        const modelo = `${marca} ${nombreLimpio(n.modelo)}`.trim();
        e._marcas[marca] = (e._marcas[marca] || 0) + 1;
        e._modelos[modelo] = (e._modelos[modelo] || 0) + 1;
        comunas.set(comuna, e);
      }

      const total = ventas.length;
      const montoTotal = ventas.reduce((s, n) => s + precioReal(n), 0);
      const ranking = [...comunas.values()]
        .sort((x, y) => y.ventas - x.ventas || y.monto - x.monto)
        .slice(0, a.top_comunas)
        .map((e, i) => ({
          puesto: i + 1,
          comuna: e.comuna,
          region: e.region,
          ventas: e.ventas,
          participacion_pct: total ? Math.round((e.ventas / total) * 1000) / 10 : 0,
          monto_vendido: e.monto,
          ticket_promedio: e.ventas ? Math.round(e.monto / e.ventas) : 0,
          top_marcas: top(e._marcas, a.top_por_comuna),
          top_modelos: top(e._modelos, a.top_por_comuna),
        }));

      const regiones = {};
      for (const e of comunas.values()) {
        const r = e.region || 'SIN REGIÓN';
        regiones[r] = (regiones[r] || 0) + e.ventas;
      }

      return {
        periodo: { desde, hasta },
        resumen: {
          ventas: total,
          monto_vendido: montoTotal,
          comunas_distintas: [...comunas.keys()].filter((k) => k !== 'SIN COMUNA REGISTRADA').length,
          ventas_sin_comuna_registrada: sinComuna,
          cobertura_comuna_pct: total ? Math.round(((total - sinComuna) / total) * 1000) / 10 : 0,
        },
        ventas_por_region: Object.fromEntries(Object.entries(regiones).sort((x, y) => y[1] - x[1])),
        ranking_comunas: ranking,
        nota: 'Comuna tomada de la ficha del cliente en el ERP. Montos = precio de venta con IVA de la nota de venta.',
      };
    },
  );

  tool(
    'erp_gastos_por_auto',
    'Gastos cargados a autos del stock (transferencias, multas, reparaciones, preparación, etc.). Filtra por patente o idstock; sin filtro devuelve todos con totales por tipo de gasto.',
    {
      patente: z.string().optional(),
      idstock: z.number().int().optional(),
      limite: limiteSchema,
    },
    async (a) => {
      let ids = null;
      if (a.patente) {
        const autos = lista(await call('stock', 'getall')).filter((r) => contiene(r.patente, a.patente));
        if (!autos.length) throw new Error(`No hay autos con patente ${a.patente}`);
        ids = new Set(autos.map((r) => num(r.idstock)));
      }
      if (a.idstock) ids = new Set([a.idstock]);
      const rows = lista(await call('stockgastos', 'getall')).filter((r) => !ids || ids.has(num(r.idstock_fk)));
      return {
        totales: { registros: rows.length, total: sumar(rows, 'valor'), por_tipo: agrupar(rows, 'destipogasto', 'valor') },
        ...recorta(rows, null, a.limite),
      };
    },
  );

  tool(
    'erp_precio_toma',
    'Historial de tasaciones / precio de toma de autos usados: precio Clicar (referencia de mercado) y precio de compra. Filtros por patente, marca, modelo y año del auto.',
    {
      patente: z.string().optional(),
      marca: z.string().optional(),
      modelo: z.string().optional(),
      anno: z.number().int().optional().describe('Año del vehículo'),
      limite: limiteSchema,
    },
    async (a) => {
      const rows = lista(await call('preciotoma', 'getall')).filter((r) =>
        contiene(r.patente, a.patente) && contiene(r.marca, a.marca) && contiene(r.modelo, a.modelo)
        && (!a.anno || num(r.anno) === a.anno));
      return recorta(rows, null, a.limite);
    },
  );

  // ── caja y bancos ──────────────────────────────────────────────────────
  tool(
    'erp_caja_movimientos',
    'Movimientos de caja de un mes (módulo Ingresos-Gastos): cada gasto (egreso) e ingreso con fecha, tipo, banco y glosa. Incluye totales de ingresos, gastos y neto, por tipo y por banco. Sin mes/año usa el mes actual. Filtro opcional por tipo (E=egresos/gastos, I=ingresos), banco o texto en la glosa.',
    {
      mes: mesSchema,
      anno: annoSchema,
      modo: z.enum(['todos', 'E', 'I']).default('todos').describe('E = solo gastos, I = solo ingresos'),
      banco: z.string().optional(),
      buscar: z.string().optional().describe('Texto a buscar en la glosa o el tipo'),
      limite: limiteSchema,
    },
    async (a) => {
      const p = await periodo(a.mes, a.anno);
      const rows = lista(await call('gastosingresos', 'getall', {}, { id: p.idgastosingresosperiodo })).filter((r) =>
        (a.modo === 'todos' || r.eimodo === a.modo) && contiene(r.desbanco, a.banco)
        && (!a.buscar || contiene(`${r.apellidogasto} ${r.tipogastoingreso}`, a.buscar)));
      const ingresos = sumar(rows, 'valoringreso');
      const gastos = sumar(rows, 'valorgasto');
      return {
        periodo: { mes: num(p.mes), anno: num(p.anno) },
        totales: {
          movimientos: rows.length,
          ingresos,
          gastos,
          neto: ingresos - gastos,
          gastos_por_tipo: agrupar(rows, 'tipogastoingreso', 'valorgasto'),
          ingresos_por_tipo: agrupar(rows, 'tipogastoingreso', 'valoringreso'),
          gastos_por_banco: agrupar(rows, 'desbanco', 'valorgasto'),
          ingresos_por_banco: agrupar(rows, 'desbanco', 'valoringreso'),
        },
        ...recorta(rows, ['fecha', 'eimodo', 'tipogastoingreso', 'apellidogasto', 'valoringreso', 'valorgasto', 'desbanco'], a.limite),
      };
    },
  );

  tool(
    'erp_saldos',
    'Saldos de un mes: saldo de cuenta corriente por banco (Itaú, Santander, Banco Chile, etc.) y total, más el inventario inmovilizado y las cuentas por cobrar del período. Sin mes/año usa el mes actual.',
    { mes: mesSchema, anno: annoSchema },
    async (a) => {
      const p = await periodo(a.mes, a.anno);
      const bancos = lista(await call('estadocuentacorriente', 'getall', {}, { id: p.idgastosingresosperiodo }));
      const total = sumar(bancos, 'valor');
      return {
        periodo: { mes: num(p.mes), anno: num(p.anno) },
        saldos_bancos: bancos.map((b) => ({ banco: b.desbanco, saldo: num(b.valor) })),
        total_bancos: total,
        inventario_inmovilizado: num(p.inmovilizado),
        cuentas_por_cobrar: num(p.porcobrar),
      };
    },
  );

  tool(
    'erp_cuentas_por_cobrar',
    'Otras cuentas por cobrar / traspasos (módulo Cuentas por cobrar): fecha, concepto, valor, si está pagado, banco de salida/entrada y si es comisión. Filtro pendientes=true para ver solo las no pagadas.',
    { pendientes: z.boolean().default(false), limite: limiteSchema },
    async (a) => {
      const rows = lista(await call('salidasotrosconceptos', 'getall'))
        .filter((r) => !a.pendientes || !num(r.pagado));
      return {
        totales: { registros: rows.length, total: sumar(rows, 'valor') },
        ...recorta(rows, null, a.limite),
      };
    },
  );

  // ── clientes ───────────────────────────────────────────────────────────
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
      return recorta(lista(rows), a.completo ? null : CLIENTE_CAMPOS, a.limite);
    },
  );

  // ── avanzado ───────────────────────────────────────────────────────────
  tool(
    'erp_consulta_lectura',
    'Consulta avanzada de solo lectura: llama a destino.accion del ERP con un dataForm libre y un id opcional. Solo acciones de lectura. Úsala solo si ninguna otra herramienta cubre la pregunta.',
    {
      destino: z.string().regex(/^\w+$/),
      accion: z.string().regex(/^\w+$/),
      dataForm: z.record(z.any()).default({}),
      id: z.union([z.number(), z.string()]).optional(),
      limite: limiteSchema,
    },
    async (a) => {
      if (!esLectura(a.destino, a.accion)) throw new Error('Solo se permiten acciones de lectura');
      const rows = await call(a.destino, a.accion, a.dataForm, a.id !== undefined ? { id: a.id } : {});
      return recorta(rows, null, a.limite);
    },
  );

  // ── ESCRITURA: registrar ingreso/egreso de caja (única escritura permitida) ──
  const norm = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  // Medianoche de Santiago de esa fecha, en UTC (como lo envía el datepicker del ERP).
  const medianocheSantiago = (f) => {
    const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', timeZoneName: 'longOffset' })
      .format(new Date(`${f}T12:00:00Z`)).match(/GMT([+-])(\d{2}):(\d{2})/);
    const h = off ? (off[1] === '-' ? 1 : -1) * (Number(off[2]) + Number(off[3]) / 60) : 3;
    return new Date(Date.parse(`${f}T00:00:00Z`) + h * 3600000).toISOString();
  };
  const elegir = (filas, campoId, campoNombre, buscado, que) => {
    if (/^\d+$/.test(String(buscado))) {
      const f = filas.find((x) => num(x[campoId]) === Number(buscado));
      if (f) return f;
    }
    const b = norm(buscado);
    const exactos = filas.filter((x) => norm(x[campoNombre]) === b);
    if (exactos.length === 1) return exactos[0];
    const parciales = filas.filter((x) => norm(x[campoNombre]).includes(b));
    if (parciales.length === 1) return parciales[0];
    const opciones = filas.map((x) => norm(x[campoNombre])).join(' | ');
    throw new Error(`${que} "${buscado}" ${parciales.length ? 'es ambiguo' : 'no existe'}. Opciones: ${opciones}`);
  };
  const BITACORA = new URL('./bitacora-escrituras.jsonl', import.meta.url);

  tool(
    'erp_registrar_movimiento_caja',
    'ESCRIBE en el ERP: registra un egreso (gasto) o ingreso en el módulo Ingresos-Gastos (caja). Flujo obligatorio en dos pasos: 1) llamar con confirmar=false (por defecto) para obtener la VISTA PREVIA y mostrársela al usuario; 2) solo después de que el usuario diga explícitamente que sí, llamar de nuevo con los mismos datos y confirmar=true. Nunca usar confirmar=true sin la aprobación explícita del usuario en este turno. La categoría y el banco se aceptan por nombre (sin tildes, parcial) o id; "caja chica" no existe como banco (lo más cercano es Efectivo). Queda registro en una bitácora local.',
    {
      tipo: z.enum(['egreso', 'ingreso']),
      monto: z.number().int().positive().describe('Monto en pesos, entero'),
      categoria: z.string().describe('Tipo de gasto/ingreso, p. ej. "DEVOLUCION CLIENTE", "GASTO VARIABLE MARKETING", "INGRESO"'),
      glosa: z.string().min(3).max(120).describe('Detalle; idealmente incluir patente o n° de nota'),
      banco: z.string().describe('Cuenta: Santander, Itau, Banco Chile, Efectivo…'),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('AAAA-MM-DD; por defecto hoy'),
      confirmar: z.boolean().default(false),
    },
    async (a) => {
      const f = a.fecha ?? hoyISO();
      const [tipos, bancos] = await Promise.all([call('gastosingresostipo', 'getall'), call('banco', 'getall')]);
      const t = elegir(lista(tipos), 'idgastosingresostipo', 'tipogastoingreso', a.categoria, 'Categoría');
      const b = elegir(lista(bancos), 'idbanco', 'desbanco', a.banco, 'Banco');
      const p = await periodo(Number(f.slice(5, 7)), Number(f.slice(0, 4)));
      const egreso = a.tipo === 'egreso';
      const dataForm = {
        idgastosingresosperiodo_fk: num(p.idgastosingresosperiodo),
        idgastosingresostipo_fk: num(t.idgastosingresostipo),
        valorgasto: egreso ? a.monto : null,
        eimodo: egreso ? 'E' : 'I',
        fecha: medianocheSantiago(f),
        valoringreso: egreso ? null : a.monto,
        apellidogasto: norm(a.glosa),
        idbanco_fk: num(b.idbanco),
      };
      const vista = {
        periodo: `${p.mes}/${p.anno}`, fecha: f, tipo: egreso ? 'EGRESO' : 'INGRESO',
        categoria: norm(t.tipogastoingreso), glosa: dataForm.apellidogasto, banco: b.desbanco, monto: a.monto,
      };
      if (!a.confirmar) {
        return { estado: 'VISTA_PREVIA (no se ha guardado nada)', registro: vista, siguiente_paso: 'Mostrar al usuario y pedir confirmación explícita; luego repetir con confirmar=true.' };
      }
      const res = await escribir('gastosingresos', 'add', dataForm);
      limpiarCache();
      // Verificación: busca el registro recién creado en el período.
      const movs = lista(await call('gastosingresos', 'getall', {}, { id: num(p.idgastosingresosperiodo) }));
      const creado = movs
        .filter((m) => norm(m.apellidogasto) === dataForm.apellidogasto && num(egreso ? m.valorgasto : m.valoringreso) === a.monto)
        .sort((x, y) => num(y.idgastosingresos) - num(x.idgastosingresos))[0];
      try {
        fs.appendFileSync(BITACORA, JSON.stringify({ ts: new Date().toISOString(), accion: 'gastosingresos.add', registro: vista, id: creado?.idgastosingresos ?? null, respuesta: res?.message ?? null }) + '\n');
      } catch { /* la bitácora es best-effort */ }
      return { estado: res?.estado === 'OK' ? 'GUARDADO' : 'RESPUESTA_INESPERADA', mensaje_erp: res?.message ?? null, id_registro: creado?.idgastosingresos ?? null, verificado: Boolean(creado), registro: vista };
    },
  );

  // Motor de análisis general (consultas libres sin código nuevo).
  registrarAnalisis(tool, call);

  return server;
}
