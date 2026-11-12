// Motor de análisis general del ERP: datasets ya cruzados + consultas declarativas (filtrar, agrupar, métricas).
// Permite responder preguntas nuevas sin escribir código nuevo. Solo lectura.
import { z } from 'zod';

// Caché por proceso (5 min) para no repetir llamadas pesadas al ERP entre consultas seguidas.
const CACHE = new Map();
const TTL = 5 * 60 * 1000;
async function cache(clave, fn) {
  const c = CACHE.get(clave);
  if (c && Date.now() - c.t < TTL) return c.v;
  const v = await fn();
  CACHE.set(clave, { t: Date.now(), v });
  return v;
}

export const limpiarCache = () => CACHE.clear();

const lista = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const fecha = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const dias = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
const limpio = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ').trim().toUpperCase();
const partes = (f) => (f ? { anno: Number(f.slice(0, 4)), mes: Number(f.slice(5, 7)), anno_mes: f.slice(0, 7) } : { anno: null, mes: null, anno_mes: null });
const r1 = (v) => Math.round(v * 10) / 10;

// ── campos de cada dataset (documentación para Claude) ───────────────────
export const DATASETS = {
  ventas: {
    desc: 'Notas de venta no anuladas (una fila por auto vendido), cruzadas con el auto del stock y la ficha del cliente.',
    campos: {
      id_nota: 'n°', fecha_venta: 'AAAA-MM-DD (registro de la nota)', anno: 'año venta', mes: 'mes venta', anno_mes: 'AAAA-MM',
      estado_nv: 'VIGENTE/FACTURADA', vendedor: 'texto', sucursal: 'texto', forma_pago: 'CONTADO/CRÉDITO…', financiera: 'texto',
      pie: '$', plazo: 'meses', spread_credito: '$', parte_pago: 'S/N auto en parte de pago',
      patente: 'texto', marca: 'texto', modelo: 'texto', marca_modelo: 'texto', version: 'texto', anno_auto: 'año del auto',
      kilometraje: 'km', tipo_auto: 'USADO/NUEVO', precio_venta: '$ precio real final (precio venta descuento)', precio_lista: '$ precio lista de la nota (antes de descuentos)', descuento: '$ precio_lista − precio_venta', gastos_negocio: '$ gastos cargo al negocio de la nota (transferencia, garantía…)', margen_neto: '$ margen − gastos_negocio', costo_compra: '$ con IVA',
      costo_total: '$ compra + gastos del auto', margen: '$ precio_venta − costo_total', margen_pct: '% sobre costo_total',
      fecha_ingreso: 'AAAA-MM-DD ingreso a stock', dias_rotacion: 'días ingreso → venta',
      comuna: 'comuna del cliente', region: 'región del cliente', origen_cliente: 'canal de origen del cliente', tipo_cliente: 'texto',
    },
  },
  stock: {
    desc: 'Todos los autos que han ingresado a stock (compras), vendidos o no; las fichas anuladas vienen con anulada=true.',
    campos: {
      idstock: 'id', patente: 'texto', marca: 'texto', modelo: 'texto', marca_modelo: 'texto', version: 'texto', anno_auto: 'año auto',
      kilometraje: 'km', color: 'texto', tipo_auto: 'texto', estado_stock: 'DISPONIBLE/BLOQUEADO/FACTURADO/ANULADO…',
      sucursal: 'texto', origen_stock: 'Compra Usado/Consignación…', fecha_ingreso: 'AAAA-MM-DD', anno: 'año ingreso',
      mes: 'mes ingreso', anno_mes: 'AAAA-MM ingreso', costo_compra: '$', costo_total: '$', gastos_auto: '$ costo_total − costo_compra',
      precio_lista: '$ precio de venta publicado', vendido: 'true/false (nota de venta no anulada)', fecha_venta: 'AAAA-MM-DD',
      precio_venta: '$ real final de la nota (precio venta descuento)', margen: '$ (vendidos)', margen_pct: '% (vendidos)', dias_rotacion: 'días ingreso → venta (vendidos)',
      dias_en_stock: 'días desde ingreso hasta hoy (no vendidos)', anulada: 'true/false',
    },
  },
  caja: {
    desc: 'Movimientos de caja del módulo Ingresos-Gastos (todos los períodos).',
    campos: {
      fecha: 'AAAA-MM-DD', anno: 'año del período', mes: 'mes del período', anno_mes: 'AAAA-MM', tipo: 'GASTO/INGRESO',
      categoria: 'tipo de gasto/ingreso (p. ej. GASTO VARIABLE MARKETING)', glosa: 'detalle', banco: 'texto',
      ingreso: '$', gasto: '$', neto: '$ ingreso − gasto',
    },
  },
  gastos_auto: {
    desc: 'Gastos cargados a cada auto del stock (transferencia, reparación, permiso, etc.).',
    campos: {
      patente: 'texto', marca: 'texto', modelo: 'texto', marca_modelo: 'texto', tipo_gasto: 'texto', valor: '$',
      fecha: 'AAAA-MM-DD', anno: 'año', mes: 'mes', anno_mes: 'AAAA-MM', comentario: 'texto', estado_stock: 'texto',
    },
  },
  clientes: {
    desc: 'Clientes y prospectos (leads) del CRM del ERP, sin datos de contacto.',
    campos: {
      idclientes: 'id', fecha_registro: 'AAAA-MM-DD', anno: 'año registro', mes: 'mes registro', anno_mes: 'AAAA-MM',
      comuna: 'texto', region: 'texto', origen: 'canal de origen', tipo_cliente: 'texto', vendedor_asignado: 'texto',
      creado_por: 'texto', estado: 'texto', compro: 'true/false (tiene nota de venta no anulada)',
      marca_interes: 'texto', modelo_interes: 'texto', con_credito: 'texto', gestiones: 'n° de gestiones',
    },
  },
  precio_toma: {
    desc: 'Tasaciones / precio de toma de autos usados.',
    campos: {
      patente: 'texto', marca: 'texto', modelo: 'texto', marca_modelo: 'texto', version: 'texto', anno_auto: 'año',
      kilometraje: 'km', precio_clicar: '$ referencia mercado', precio_compra: '$ ofrecido/pagado',
      diferencia: '$ precio_clicar − precio_compra',
    },
  },
};

export function registrarAnalisis(tool, call) {
  // ── cargas base (con caché) ────────────────────────────────────────────
  const notasNoAnuladas = () => cache('notas', async () => {
    const estados = lista(await call('estadonv', 'getall'));
    const ids = estados.filter((e) => !/anulad/i.test(e.estadonv)).map((e) => num(e.idestadonv));
    const out = [];
    for (const est of ids) {
      out.push(...lista(await call('notaventa', 'getall', {
        notaventa: null, patente: null, nombrecliente: null, rut: null, estado: est, mes: null, anno: null,
      })));
    }
    return out;
  });
  const stockTodo = () => cache('stock', async () => lista(await call('stock', 'getall')));
  const clientesTodo = () => cache('clientes', async () => lista(await call('clientes', 'getall')));

  // Primera venta (no anulada) de cada idstock.
  const ventaPorStock = (notas) => {
    const m = new Map();
    for (const n of notas) {
      const id = num(n.idstock_fk);
      const f = fecha(n.registro) || fecha(n.fechafactura);
      if (!id || !f) continue;
      if (!m.has(id) || f < m.get(id)._f) m.set(id, { ...n, _f: f });
    }
    return m;
  };

  // ── constructores de datasets ──────────────────────────────────────────
  const construir = {
    async ventas() {
      const [notas, stock, clientes] = await Promise.all([notasNoAnuladas(), stockTodo(), clientesTodo()]);
      const st = new Map(stock.map((s) => [num(s.idstock), s]));
      const cl = new Map(clientes.map((c) => [num(c.idclientes), c]));
      return notas.map((n) => {
        const f = fecha(n.registro) || fecha(n.fechafactura);
        const s = st.get(num(n.idstock_fk)) || {};
        const c = cl.get(num(n.idclientes_fk)) || {};
        const ingreso = fecha(s.fechaingreso);
        const costoTotal = Math.max(num(s.costototal), num(n.costoiva), num(s.costoiva));
        const lista_ = num(n.ventaiva);
        const precio = num(n.ventadescuentos) || lista_;
        const margen = precio && costoTotal ? precio - costoTotal : null;
        const gNeg = num(n.gastoscargonegocio);
        const marca = limpio(n.marca);
        const modelo = limpio(n.modelo);
        return {
          id_nota: num(n.idnotaventa), fecha_venta: f, ...partes(f), estado_nv: n.estadonv,
          vendedor: limpio(n.vendedor), sucursal: limpio(n.sucursal), forma_pago: limpio(n.formapago),
          financiera: limpio(n.entidadfinanciera) || null, pie: num(n.pie), plazo: num(n.plazo),
          spread_credito: num(n.spreadcredito), parte_pago: n.autopartepago || null,
          patente: n.patente, marca, modelo, marca_modelo: `${marca} ${modelo}`.trim(), version: limpio(n.version),
          anno_auto: num(n.anno) || null, kilometraje: num(n.kilometraje) || null, tipo_auto: limpio(n.tipoauto),
          precio_venta: precio, precio_lista: lista_, descuento: lista_ - precio, gastos_negocio: gNeg,
          costo_compra: num(n.costoiva), costo_total: costoTotal,
          margen, margen_pct: margen !== null && costoTotal ? r1((margen / costoTotal) * 100) : null,
          margen_neto: margen !== null ? margen - gNeg : null,
          fecha_ingreso: ingreso, dias_rotacion: ingreso && f ? Math.max(dias(ingreso, f), 0) : null,
          comuna: limpio(c.comuna) || null, region: limpio(c.region) || null,
          origen_cliente: limpio(c.descripcionorigencliente) || null, tipo_cliente: limpio(c.descripciontipocliente) || null,
        };
      }).filter((v) => v.fecha_venta);
    },

    async stock() {
      const [notas, stock] = await Promise.all([notasNoAnuladas(), stockTodo()]);
      const vp = ventaPorStock(notas);
      const hoy = hoyISO();
      return stock.map((s) => {
        const ingreso = fecha(s.fechaingreso);
        const v = vp.get(num(s.idstock));
        const anulada = /anulad/i.test(s.estadostock || '');
        const vendido = Boolean(v) || /factur|vendid/i.test(s.estadostock || '');
        const costoCompra = num(s.costoiva);
        const costoTotal = Math.max(num(s.costototal), costoCompra);
        const precioVenta = v ? (num(v.ventadescuentos) || num(v.ventaiva)) : null;
        const margen = vendido && precioVenta ? precioVenta - costoTotal : null;
        const marca = limpio(s.marca);
        const modelo = limpio(s.modelo);
        return {
          idstock: num(s.idstock), patente: s.patente, marca, modelo, marca_modelo: `${marca} ${modelo}`.trim(),
          version: limpio(s.version), anno_auto: num(s.anno) || null, kilometraje: num(s.kilometraje) || null,
          color: limpio(s.color), tipo_auto: limpio(s.tipoauto), estado_stock: limpio(s.estadostock),
          sucursal: limpio(s.sucursal), origen_stock: limpio(s.origenstock), fecha_ingreso: ingreso, ...partes(ingreso),
          costo_compra: costoCompra, costo_total: costoTotal, gastos_auto: costoTotal - costoCompra,
          precio_lista: num(s.ventaiva), vendido, fecha_venta: v?._f ?? null, precio_venta: precioVenta,
          margen, margen_pct: margen !== null && costoTotal ? r1((margen / costoTotal) * 100) : null,
          dias_rotacion: v && ingreso ? Math.max(dias(ingreso, v._f), 0) : null,
          dias_en_stock: !vendido && !anulada && ingreso ? dias(ingreso, hoy) : null,
          anulada,
        };
      });
    },

    async caja() {
      return cache('caja', async () => {
        const periodos = lista(await call('gastosingresosperiodo', 'getall'));
        const out = [];
        for (let i = 0; i < periodos.length; i += 5) {
          const lote = periodos.slice(i, i + 5);
          const res = await Promise.all(lote.map(async (p) => {
            try {
              return { p, rows: lista(await call('gastosingresos', 'getall', {}, { id: p.idgastosingresosperiodo })) };
            } catch {
              return { p, rows: [] };
            }
          }));
          for (const { p, rows } of res) {
            for (const r of rows) {
              const ing = num(r.valoringreso);
              const gas = num(r.valorgasto);
              out.push({
                fecha: fecha(r.fecha), anno: num(p.anno), mes: num(p.mes),
                anno_mes: `${p.anno}-${String(p.mes).padStart(2, '0')}`,
                tipo: r.eimodo === 'I' ? 'INGRESO' : 'GASTO', categoria: limpio(r.tipogastoingreso),
                glosa: limpio(r.apellidogasto), banco: limpio(r.desbanco), ingreso: ing, gasto: gas, neto: ing - gas,
              });
            }
          }
        }
        return out;
      });
    },

    async gastos_auto() {
      const [gastos, stock] = await Promise.all([
        cache('stockgastos', async () => lista(await call('stockgastos', 'getall'))), stockTodo(),
      ]);
      const st = new Map(stock.map((s) => [num(s.idstock), s]));
      return gastos.map((g) => {
        const s = st.get(num(g.idstock_fk)) || {};
        const f = fecha(g.registro);
        const marca = limpio(s.marca);
        const modelo = limpio(s.modelo);
        return {
          patente: s.patente ?? null, marca, modelo, marca_modelo: `${marca} ${modelo}`.trim(),
          tipo_gasto: limpio(g.destipogasto), valor: num(g.valor), fecha: f, ...partes(f),
          comentario: limpio(g.comentarios) || null, estado_stock: limpio(s.estadostock),
        };
      });
    },

    async clientes() {
      const [clientes, notas] = await Promise.all([clientesTodo(), notasNoAnuladas()]);
      const compradores = new Set(notas.map((n) => num(n.idclientes_fk)));
      return clientes.map((c) => {
        const f = fecha(c.registro);
        return {
          idclientes: num(c.idclientes), fecha_registro: f, ...partes(f), comuna: limpio(c.comuna) || null,
          region: limpio(c.region) || null, origen: limpio(c.descripcionorigencliente) || null,
          tipo_cliente: limpio(c.descripciontipocliente) || null, vendedor_asignado: limpio(c.vendedor_asignado) || null,
          creado_por: limpio(c.usuariocreo) || null, estado: c.estado ?? null, compro: compradores.has(num(c.idclientes)),
          marca_interes: limpio(c.marca) || null, modelo_interes: limpio(c.modelo) || null,
          con_credito: c.concredito ?? null, gestiones: num(c.cnt_gestion),
        };
      });
    },

    async precio_toma() {
      const rows = await cache('preciotoma', async () => lista(await call('preciotoma', 'getall')));
      return rows.map((r) => {
        const marca = limpio(r.marca);
        const modelo = limpio(r.modelo);
        return {
          patente: r.patente, marca, modelo, marca_modelo: `${marca} ${modelo}`.trim(), version: limpio(r.version),
          anno_auto: num(r.anno) || null, kilometraje: num(r.kilometraje) || null,
          precio_clicar: num(r.precioclicar) || null, precio_compra: num(r.preciocompra) || null,
          diferencia: num(r.precioclicar) && num(r.preciocompra) ? num(r.precioclicar) - num(r.preciocompra) : null,
        };
      });
    },
  };

  // ── motor de consulta ──────────────────────────────────────────────────
  const OPS = ['eq', 'neq', 'contiene', 'no_contiene', 'gt', 'gte', 'lt', 'lte', 'entre', 'en', 'vacio', 'no_vacio'];
  const METRICAS = ['count', 'count_distinct', 'sum', 'avg', 'median', 'min', 'max'];

  const comparar = (v, op, valor) => {
    const esTexto = typeof v === 'string' || typeof valor === 'string';
    const norm = (x) => (typeof x === 'string' ? limpio(x) : x);
    switch (op) {
      case 'eq': return esTexto ? limpio(v) === limpio(valor) : v === valor;
      case 'neq': return esTexto ? limpio(v) !== limpio(valor) : v !== valor;
      case 'contiene': return limpio(v).includes(limpio(valor));
      case 'no_contiene': return !limpio(v).includes(limpio(valor));
      case 'gt': return v !== null && norm(v) > norm(valor);
      case 'gte': return v !== null && norm(v) >= norm(valor);
      case 'lt': return v !== null && norm(v) < norm(valor);
      case 'lte': return v !== null && norm(v) <= norm(valor);
      case 'entre': return v !== null && Array.isArray(valor) && norm(v) >= norm(valor[0]) && norm(v) <= norm(valor[1]);
      case 'en': return Array.isArray(valor) && valor.some((x) => (esTexto ? limpio(v) === limpio(x) : v === x));
      case 'vacio': return v === null || v === undefined || v === '';
      case 'no_vacio': return !(v === null || v === undefined || v === '');
      default: return true;
    }
  };

  const calcular = (rows, m) => {
    if (m.op === 'count') return rows.length;
    const vals = rows.map((r) => r[m.campo]).filter((v) => v !== null && v !== undefined && v !== '');
    if (m.op === 'count_distinct') return new Set(vals.map((v) => (typeof v === 'string' ? limpio(v) : v))).size;
    const nums = vals.map(Number).filter((v) => Number.isFinite(v));
    if (!nums.length) return null;
    if (m.op === 'sum') return Math.round(nums.reduce((s, v) => s + v, 0));
    if (m.op === 'avg') return r1(nums.reduce((s, v) => s + v, 0) / nums.length);
    if (m.op === 'min') return Math.min(...nums);
    if (m.op === 'max') return Math.max(...nums);
    if (m.op === 'median') {
      const s = [...nums].sort((a, b) => a - b);
      const k = Math.floor(s.length / 2);
      return s.length % 2 ? s[k] : r1((s[k - 1] + s[k]) / 2);
    }
    return null;
  };

  const lineaCampos = Object.entries(DATASETS)
    .map(([k, d]) => `• ${k}: ${d.desc} Campos: ${Object.entries(d.campos).map(([c, t]) => `${c} (${t})`).join(', ')}.`)
    .join('\n');

  tool(
    'erp_analisis',
    `Motor de análisis general del ERP (solo lectura). Usar para CUALQUIER pregunta analítica: rankings, comparaciones, márgenes, rotación, comunas, vendedores, financieras, gastos por categoría, compras por mes, etc. Se elige un dataset, se filtra, se agrupa por uno o más campos y se calculan métricas. Sin agrupar_por devuelve filas (con campos opcionales). Las métricas de grupo son a nivel de fila; para un % ponderado (p. ej. margen % de un grupo) pedir sum de margen y sum de costo_total y dividir. Fechas en texto AAAA-MM-DD (comparables con gte/lte/entre). Textos sin tildes ni mayúsculas importan.
Operadores de filtro: ${OPS.join(', ')}. Métricas: ${METRICAS.join(', ')} (count no lleva campo).
Datasets y campos:
${lineaCampos}
Ejemplos: ventas por comuna 2026 → dataset=ventas, filtros=[{campo:"anno",op:"eq",valor:2026}], agrupar_por=["comuna"], metricas=[{op:"count"},{op:"sum",campo:"precio_venta"}]. Rotación y margen por modelo de lo comprado en 2026 → dataset=stock, filtros=[{campo:"anno",op:"eq",valor:2026},{campo:"anulada",op:"eq",valor:false}], agrupar_por=["marca_modelo"], metricas=[{op:"count"},{op:"avg",campo:"dias_rotacion"},{op:"sum",campo:"margen"},{op:"sum",campo:"costo_total"}].`,
    {
      dataset: z.enum(Object.keys(DATASETS)),
      filtros: z.array(z.object({
        campo: z.string(),
        op: z.enum(OPS),
        valor: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
      })).default([]),
      agrupar_por: z.array(z.string()).default([]),
      metricas: z.array(z.object({
        op: z.enum(METRICAS),
        campo: z.string().optional(),
        nombre: z.string().optional(),
      })).default([{ op: 'count' }]),
      orden: z.object({ por: z.string(), desc: z.boolean().default(true) }).optional()
        .describe('Campo o nombre de métrica para ordenar (por defecto la primera métrica, descendente)'),
      campos: z.array(z.string()).optional().describe('Columnas a devolver cuando no se agrupa'),
      limite: z.number().int().min(1).max(500).default(50),
    },
    async (a) => {
      const def = DATASETS[a.dataset];
      const validos = Object.keys(def.campos);
      const revisar = (c) => {
        if (!validos.includes(c)) throw new Error(`Campo "${c}" no existe en ${a.dataset}. Campos válidos: ${validos.join(', ')}`);
      };
      a.filtros.forEach((f) => revisar(f.campo));
      a.agrupar_por.forEach(revisar);
      a.metricas.forEach((m) => {
        if (m.op !== 'count') {
          if (!m.campo) throw new Error(`La métrica ${m.op} necesita "campo"`);
          revisar(m.campo);
        }
      });
      (a.campos || []).forEach(revisar);

      const filas = (await construir[a.dataset]()).filter((r) => a.filtros.every((f) => comparar(r[f.campo], f.op, f.valor)));
      const total = filas.length;

      if (!a.agrupar_por.length && !(a.metricas.length && a.metricas.some((m) => m.op !== 'count')) && a.campos) {
        let out = filas.map((r) => Object.fromEntries(a.campos.map((c) => [c, r[c]])));
        if (a.orden) {
          const k = a.orden.por;
          out.sort((x, y) => ((x[k] ?? -Infinity) > (y[k] ?? -Infinity) ? 1 : -1) * (a.orden.desc ? -1 : 1));
        }
        return { dataset: a.dataset, filas_total: total, mostrando: Math.min(total, a.limite), filas: out.slice(0, a.limite) };
      }

      const nombreM = (m) => m.nombre || (m.op === 'count' ? 'cantidad' : `${m.op}_${m.campo}`);
      const grupos = new Map();
      for (const r of filas) {
        const clave = a.agrupar_por.map((g) => r[g] ?? '(sin dato)');
        const k = JSON.stringify(clave);
        if (!grupos.has(k)) grupos.set(k, { clave, rows: [] });
        grupos.get(k).rows.push(r);
      }
      if (!a.agrupar_por.length) grupos.set('[]', { clave: [], rows: filas });

      let resultado = [...grupos.values()].map(({ clave, rows }) => {
        const o = Object.fromEntries(a.agrupar_por.map((g, i) => [g, clave[i]]));
        for (const m of a.metricas) o[nombreM(m)] = calcular(rows, m);
        if (a.agrupar_por.length) o.participacion_pct = total ? r1((rows.length / total) * 100) : 0;
        return o;
      });
      const ordenPor = a.orden?.por || nombreM(a.metricas[0]);
      const desc = a.orden ? a.orden.desc : true;
      resultado.sort((x, y) => {
        const vx = x[ordenPor];
        const vy = y[ordenPor];
        if (vx === vy) return 0;
        if (vx === null || vx === undefined) return 1;
        if (vy === null || vy === undefined) return -1;
        return (vx > vy ? 1 : -1) * (desc ? -1 : 1);
      });
      const grupos_total = resultado.length;
      resultado = resultado.slice(0, a.limite).map((o, i) => (a.agrupar_por.length ? { puesto: i + 1, ...o } : o));
      const totales = Object.fromEntries(a.metricas.map((m) => [nombreM(m), calcular(filas, m)]));
      return { dataset: a.dataset, filas_filtradas: total, grupos_total, totales, resultado };
    },
  );
}
