const S = require('./stockSearch');
const stock = require('./stock.json');

// Stub del LLM: simula gpt-4o-mini resolviendo por descripción.
const llmStub = async ({ user }) => {
  const { mensaje, stock_disponible } = JSON.parse(user);
  const m = mensaje.toLowerCase();
  if (/jap|4x4|suv|camioneta gris/.test(m)) {
    const hit = stock_disponible.find(a => a.marca === 'NISSAN');
    if (hit) return JSON.stringify({ patentes: [hit.patente], razon: 'SUV japonesa 2022 gris' });
  }
  return JSON.stringify({ patentes: [], razon: 'ninguno coincide' });
};

const casos = [
  '2022 Nissan X-Trail 2.5 SENSE',   // el mensaje real que falló
  'Nissan X-Trail 2022',
  'xtrail',
  'X trail sense',
  'equis trail',
  'Hola, tienen el Xtrail?',
  'me interesa el xtrial 2022',      // typo
  'nisan x trail',                   // typo marca
  'RLXV76',
  'tienen un auto japonés 4x4 del 2022?',  // sin nombre de modelo -> paso (b)
  'tienen un Toyota Corolla?',             // de verdad no hay
];

(async () => {
  for (const c of casos) {
    const r = await S.buscarStock(c, stock, { llm: llmStub });
    const pats = r.autos.map(a => a.patente).join(',') || '—';
    const ok = pats.includes('RLXV76') ? 'OK' : (r.autos.length ? '?' : 'SIN STOCK');
    console.log(`\n── "${c}"\n   normalizado: ${S.normalizar(c)}\n   via=${r.via}  patentes=${pats}  [${ok}]`);
    const resp = S.respuestaStock(r.autos);
    if (resp) console.log('   respuesta:\n' + resp.split('\n').map(l => '     ' + l).join('\n'));
  }
})();
