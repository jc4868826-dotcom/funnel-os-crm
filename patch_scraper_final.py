#!/usr/bin/env python3
"""
patch_scraper_final.py — FunnelOS CRM
Corrige el scraper definitivamente:
1. Al boot: scrape directo de rmgautos.cl, sin fallback a disco viejo
2. Si scrape falla en boot, reintentar cada 2 min hasta que funcione
3. Cuando scrape OK: sobreescribe inventory.json con datos frescos
4. Cron cada 30 min mantiene todo actualizado
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

OLD = """// Arranque: scrape en vivo, si falla precarga inventory.json al cache
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
})();"""

NEW = """// Arranque: scrape directo de rmgautos.cl — sin fallback a disco viejo
// Si falla, reintenta cada 2 minutos hasta tener datos frescos
(async () => {
  try {
    await scrapeRMG();
    console.log('[BOOT] scrapeRMG OK:', scrapeCache.items?.length, 'autos en vivo');
  } catch(e) {
    console.warn('[BOOT] scrapeRMG falló en boot:', e.message);
  }
  // Si aun no hay datos, reintentar cada 2 min hasta conseguirlos
  if (!scrapeCache.items || !scrapeCache.items.length) {
    console.warn('[BOOT] Sin datos — reintentando cada 2 min...');
    const retry = setInterval(async () => {
      try {
        await scrapeRMG();
        if (scrapeCache.items && scrapeCache.items.length) {
          console.log('[BOOT-RETRY] scrapeRMG OK:', scrapeCache.items.length, 'autos');
          clearInterval(retry);
        }
      } catch(e) { console.warn('[BOOT-RETRY] fallo:', e.message); }
    }, 2 * 60 * 1000);
  }
})();"""

patch_file(SERVER, 'boot-scrape-directo', OLD, NEW)

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
print("  git add server.js && git commit -m 'fix: scraper boot directo desde rmgautos.cl sin fallback a disco' && git push")
