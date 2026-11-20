#!/usr/bin/env python3
# Uso:  python3 patch_asignacion_inventario.py [ruta/server.js]
# 1) Asignación: solo vendedores entran a rotativo / default / SLA / lead manual.
# 2) Inventario: buscar_inventario con match normalizado (X-Trail = XTRAIL), sin filtro de precio
#    cuando el cliente nombra un modelo, y respuesta explícita cuando no hay coincidencia.
import sys, re, shutil, subprocess, time

path = sys.argv[1] if len(sys.argv) > 1 else 'server.js'
src = open(path, encoding='utf-8').read()
shutil.copy(path, path + '.bak_' + time.strftime('%Y%m%d_%H%M%S'))


def once(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        sys.exit('ABORTADO: ancla "%s" aparece %d veces (esperaba 1). No se modificó nada.' % (label, n))
    src = src.replace(old, new)


# ── 1. getSellers: excluir cuentas que no deben rotar ───────────────────────
once("""async function getSellers(tenant) {
  const allUsers = await tRead(F.users, tenant);
  return allUsers.filter(u => u.role === 'vendedor' && (!u.status || u.status === 'Activo'));
}""",
"""// Cuentas que NUNCA entran al rotativo aunque tengan rol 'vendedor' (gerencia / compras / RMG Parts).
// También se puede excluir a cualquiera poniendo noRotar:true en su usuario.
const NO_ROTAR = new Set(['rmgparts', 'comprador', 'gerente']);
const esRotable = u => !!u && u.role === 'vendedor' && !NO_ROTAR.has(u.username) && !u.noRotar && (!u.status || u.status === 'Activo');
async function getSellers(tenant) {
  const allUsers = await tRead(F.users, tenant);
  return allUsers.filter(esRotable);
}""", 'getSellers')

# ── 2. defaultAssignee de config: solo si es vendedor rotable ───────────────
once("""const u = users.find(x => x.username === username && (!x.status || x.status === 'Activo'));
      if (u) return u;""",
"""const u = users.find(x => x.username === username && (!x.status || x.status === 'Activo'));
      if (u && esRotable(u)) return u;
      if (u) console.warn('[getDefaultAssignee] defaultAssignee "' + username + '" no es vendedor rotable — se ignora y se usa rotativo');""",
     'getDefaultAssignee')

# ── 3. Reingreso RMG Parts: ya no se manda a 'gerente' ──────────────────────
once("""            ld[tenant][idx].isRmgParts = true;
            ld[tenant][idx].assignedTo = 'gerente';""",
"""            ld[tenant][idx].isRmgParts = true;
            const _rpPick = await rrNext(tenant);
            if (_rpPick) ld[tenant][idx].assignedTo = _rpPick.username;""", 'reingreso RMG Parts')

# ── 4. Lead manual: si quien lo crea no es vendedor rotable, no se autoasigna ─
once("""assignedTo: asignado || req.user?.username || 'vendedor1',""",
"""assignedTo: asignado || (esRotable(req.user) ? req.user.username
        : ((isCompraRmg === true || /compramos|compra directa/i.test(String(canal))) ? ((await getComprasAssignee(tenant)).username)
        : ((await rrNext(tenant))?.username || 'vendedor1'))),""", 'lead manual')

# ── 5. buscarInventario: match normalizado ──────────────────────────────────
pat = re.compile(r"function buscarInventario\(filtros = \{\}\) \{.*?\n(?=  if \(filtros\.modelo\) \{)", re.S)
if len(pat.findall(src)) != 1:
    sys.exit('ABORTADO: no se encontró buscarInventario de forma única.')
nuevo = r"""const _normInv = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
function buscarInventario(filtros = {}) {
  const todos = scrapeCache.items || [];
  const nMarca = _normInv(filtros.marca), nModelo = _normInv(filtros.modelo), nCat = _normInv(filtros.categoria);
  const noDisp = it => it.estado === 'vendido' || it.estado === 'reservado';
  const coincide = it => {
    if (nMarca && !(_normInv(it.brand) === nMarca || _normInv(it.model).includes(nMarca))) return false;
    if (nModelo && !_normInv(it.model).includes(nModelo)) return false;
    if (nCat && !_normInv(it.tipo).includes(nCat)) return false;
    // El precio solo filtra cuando se busca por criterio; si el cliente ya nombró un modelo NO se descarta
    // por precio (el precio del aviso en Chileautos/ML casi nunca coincide con el del sitio).
    if (!nModelo) {
      if (typeof filtros.precioMax === 'number' && (it.price || 0) > filtros.precioMax) return false;
      if (typeof filtros.precioMin === 'number' && (it.price || 0) < filtros.precioMin) return false;
    }
    return true;
  };
  const items = todos.filter(it => coincide(it) && (filtros.incluirVendidos || !noDisp(it)));
  console.log('[INV-TOOL]', JSON.stringify(filtros), '->', items.length, 'de', todos.length, 'en cache');

  if (nModelo && items.length === 0) {
    const noDispon = todos.filter(it => coincide(it) && noDisp(it));
    return {
      modo: 'detalle', total: 0, autos: [],
      reservadosOVendidos: noDispon.map(it => ({ modelo: it.model, anio: it.year, estado: it.estado })),
      aviso: 'Sin coincidencia para ese modelo en la búsqueda. ANTES de decir que no está disponible, revisa <INVENTARIO_DISPONIBLE> completo (el nombre del aviso puede venir con otra grafía o versión). Solo afirma "no disponible" si realmente no aparece o su Estado es reservado/vendido.',
      otrosDeLaMarca: nMarca ? todos.filter(it => !noDisp(it) && (_normInv(it.brand) === nMarca || _normInv(it.model).includes(nMarca))).slice(0, 8).map(it => it.model) : undefined
    };
  }

"""
src = pat.sub(lambda m: nuevo, src, count=1)

open(path, 'w', encoding='utf-8').write(src)
r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
if r.returncode != 0:
    sys.exit('ERROR de sintaxis tras parchear (restaura el .bak_*):\n' + r.stderr)
print('OK: parche aplicado y sintaxis válida. Reinicia/redeploya el servidor.')
