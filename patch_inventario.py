#!/usr/bin/env python3
"""
patch_inventario.py — FunnelOS CRM
Parchea server.js e index.html directamente en el proyecto local.
Ejecutar desde: ~/Desktop/negocio sistemas/
"""
import sys, os, subprocess, re

BASE   = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(BASE, 'server.js')
INDEX  = os.path.join(BASE, 'public', 'index.html')
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

# ════════════════════════════════════════════════
# server.js — Parche 1: persistir inventory.json al scrape exitoso
# ════════════════════════════════════════════════
print('\n[server.js]')

OLD1 = (
    "    scrapeCache = { ts: now, data: [...new Set(autos)].join('\\n'), items: structuredItems };\n"
    "    console.log('[RMG-Scraper v4] ' + structuredItems.length + ' autos OK');\n"
    "    return scrapeCache.data;"
)
NEW1 = (
    "    scrapeCache = { ts: now, data: [...new Set(autos)].join('\\n'), items: structuredItems };\n"
    "    console.log('[RMG-Scraper v4] ' + structuredItems.length + ' autos OK');\n"
    "    try { await tWrite(F.inventory, 'demo_automotora', structuredItems); console.log('[RMG-Scraper] inventory.json actualizado'); } catch(eP) { console.warn('[RMG-Scraper] No pudo persistir:', eP.message); }\n"
    "    return scrapeCache.data;"
)
patch_file(SERVER, 'scraper-persist-disk', OLD1, NEW1)

# ════════════════════════════════════════════════
# server.js — Parche 2: cron cada 30 minutos
# ════════════════════════════════════════════════
OLD2 = "scrapeRMG().catch(()=>{});\n\nfunction invStr"
NEW2 = (
    "scrapeRMG().catch(()=>{});\n\n"
    "setInterval(() => { scrapeRMG().catch(e => console.warn('[RMG-Cron]', e.message)); }, 30 * 60 * 1000);\n\n"
    "function invStr"
)
patch_file(SERVER, 'scraper-cron-30min', OLD2, NEW2)

# ════════════════════════════════════════════════
# index.html — Parche 3: sync real en vez de toast falso
# ════════════════════════════════════════════════
print('\n[index.html]')

OLD3 = (
    "async function syncInventario(){\n"
    "  toast('\u2705 El inventario se sincroniza autom\u00e1ticamente cada hora desde GitHub Actions."
    " \u00daltimo sync: '+new Date().toLocaleTimeString('es-CL'));\n"
    "}"
)
NEW3 = (
    "async function syncInventario(){\n"
    "  const btn = document.getElementById('btnSyncInv');\n"
    "  if(btn){ btn.disabled=true; btn.textContent='\u23f3 Sincronizando...'; }\n"
    "  try{\n"
    "    const data = await api('GET','/api/precios/inventario');\n"
    "    const count = data.count || 0;\n"
    "    toast('\u2705 Inventario actualizado: '+count+' veh\u00edculos desde rmgautos.cl');\n"
    "    await renderInventario();\n"
    "  } catch(e){\n"
    "    toast('\u274c Error al sincronizar: '+e.message, true);\n"
    "  } finally {\n"
    "    if(btn){ btn.disabled=false; btn.textContent='🔄 Sync RMG'; }\n"
    "  }\n"
    "}"
)
patch_file(INDEX, 'sync-inventario-real', OLD3, NEW3)

# ════════════════════════════════════════════════
# Resultado
# ════════════════════════════════════════════════
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
print("  git add server.js public/index.html && git commit -m 'fix: scraper cron 30min + sync RMG real' && git push")
