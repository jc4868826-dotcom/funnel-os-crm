#!/usr/bin/env python3
"""
patch_scraper_v5.py — FunnelOS CRM
Reescribe scrapeRMG() para dividir HTML por bloques de auto (por link),
y parsear cada bloque independientemente. Elimina desalineacion de datos.
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

OLD = """async function scrapeRMG() {
  const now = Date.now();
  if (scrapeCache.data && (now - scrapeCache.ts) < 30 * 60 * 1000) return scrapeCache.data;
  try {
    const r = await fetch(RMG_SCRAPE_URL, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();

    // Extraer links de fichas antes de procesar
    const linkMap = [];
    const linkTagRE = /href=\"(https:\\/\\/rmgautos\\.cl\\/product\\/[^\"]+)\"/gi;
    let lm;
    while ((lm = linkTagRE.exec(html)) !== null) {
      const url = lm[1].replace(/\\/$/, '');
      if (!linkMap.includes(url)) linkMap.push(url);
    }

    // Extraer valores de headings con regex simple (una sola linea cada uno en el HTML real)
    // Formato: <h2 class=\"...\">VALOR</h2> o <h6 class=\"...\">LABEL</h6>
    const tokens = [];
    const re2 = /<h2\\b[^>]*>([^<]+)<\\/h2>/gi;
    const re6 = /<h6\\b[^>]*>([^<]+)<\\/h6>/gi;

    // Combinar posiciones de h2 y h6 en orden de aparicion
    const matches = [];
    let m;
    while ((m = re2.exec(html)) !== null) matches.push({ pos: m.index, level: 2, text: m[1].trim() });
    while ((m = re6.exec(html)) !== null) matches.push({ pos: m.index, level: 6, text: m[1].trim() });
    matches.sort((a, b) => a.pos - b.pos);
    const toks = matches.filter(t => t.text.length > 0 && t.text.length < 200);

    const parsePrecio = (s) => parseInt((s||'').replace(/\\./g,'').replace(',','').replace(/[^\\d]/g,''),10)||0;

    const structuredItems = [];
    const autos = [];
    let autoIdx = 0;
    let i = 0;

    while (i < toks.length) {
      // Inicio de auto: h6 \"Precio Lista:\"
      if (toks[i].level !== 6 || !/precio lista/i.test(toks[i].text)) { i++; continue; }

      let j = i + 1;

      // Precio Lista: siguiente h2 con $
      while (j < toks.length && !(toks[j].level === 2 && toks[j].text.includes('$'))) j++;
      const precioLista = j < toks.length ? parsePrecio(toks[j].text) : 0;
      j++;

      // h6 \"Precio Crédito:\"
      while (j < toks.length && !/precio cr/i.test(toks[j].text)) j++;
      j++;
      // h2 con $
      while (j < toks.length && !(toks[j].level === 2 && toks[j].text.includes('$'))) j++;
      const precioCredito = j < toks.length ? parsePrecio(toks[j].text) : 0;
      j++;

      if (!precioLista && !precioCredito) { i = j; continue; }

      // Marca: siguiente h2 que matchee MARCAS_RE
      while (j < toks.length && !toks[j].text.match(MARCAS_RE)) j++;
      let marca = '';
      if (j < toks.length) {
        const mm = toks[j].text.match(MARCAS_RE);
        marca = mm ? mm[0].toUpperCase() : toks[j].text.toUpperCase().trim();
        j++;
      }

      // Modelo: siguiente h6 (corto, ej: FOCUS, PARTNER)
      while (j < toks.length && toks[j].level !== 6) j++;
      const modelo = j < toks.length ? toks[j].text.trim() : '';
      j++;

      // Saltar \"|\"
      while (j < toks.length && toks[j].text.trim() === '|') j++;

      // Versión: h2 que NO sea solo 4 dígitos ni \"|\" ni $ 
      let version = '';
      if (j < toks.length && toks[j].level === 2 && !/^\\d{4}$/.test(toks[j].text) && toks[j].text !== '|' && !toks[j].text.includes('$')) {
        version = toks[j].text.trim();
        j++;
      }

      // Saltar \"|\"
      while (j < toks.length && toks[j].text.trim() === '|') j++;

      // Año: h2 con exactamente 4 dígitos
      let anno = null;
      if (j < toks.length && /^\\d{4}$/.test(toks[j].text.trim())) {
        anno = parseInt(toks[j].text.trim(), 10);
        j++;
      }

      // Saltar \"|\"
      while (j < toks.length && toks[j].text.trim() === '|') j++;

      // Km: h2 con número puro (sin $, sin letras)
      let km = 0;
      if (j < toks.length && /^[\\d.,]+$/.test(toks[j].text.trim()) && !toks[j].text.includes('$')) {
        km = parseInt(toks[j].text.replace(/[.,]/g,''), 10);
        j++;
      }

      // Saltar \"|\"
      while (j < toks.length && toks[j].text.trim() === '|') j++;

      // Combustible, transmisión, tipo — hasta próximo \"Precio Lista\" o fin
      let fuel = '', trans = '', tipo = '';
      while (j < toks.length && !/precio lista/i.test(toks[j].text)) {
        const t = toks[j].text.trim();
        if (/^(GASOLINA|DIESEL|DI.SEL|H.BRIDO|EL.CTRICO|BENCINA|HYBRIDO)/i.test(t) && !fuel) fuel = t.toUpperCase();
        if (/^(AUTOM.TICO|MEC.NICO|CVT|DSG|TIPTRONIC)/i.test(t) && !trans) trans = t.toUpperCase();
        if (/^(SUV|HATCHBACK|SED.N|FURG.N|PICKUP|STATION|MINIVAN|COUPE)/i.test(t) && !tipo) tipo = t.toUpperCase();
        j++;
      }

      const cardLink   = linkMap[autoIdx * 2] || 'https://rmgautos.cl/usados/'; // *2: cada auto tiene 2 hrefs en HTML (imagen+titulo)
      const modeloDisp = (modelo && modelo.toUpperCase() !== marca) ? modelo : '';
      const fullModel  = [marca, modeloDisp, version].filter(Boolean).join(' ');
      const highlights = [anno?'Año '+anno:'', km?km.toLocaleString('es-CL')+' km':'', fuel, trans, tipo].filter(Boolean).join(' · ');

      structuredItems.push({
        id:             'RMG-' + (autoIdx + 1),
        brand:          marca,
        model:          fullModel,
        year:           anno,
        stock:          1,
        price:          precioCredito || precioLista,
        precio_lista:   precioLista,
        precio_credito: precioCredito,
        km:             km ? km.toLocaleString('es-CL') + ' km' : '',
        fuel,
        version,
        tipo,
        transmision:    trans,
        link:           cardLink,
        highlights
      });

      autos.push(
        `- ${fullModel}${anno?' '+anno:''} | ${km?km.toLocaleString('es-CL')+' km':'km n/d'} | Lista: $${precioLista.toLocaleString('es-CL')} | Credito: ${precioCredito.toLocaleString('es-CL')}${fuel?' | '+fuel:''}${trans?' | '+trans:''} | Link: ${cardLink}`
      );

      autoIdx++;
      i = j;
    }

    if (structuredItems.length === 0) throw new Error('0 autos encontrados en rmgautos.cl');

    scrapeCache = { ts: now, data: [...new Set(autos)].join('\\n'), items: structuredItems };
    console.log('[RMG-Scraper v4] ' + structuredItems.length + ' autos OK');
    // Persistir en disco como respaldo ante reinicios
    try { await tWrite(F.inventory, 'demo_automotora', structuredItems); console.log('[RMG-Scraper] inventory.json actualizado en disco'); } catch(eP) { console.warn('[RMG-Scraper] No se pudo persistir inventory.json:', eP.message); }
    return scrapeCache.data;
  } catch(e) {
    console.warn('[RMG-Scraper] Error:', e.message, '— usando cache o fallback');
    return scrapeCache.data || '';
  }
}"""

NEW = """async function scrapeRMG() {
  const now = Date.now();
  if (scrapeCache.data && (now - scrapeCache.ts) < 30 * 60 * 1000) return scrapeCache.data;
  try {
    const r = await fetch(RMG_SCRAPE_URL, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();

    const parsePrecio = (s) => parseInt((s||'').replace(/\\./g,'').replace(',','').replace(/[^\\d]/g,''),10)||0;

    // Extraer links únicos en orden de aparición (cada auto tiene 2 hrefs: imagen + título)
    const allLinks = [];
    const linkRE = /href="(https:\/\/rmgautos\.cl\/product\/[^"]+)"/gi;
    let lm;
    while ((lm = linkRE.exec(html)) !== null) {
      const url = lm[1].replace(/\\/$/, '');
      if (!allLinks.includes(url)) allLinks.push(url);
    }

    // Dividir HTML en bloques por auto usando los links como separadores
    // Cada bloque contiene todo el HTML de un auto (precios, marca, modelo, etc.)
    const blockStarts = [];
    for (const link of allLinks) {
      const idx = html.indexOf('href="' + link + '"');
      if (idx !== -1) blockStarts.push({ link, idx });
    }
    blockStarts.sort((a, b) => a.idx - b.idx);

    const structuredItems = [];
    const autos = [];

    for (let bi = 0; bi < blockStarts.length; bi++) {
      const { link } = blockStarts[bi];
      const blockStart = blockStarts[bi].idx;
      const blockEnd = bi + 1 < blockStarts.length ? blockStarts[bi + 1].idx : html.length;
      const block = html.slice(blockStart, blockEnd);

      // Extraer tokens h2 y h6 solo de este bloque
      const matches = [];
      const re2 = /<h2\\b[^>]*>([^<]+)<\\/h2>/gi;
      const re6 = /<h6\\b[^>]*>([^<]+)<\\/h6>/gi;
      let m;
      while ((m = re2.exec(block)) !== null) matches.push({ pos: m.index, level: 2, text: m[1].trim() });
      while ((m = re6.exec(block)) !== null) matches.push({ pos: m.index, level: 6, text: m[1].trim() });
      matches.sort((a, b) => a.pos - b.pos);
      const toks = matches.filter(t => t.text.length > 0 && t.text.length < 200);

      if (!toks.length) continue;

      // Precio Lista
      let precioLista = 0, precioCredito = 0;
      const iPL = toks.findIndex(t => /precio lista/i.test(t.text));
      if (iPL !== -1) {
        const iPLval = toks.slice(iPL+1).findIndex(t => t.level === 2 && t.text.includes('$'));
        if (iPLval !== -1) precioLista = parsePrecio(toks[iPL+1+iPLval].text);
      }
      // Precio Crédito
      const iPC = toks.findIndex(t => /precio cr/i.test(t.text));
      if (iPC !== -1) {
        const iPCval = toks.slice(iPC+1).findIndex(t => t.level === 2 && t.text.includes('$'));
        if (iPCval !== -1) precioCredito = parsePrecio(toks[iPC+1+iPCval].text);
      }

      if (!precioLista && !precioCredito) continue;

      // Marca
      let marca = '';
      const iMarca = toks.findIndex(t => t.level === 2 && MARCAS_RE.test(t.text));
      MARCAS_RE.lastIndex = 0;
      if (iMarca !== -1) {
        const mm = toks[iMarca].text.match(MARCAS_RE);
        MARCAS_RE.lastIndex = 0;
        marca = mm ? mm[0].toUpperCase() : toks[iMarca].text.toUpperCase().trim();
      }

      // Modelo (h6 después de la marca)
      let modelo = '';
      if (iMarca !== -1) {
        const iMod = toks.slice(iMarca+1).findIndex(t => t.level === 6 && !/precio/i.test(t.text));
        if (iMod !== -1) modelo = toks[iMarca+1+iMod].text.trim();
      }

      // Versión, año, km, fuel, trans, tipo — buscar en todo el bloque
      let version = '', anno = null, km = 0, fuel = '', trans = '', tipo = '';
      for (const tok of toks) {
        const t = tok.text.trim();
        if (tok.level === 2 && /^\\d{4}$/.test(t) && !anno) anno = parseInt(t, 10);
        if (tok.level === 2 && /^[\\d.,]+$/.test(t) && !t.includes('$') && parseInt(t.replace(/[.,]/g,''),10) > 1000 && !anno) km = parseInt(t.replace(/[.,]/g,''), 10);
        if (tok.level === 2 && /^[\\d.,]+$/.test(t) && !t.includes('$') && parseInt(t.replace(/[.,]/g,''),10) > 1000 && anno) km = parseInt(t.replace(/[.,]/g,''), 10);
        if (/^(GASOLINA|DIESEL|DI.SEL|H.BRIDO|EL.CTRICO|BENCINA|HYBRIDO)/i.test(t) && !fuel) fuel = t.toUpperCase();
        if (/^(AUTOM.TICO|MEC.NICO|CVT|DSG|TIPTRONIC)/i.test(t) && !trans) trans = t.toUpperCase();
        if (/^(SUV|HATCHBACK|SED.N|FURG.N|PICKUP|STATION|MINIVAN|COUPE)/i.test(t) && !tipo) tipo = t.toUpperCase();
        if (tok.level === 2 && !/^\\d{4}$/.test(t) && !/^[\\d.,]+$/.test(t) && !t.includes('$') && !MARCAS_RE.test(t) && t !== '|' && t.length > 3 && !version && iMarca !== -1) {
          MARCAS_RE.lastIndex = 0;
          version = t;
        }
        MARCAS_RE.lastIndex = 0;
      }

      const modeloDisp = (modelo && modelo.toUpperCase() !== marca) ? modelo : '';
      const fullModel  = [marca, modeloDisp, version].filter(Boolean).join(' ');
      const highlights = [anno?'Año '+anno:'', km?km.toLocaleString('es-CL')+' km':'', fuel, trans, tipo].filter(Boolean).join(' · ');
      const autoIdx    = structuredItems.length;

      structuredItems.push({
        id:             'RMG-' + (autoIdx + 1),
        brand:          marca,
        model:          fullModel,
        year:           anno,
        stock:          1,
        price:          precioCredito || precioLista,
        precio_lista:   precioLista,
        precio_credito: precioCredito,
        km:             km ? km.toLocaleString('es-CL') + ' km' : '',
        fuel,
        version,
        tipo,
        transmision:    trans,
        link,
        highlights
      });

      const pSign = String.fromCharCode(36);
      autos.push(
        `- ${fullModel}${anno?' '+anno:''} | ${km?km.toLocaleString('es-CL')+' km':'km n/d'} | Lista: ${pSign}${precioLista.toLocaleString('es-CL')} | Credito: ${precioCredito.toLocaleString('es-CL')}${fuel?' | '+fuel:''}${trans?' | '+trans:''} | Link: ${link}`
      );
    }

    if (structuredItems.length === 0) throw new Error('0 autos encontrados en rmgautos.cl');

    scrapeCache = { ts: now, data: [...new Set(autos)].join('\\n'), items: structuredItems };
    console.log('[RMG-Scraper v5] ' + structuredItems.length + ' autos OK');
    try { await tWrite(F.inventory, 'demo_automotora', structuredItems); console.log('[RMG-Scraper] inventory.json actualizado'); } catch(eP) { console.warn('[RMG-Scraper] No pudo persistir:', eP.message); }
    return scrapeCache.data;
  } catch(e) {
    console.warn('[RMG-Scraper] Error:', e.message, '— usando cache');
    return scrapeCache.data || '';
  }
}"""

patch_file(SERVER, 'scraper-v5-por-bloque', OLD, NEW)

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
print("  git add server.js && git commit -m 'fix: scraper v5 por bloque, datos alineados por link' && git push")
