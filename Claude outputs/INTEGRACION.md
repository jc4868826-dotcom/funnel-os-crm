# Cata — búsqueda de stock robusta (ERP RMG)

## Archivos
- `lib/stockSearch.js` — módulo nuevo, sin dependencias. No toca nada existente.

## Integración en server.js (3 cambios)

### 1) require, junto a los demás al inicio
```js
const { buscarStock, respuestaStock, normalizar } = require('./lib/stockSearch');
```

### 2) En el handler del mensaje de WhatsApp, antes de armar el prompt de Cata
Reemplazar la búsqueda actual de inventario por:
```js
const stockERP = await getStockERP();            // <-- única fuente: ERP RMG
const hit = await buscarStock(textoCliente, stockERP, {
  llm: async ({ system, user }) => {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    return r.choices[0].message.content;
  },
  log: console.log,
});

if (hit.autos.length) {
  // Cata responde con datos reales del ERP (año, versión, km, color, precio CLP)
  inventarioParaPrompt = hit.autos.map(a =>
    `${String(a.marca).trim()} ${String(a.modelo).trim()} ${a.anno} | ${String(a.version).trim()} | ` +
    `${a.kilometraje} km | ${a.color} | $${Number(a.ventaiva).toLocaleString('es-CL')} | patente ${a.patente}`
  ).join('\n');
  // atajo opcional sin pasar por el LLM:
  // return sendWA(from, respuestaStock(hit.autos));
} else {
  // SOLO acá Cata puede decir que no está (el LLM ya confirmó que no hay ninguno)
  inventarioParaPrompt = 'SIN COINCIDENCIAS EN STOCK';
}
```

### 3) Regla en bot.json (`<INSTRUCCIONES_DEL_SISTEMA>`)
> Nunca digas que un auto no está disponible por tu cuenta. Si el bloque
> `<INVENTARIO_DISPONIBLE>` trae autos, ofrécelos con sus datos exactos.
> Solo si dice `SIN COINCIDENCIAS EN STOCK` puedes decir que no lo tenemos,
> y de inmediato ofrece alternativas del stock.

## Logs a vigilar en Render
- `[CATA-STOCK-VARIANTE]` → el paso difuso falló y el LLM sí resolvió: variante nueva para sumar a `ALIAS`/`RELLENO`.
- `[CATA-STOCK-SIN-MATCH]` → ni difuso ni LLM encontraron nada.
- `[CATA-STOCK-LLM-ERROR]` → falló la llamada al LLM.

## Deploy
```bash
cd ~/Desktop/"negocio sistemas"
mkdir -p lib && cp /ruta/descarga/stockSearch.js lib/stockSearch.js
node --check lib/stockSearch.js
node --check server.js
node lib/_test_stock.js          # si copias también el test
git reset HEAD .
git add lib/stockSearch.js server.js
git commit -m "Cata: busqueda de stock normalizada + difusa + fallback LLM sobre ERP"
git push origin main             # Render auto-deploy
```
