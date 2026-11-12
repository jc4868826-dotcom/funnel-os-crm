// Convierte un conector MCP de stdio (el que corre en el Mac) en un módulo que exporta
// createServer(), sin tocar su lógica. Permite regenerar los conectores del gateway
// cada vez que cambie la versión local, manteniendo la paridad exacta.
//   node herramientas/envolver.mjs <origen> <destino>
import fs from 'node:fs';

const [origen, destino] = process.argv.slice(2);
if (!origen || !destino) {
  console.error('Uso: node herramientas/envolver.mjs <origen> <destino>');
  process.exit(1);
}

const lineas = fs.readFileSync(origen, 'utf8').split('\n');
let quitadoImport = 0;
let quitadoConnect = 0;

const limpias = lineas.filter((l) => {
  if (/^\s*import\s.*StdioServerTransport/.test(l)) { quitadoImport++; return false; }
  if (/connect\(\s*new StdioServerTransport\(\)\s*\)/.test(l)) { quitadoConnect++; return false; }
  return true;
});

if (quitadoConnect !== 1) {
  console.error(`Error: se esperaba 1 línea de conexión stdio y se encontraron ${quitadoConnect}. Revisa ${origen} a mano.`);
  process.exit(1);
}

// El último import de nivel superior cierra el preámbulo; el resto pasa al cuerpo de la función.
let ultimoImport = -1;
limpias.forEach((l, i) => { if (/^\s*import\s/.test(l)) ultimoImport = i; });

const preambulo = limpias.slice(0, ultimoImport + 1).join('\n');
const cuerpo = limpias.slice(ultimoImport + 1).join('\n');

if (!/const\s+server\s*=\s*new McpServer/.test(cuerpo)) {
  console.error(`Error: no se encontró "const server = new McpServer(...)" en ${origen}.`);
  process.exit(1);
}

const salida = `${preambulo}

// ─────────────────────────────────────────────────────────────────────────────
// Generado por herramientas/envolver.mjs desde:
//   ${origen}
// Única diferencia con el conector local: se quitó el transporte stdio y el
// cuerpo quedó dentro de createServer(). La lógica y las herramientas son
// idénticas — no editar a mano, regenerar con el script.
// ─────────────────────────────────────────────────────────────────────────────
export function createServer() {
${cuerpo}

  return server;
}
`;

fs.writeFileSync(destino, salida);
console.log(`OK ${destino} (quitados: ${quitadoImport} import stdio, ${quitadoConnect} connect)`);
