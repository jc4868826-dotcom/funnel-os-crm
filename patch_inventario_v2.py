#!/usr/bin/env python3
"""
patch_inventario_v2.py — FunnelOS CRM
Corrige /api/precios/inventario para usar inventory.json como fallback
cuando scrapeRMG() falla o devuelve vacío.
Ejecutar desde: ~/Desktop/negocio sistemas/
"""
import sys, os, subprocess

BASE   = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(BASE, 'server.js')
errors = []

def patch_file(path, name, old, new):
    with open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    if old not in src:
        errors.append(f'[X] [{name}] anchor NO encontrado en {os.path.basename(path)}')
        return
    src = src.replace(old, new, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'[OK] [{name}]')

print('\n[server.js]')

# Endpoint /api/precios/inventario — agregar fallback a inventory.json
OLD = (
    "  try{await scrapeRMG();const inv=(scrapeCache.items&&scrapeCache.items.length)?scrapeCache.items:[];res.json({ok:true,count:inv.length,data:inv,ts:scrapeCache.ts});}\n"
    "  catch(e){res.status(500).json({error:e.message});}\n"
    "});"
)
NEW = (
    "  try{\n"
    "    await scrapeRMG();\n"
    "    let inv = (scrapeCache.items && scrapeCache.items.length) ? scrapeCache.items : [];\n"
    "    // Fallback a inventory.json si scrape falla o devuelve vacío\n"
    "    if (!inv.length) {\n"
    "      const dbInv = await tRead(F.inventory, req.tenant);\n"
    "      if (Array.isArray(dbInv) && dbInv.length) {\n"
    "        inv = dbInv;\n"
    "        console.log('[INV] scrape vacío — usando inventory.json:', inv.length, 'autos');\n"
    "      }\n"
    "    }\n"
    "    res.json({ok:true, count:inv.length, data:inv, ts:scrapeCache.ts||Date.now()});\n"
    "  }\n"
    "  catch(e){res.status(500).json({error:e.message});}\n"
    "});"
)
patch_file(SERVER, 'precios-inventario-fallback', OLD, NEW)

print()
if errors:
    print('ERRORES:')
    for e in errors: print(' ', e)
    sys.exit(1)

print('Verificando sintaxis node...')
r = subprocess.run(['node', '--check', 'server.js'], cwd=BASE, capture_output=True, text=True)
if r.returncode != 0:
    print('[X] Error sintaxis server.js:')
    print(r.stderr)
    sys.exit(1)

print('\nListo. Ejecuta:')
print("  git add server.js && git commit -m 'fix: fallback inventory.json cuando scrape falla' && git push")
