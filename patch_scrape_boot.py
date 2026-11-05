#!/usr/bin/env python3
"""
patch_scrape_boot.py — FunnelOS CRM
Al arrancar: intenta scrape en vivo, si falla carga inventory.json al cache.
Asi el sistema siempre tiene datos, nunca queda vacío.
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

OLD = "scrapeRMG().catch(()=>{});\n\n// Cron: re-scrapear rmgautos.cl cada 30 minutos para mantener cache vivo\nsetInterval(() => { scrapeRMG().catch(e => console.warn('[RMG-Cron]', e.message)); }, 30 * 60 * 1000);"

NEW = """// Arranque: scrape en vivo, si falla precarga inventory.json al cache
(async () => {
  try {
    await scrapeRMG();
    console.log('[BOOT] scrapeRMG OK:', scrapeCache.items?.length, 'autos');
  } catch(e) {
    console.warn('[BOOT] scrapeRMG falló:', e.message, '— precargando inventory.json');
  }
  // Si el scrape no llenó el cache, precargar desde disco
  if (!scrapeCache.items || !scrapeCache.items.length) {
    try {
      const dbInv = await tRead(F.inventory, 'demo_automotora');
      if (Array.isArray(dbInv) && dbInv.length) {
        const pSign = String.fromCharCode(36);
        const dataStr = dbInv.map(i =>
          `- ${i.brand||''} ${i.model||''}${i.year?' '+i.year:''}${i.km?' | '+i.km:''} | ${pSign}${(i.price||0).toLocaleString('es-CL')}${i.link?' | '+i.link:''}`
        ).join('\\n');
        scrapeCache = { ts: Date.now(), data: dataStr, items: dbInv };
        console.log('[BOOT] Cache precargado desde inventory.json:', dbInv.length, 'autos');
      }
    } catch(eB) { console.warn('[BOOT] No se pudo precargar inventory.json:', eB.message); }
  }
})();

// Cron: re-scrapear rmgautos.cl cada 30 minutos para mantener cache vivo
setInterval(() => { scrapeRMG().catch(e => console.warn('[RMG-Cron]', e.message)); }, 30 * 60 * 1000);"""

patch_file(SERVER, 'boot-preload-inventory', OLD, NEW)

print()
if errors:
    print('ERRORES:')
    for e in errors: print(' ', e)
    sys.exit(1)

print('Verificando sintaxis node...')
r = subprocess.run(['node', '--check', 'server.js'], cwd=BASE, capture_output=True, text=True)
if r.returncode != 0:
    print('[X] Error sintaxis:')
    print(r.stderr)
    sys.exit(1)

print('\nListo. Ejecuta:')
print("  git add server.js && git commit -m 'fix: precargar inventory.json al cache en boot' && git push")
