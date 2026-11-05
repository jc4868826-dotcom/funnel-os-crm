const webpush = require('web-push');
'use strict';
const{OpenAI}=require('openai');
const STAFF_TASACION = [
  {name:'Valentina',   phone:'56955145504'},
  {name:'Recepcion',   phone:'56983300262'},
  {name:'Juan Carlos', phone:'56937648536'}
];

const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
const express=require('express');
const path=require('path');
const fs=require('fs').promises;
const fsSync=require('fs');
const crypto=require('crypto');
const app=express();
const PORT=process.env.PORT||3000;
const DATA=process.env.RENDER?'/var/data':path.join(__dirname,'data');
if(!fsSync.existsSync(DATA))fsSync.mkdirSync(DATA,{recursive:true});

// ── MOTOR DE AUTO-RESPALDO FANTASMA (CADA 1 HORA) ──────────────────────
/* [EXTIRPADO: Cron Anciano (contacto_2)] */

// ────────────────────────────────────────────────────────────────────────


// ── WEB PUSH ─────────────────────────────────────────────────────
(function setupVapid(){
  const pub=process.env.VAPID_PUBLIC_KEY, priv=process.env.VAPID_PRIVATE_KEY;
  if(pub&&priv){webpush.setVapidDetails('mailto:admin@rmgautos.cl',pub,priv);console.log('[PUSH] VAPID OK');}
  else{console.warn('[PUSH] Sin VAPID keys — push desactivado');}
})();
const _PUSH_FILE=require('path').join(__dirname,'data','push_subs.json');
let _pushSubs={};
try{_pushSubs=JSON.parse(require('fs').readFileSync(_PUSH_FILE,'utf8'));}catch(_){}
async function _saveSubs(){try{require('fs').writeFileSync(_PUSH_FILE,JSON.stringify(_pushSubs));}catch(_){}}
async function sendWebPush(tenant,username,payload){
  const key=tenant+':'+username, subs=_pushSubs[key]||[], dead=[];
  for(const sub of subs){
    try{await webpush.sendNotification(sub,JSON.stringify(payload));}
    catch(err){if(err.statusCode===410||err.statusCode===404)dead.push(sub.endpoint);}
  }
  if(dead.length){_pushSubs[key]=subs.filter(s=>!dead.includes(s.endpoint));await _saveSubs();}
}
async function notifyTenantPush(tenant,leads){
  try{
    const unreads=(leads||[]).filter(l=>l.unread);
    if(!unreads.length)return;
    const last=unreads[unreads.length-1];
    const msg=(last.chatHistory||[]).filter(m=>m.role==='user').slice(-1)[0];
    const payload={title:'RMG CRM — '+last.name,body:msg?msg.content.slice(0,80):'Nuevo mensaje',count:unreads.length,leadId:last.id};
    
    const users = await tRead(F.users, tenant, []);
    const admins = users.filter(u => u.role === 'admin').map(u => u.username);
    const assigned = last.assignedTo;
    const allowedUsernames = new Set([...admins, assigned]);

    for(const k of Object.keys(_pushSubs).filter(k=>k.startsWith(tenant+':'))){
      const username = k.split(':')[1];
      if (allowedUsernames.has(username)) {
        await sendWebPush(tenant,username,payload);
      }
    }
  }catch(e){console.warn('[PUSH] error:',e.message);}
}
// ── fin WEB PUSH ──────────────────────────────────────────────────

app.use(express.json({limit:'2mb'}));
app.use((req,res,next)=>{res.header('Access-Control-Allow-Origin','*');res.header('Access-Control-Allow-Headers','Content-Type,X-Auth-Token,Authorization');res.header('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');if(req.method==='OPTIONS')return res.sendStatus(200);next();});

function applySignal(lead, p) { if (p && p.intent_signal && p.intent_signal !== 'NONE') { lead.intentSignal = p.intent_signal; } }
function esKeywordCalif(text) { if(!text) return false; const t = text.toLowerCase(); return t.includes('credito') || t.includes('crédito') || t.includes('financiamiento') || t.includes('retoma') || t.includes('pie'); }
// ── alertStaff: WA + Push en paralelo ──
async function alertStaff(tenant, userObj, title, body) {
  if (!userObj) return;
  if (userObj.phone) sendWA(userObj.phone, body).catch(() => {});
  if (userObj.username && tenant) sendWebPush(tenant, userObj.username, { title, body, ts: Date.now() }).catch(() => {});
}

async function sendWA(to, text, retries = 2) {
  const token = (process.env.WA_TOKEN || '').trim();
  const phoneId = (process.env.WA_PHONE_ID || '').trim();
  if (!token || !phoneId) return false;

  let safeText = "¡Hola! Estoy aquí.";
  if (typeof text === 'string') {
      safeText = text;
  } else if (text && typeof text === 'object') {
      safeText = text.reply || text.Reply || text.mensaje || JSON.stringify(text);
  }

  const payload = { messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type: 'text', text: { body: safeText } };
  console.log('[WA-DEBUG] Payload sanitizado:', JSON.stringify(payload));

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if(res.ok) return true;
      const errText = await res.text();
      console.error(`[WA HTTP Error - Intento ${i+1}]`, errText);
      if (i === retries) return false;
      await new Promise(r => setTimeout(r, 1500));
    } catch(e) {
      console.error(`[WA Catch - Intento ${i+1}]`, e.message);
      if (i === retries) return false;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return false;
}

async function marcela(tenant, history, msg, notes, assignedName, leadSource) {
  try {
    let botCfg = await tRead(F.bot, tenant, {});
    let baseSysPrompt = botCfg?.systemPrompt;
    if ((leadSource === 'Compra Directa' || leadSource === 'Compramos tu Auto' || leadSource === 'Compramos tu auto') && botCfg?.compras_rmg?.systemPrompt) {
      baseSysPrompt = botCfg.compras_rmg.systemPrompt;
      console.log('[BOT] Modo COMPRADORA activado (origen:', leadSource, ')');
    }
    if (!baseSysPrompt) {
      console.error('[Bot-Config-Error] systemPrompt no encontrado en bot.json para tenant:', tenant);
      return { reply: 'Dame un segundito, estoy validando la info en el sistema...', intent_signal: 'NONE' };
    }

    // Inventario: scrape en vivo → fallback BD → fallback texto
    let invS = scrapeCache.data;
    if (!invS) {
      try {
        const dbInv = await tRead(F.inventory, tenant, []);
        if (Array.isArray(dbInv) && dbInv.length > 0) {
          const pSign = String.fromCharCode(36);
          invS = dbInv.map(i =>
            `- ${i.brand||''} ${i.model||''}${i.year?' '+i.year:''}`
            + (i.km ? ` | ${i.km}` : '')
            + ` | ${pSign}${(i.price||0).toLocaleString('es-CL')}`
            + (i.fuel ? ` | ${i.fuel}` : '')
            + (i.link ? ` | ${i.link}` : '')
          ).join('\n');
          console.log('[marcela] scrapeCache vacío — usando inventario BD:', dbInv.length, 'autos');
        }
      } catch(eInv) { console.warn('[marcela] Error leyendo inventario BD:', eInv.message); }
    }
    if (!invS) invS = '(sin inventario disponible temporalmente)';
    const knowledge = botCfg?.knowledge || [];
    // Incluir TODAS las notas de Sistema/Bot (sin slice para no perder la nota de portal del primer mensaje)
    const sysNotes = (notes||[]).filter(n => n.author === 'Sistema' || n.author === 'Bot').map(n => n.content).join(' | ');
    const instrucciones = baseSysPrompt.replace(/\{nombreIA\}/g, assignedName || 'Cata');

    const invBlock = '<INVENTARIO_DISPONIBLE>\nREGLA: Esta sección es SOLO lectura de referencia. Úsala únicamente cuando el cliente pregunte por un vehículo específico o pida ver opciones. NUNCA menciones precios de esta sección de forma proactiva en los Pasos 1 o 2.\n' + invS + '\n</INVENTARIO_DISPONIBLE>';

    const knowBlock = knowledge.length > 0
      ? '<CAMPANAS_Y_CONOCIMIENTO>\nREGLA ABSOLUTA: Esta sección es SOLO lectura de contexto pasivo. La información aquí contenida NO modifica ni interrumpe tu embudo de 6 pasos. Si una campaña aplica al vehículo consultado, menciónala sutilmente DESPUÉS de hacer la pregunta que te corresponde según tu paso actual. NUNCA adelantes precios ni saltes pasos por causa de esta sección.\n' + knowledge.map(k => '- ' + k.content).join('\n') + '\n</CAMPANAS_Y_CONOCIMIENTO>'
      : '';

    const contextBlock = sysNotes ? '<CONTEXTO_DEL_PORTAL>\n' + sysNotes + '\n</CONTEXTO_DEL_PORTAL>' : '';

    const sysPromptFinal = [
      '<INSTRUCCIONES_DEL_SISTEMA>',
      instrucciones,
      '</INSTRUCCIONES_DEL_SISTEMA>',
      contextBlock || null,
      invBlock,
      knowBlock || null
    ].filter(Boolean).join('\n\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      messages: [
        { role: 'system', content: sysPromptFinal },
        ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })),
        { role: 'user', content: msg }
      ]
    });

    return { reply: completion.choices[0].message.content, intent_signal: 'NONE' };
  } catch(e) {
    console.error('[Marcela-Crash]:', e.message);
    return { reply: 'Dame un segundito, estoy validando la info en el sistema...', intent_signal: 'NONE' };
  }
}
const F={users:path.join(DATA,'users.json'),leads:path.join(DATA,'leads.json'),config:path.join(DATA,'config.json'),bot:path.join(__dirname,'bot.json'),inventory:path.join(DATA,'inventory.json'),rr:path.join(DATA,'rr.json'),spend:path.join(DATA,'spend.json')};
const TENANTS=['demo_automotora','demo_clinica'];
const sessions=new Map();
const chatSessions=new Map();
// ── DEBOUNCE: acumula mensajes del mismo número por 5s antes de responder ──
const botDebounce = new Map();
const processedMsgIds = new Set();
const SLA_GREEN=20;
const SLA_YELLOW=50;
const SLA_REASSIGN=30;
const FINAL_ST=new Set(['Cerrado','Abandonado','Perdido']);
const VALID_ST=new Set(['Nuevo','En Proceso','Contactado','Calificado','Agendado','Reservado','Seguimiento','Negociación','Atendido','Cerrado','Abandonado','Perdido','esperando_respuesta_chileautos','esperando_respuesta_general']);
const read=async f=>{try{return JSON.parse(await fs.readFile(f,'utf8'));}catch{return{};}};
const write=(f,d)=>fs.writeFile(f,JSON.stringify(d,null,2));
const tRead=async(f,t,fb=[])=>{const s=await read(f);return s[t]!==undefined?s[t]:fb;};
const tWrite=async(f,t,d)=>{const s=await read(f);s[t]=d;await write(f,s);};
const validT=t=>TENANTS.includes(t)?t:TENANTS[0];

// ── Vendedores RMG — pool fijo para ruleta ─────────────────
const RMG_VENDORS = [
  {username:'Dnarvaez',name:'Daniela Narvaez',role:'vendedor',phone:'56922117391',status:'Activo'},
  {username:'Cfracachan',name:'Carlos Fracachan',role:'vendedor',phone:'56984926769',status:'Activo'},
];

// ── Web Scraper Heurístico — rmgautos.cl/usados/ ───────────
const RMG_SCRAPE_URL = 'https://rmgautos.cl/usados/';
const MARCAS_RE = /Toyota|Peugeot|Kia|Volkswagen|Ford|Chevrolet|Hyundai|Nissan|Suzuki|Mazda|Honda|Mitsubishi|Jeep|Land Rover|BMW|Mercedes|Audi|Subaru|Volvo|Chery|MG|BAIC|Renault|Opel|Ram|Ssangyong|Karry|Alfa Romeo|Changan|Citroen|Fiat|Seat|Skoda|Haval|Geely|BYD/gi;
let scrapeCache = { ts: 0, data: '' };

async function scrapeRMG() {
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
    const linkTagRE = /href="(https:\/\/rmgautos\.cl\/product\/[^"]+)"/gi;
    let lm;
    while ((lm = linkTagRE.exec(html)) !== null) {
      const url = lm[1].replace(/\/$/, '');
      if (!linkMap.includes(url)) linkMap.push(url);
    }

    // Extraer valores de headings con regex simple (una sola linea cada uno en el HTML real)
    // Formato: <h2 class="...">VALOR</h2> o <h6 class="...">LABEL</h6>
    const tokens = [];
    const re2 = /<h2\b[^>]*>([^<]+)<\/h2>/gi;
    const re6 = /<h6\b[^>]*>([^<]+)<\/h6>/gi;

    // Combinar posiciones de h2 y h6 en orden de aparicion
    const matches = [];
    let m;
    while ((m = re2.exec(html)) !== null) matches.push({ pos: m.index, level: 2, text: m[1].trim() });
    while ((m = re6.exec(html)) !== null) matches.push({ pos: m.index, level: 6, text: m[1].trim() });
    matches.sort((a, b) => a.pos - b.pos);
    const toks = matches.filter(t => t.text.length > 0 && t.text.length < 200);

    const parsePrecio = (s) => parseInt((s||'').replace(/\./g,'').replace(',','').replace(/[^\d]/g,''),10)||0;

    const structuredItems = [];
    const autos = [];
    let autoIdx = 0;
    let i = 0;

    while (i < toks.length) {
      // Inicio de auto: h6 "Precio Lista:"
      if (toks[i].level !== 6 || !/precio lista/i.test(toks[i].text)) { i++; continue; }

      let j = i + 1;

      // Precio Lista: siguiente h2 con $
      while (j < toks.length && !(toks[j].level === 2 && toks[j].text.includes('$'))) j++;
      const precioLista = j < toks.length ? parsePrecio(toks[j].text) : 0;
      j++;

      // h6 "Precio Crédito:"
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

      // Saltar "|"
      while (j < toks.length && toks[j].text.trim() === '|') j++;

      // Versión: h2 que NO sea solo 4 dígitos ni "|" ni $ 
      let version = '';
      if (j < toks.length && toks[j].level === 2 && !/^\d{4}$/.test(toks[j].text) && toks[j].text !== '|' && !toks[j].text.includes('$')) {
        version = toks[j].text.trim();
        j++;
      }

      // Saltar "|"
      while (j < toks.length && toks[j].text.trim() === '|') j++;

      // Año: h2 con exactamente 4 dígitos
      let anno = null;
      if (j < toks.length && /^\d{4}$/.test(toks[j].text.trim())) {
        anno = parseInt(toks[j].text.trim(), 10);
        j++;
      }

      // Saltar "|"
      while (j < toks.length && toks[j].text.trim() === '|') j++;

      // Km: h2 con número puro (sin $, sin letras)
      let km = 0;
      if (j < toks.length && /^[\d.,]+$/.test(toks[j].text.trim()) && !toks[j].text.includes('$')) {
        km = parseInt(toks[j].text.replace(/[.,]/g,''), 10);
        j++;
      }

      // Saltar "|"
      while (j < toks.length && toks[j].text.trim() === '|') j++;

      // Combustible, transmisión, tipo — hasta próximo "Precio Lista" o fin
      let fuel = '', trans = '', tipo = '';
      while (j < toks.length && !/precio lista/i.test(toks[j].text)) {
        const t = toks[j].text.trim();
        if (/^(GASOLINA|DIESEL|DI.SEL|H.BRIDO|EL.CTRICO|BENCINA|HYBRIDO)/i.test(t) && !fuel) fuel = t.toUpperCase();
        if (/^(AUTOM.TICO|MEC.NICO|CVT|DSG|TIPTRONIC)/i.test(t) && !trans) trans = t.toUpperCase();
        if (/^(SUV|HATCHBACK|SED.N|FURG.N|PICKUP|STATION|MINIVAN|COUPE)/i.test(t) && !tipo) tipo = t.toUpperCase();
        j++;
      }

      const cardLink   = linkMap[autoIdx] || 'https://rmgautos.cl/usados/';
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

    scrapeCache = { ts: now, data: [...new Set(autos)].join('\n'), items: structuredItems };
    console.log('[RMG-Scraper v4] ' + structuredItems.length + ' autos OK');
    return scrapeCache.data;
  } catch(e) {
    console.warn('[RMG-Scraper] Error:', e.message, '— usando cache o fallback');
    return scrapeCache.data || '';
  }
}

/* [NODO FANTASMA DESTRUIDO: Cron Viejo (Variable tenant)] */

scrapeRMG().catch(()=>{});

function invStr(inv){if(!Array.isArray(inv)||!inv.length)return'(sin inventario)';return inv.map(i=>`- [${i.id}] ${i.brand||''} ${i.model}${i.year?' '+i.year:''} | Stock:${i.stock} | $${(i.price||0).toLocaleString('es-CL')}${i.fuel?'|'+i.fuel:''}${i.highlights?'|'+i.highlights:''}`).join('\n');}

// ── Prompt camaleónico: nombre del asesor asignado ─────────

function parseJ(raw){if(!raw)return null;const a=raw.indexOf('{'),b=raw.lastIndexOf('}');if(a===-1||b===-1)return null;try{return JSON.parse(raw.slice(a,b+1));}catch{return null;}}
function fueraH(txt){const m=(txt||'').match(/(\d{1,2})\s*(?::|\.)?\s*(\d{2})?\s*(am|pm|hrs?|h)?/i);if(!m)return false;let h=parseInt(m[1],10);const min=parseInt(m[2]||'0',10);const mer=(m[3]||'').toLowerCase();if(mer==='pm'&&h<12)h+=12;if(mer==='am'&&h===12)h=0;const total=h*60+min;return total<570||total>=1110;}



const SHIELD=['body elite','bodyelite','botox','lipo','lipoescultura','liposuccion','estetica','estética','masaje','masajes','doctora','tratamiento','acido hialuronico'];
const SHIELD_R='¡Hola! Este número es de Automotora Andes 🚗 Para Body Elite ve a su Instagram. ¡Gracias!';
function isShield(t){if(!t)return false;const n=t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');return SHIELD.some(k=>n.includes(k.normalize('NFD').replace(/[\u0300-\u036f]/g,'')));}

async function getSellers(tenant) {
  const allUsers = await tRead(F.users, tenant);
  return allUsers.filter(u => u.role === 'vendedor' && (!u.status || u.status === 'Activo'));
}
async function rrNext(tenant,exclude=null){const sl=await getSellers(tenant);if(!sl.length)return null;const pool=exclude?sl.filter(s=>s.username!==exclude):sl;const list=pool.length?pool:sl;const rr=await read(F.rr);const idx=(rr[tenant]||0)%list.length;rr[tenant]=(idx+1)%list.length;await write(F.rr,rr);return list[idx];}


function enHorarioHabil() {
  const d = new Date();
  // Ajuste a hora de Chile (UTC-4 o UTC-3 dependiendo de la época, asumimos zona local del servidor)
  // Lo ideal es fijarlo a la zona horaria de Chile si el servidor está en otra parte.
  // Usaremos Intl.DateTimeFormat para estar seguros.
  const options = { timeZone: 'America/Santiago', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'long' };
  const formatter = new Intl.DateTimeFormat('es-CL', options);
  const parts = formatter.formatToParts(d);
  
  let hour = 0, minute = 0, weekday = '';
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
    if (p.type === 'weekday') weekday = p.value.toLowerCase();
  }

  // Si es Domingo, nunca es hábil
  if (weekday === 'domingo') return false;

  const totalMins = hour * 60 + minute;
  const startMins = 10 * 60; // 10:00
  const endMins = 18 * 60 + 30; // 18:30

  // Si es Sábado, el cierre es a las 14:00 según lo que me comentaste antes
  if (weekday === 'sábado' || weekday === 'sabado') {
      return totalMins >= startMins && totalMins <= (14 * 60);
  }

  return totalMins >= startMins && totalMins <= endMins;
}

function calcAlert(lead){
  // Si no estamos en horario hábil, el SLA se congela en 'fresh' (a menos que ya estuviera crítico/en riesgo antes de cerrar)
  if (!enHorarioHabil()) {
      return lead.alertLevel || 'none'; 
  }

  if(FINAL_ST.has(lead.status))return'none';
  if(lead.status==='esperando_respuesta_chileautos'||lead.status==='esperando_respuesta_general')return'none';
  if(lead.status==='Reservado'){
    const ref=lead.reservadoAt||lead.lastInteraction;
    if(!ref)return'none';
    const hrs=(Date.now()-new Date(ref).getTime())/3600000;
    return hrs>72?'critical':hrs>48?'risk':'fresh';
  }
  const applies=lead.status==='Nuevo'||lead.unread===true;
  if(!applies)return'none';
  const ref=(lead.status==='esperando_respuesta_chileautos'||lead.status==='esperando_respuesta_general')?lead.lastInteraction:(lead.lastClientTs||lead.lastInteraction);
  if(!ref)return'none';
  const m=(Date.now()-new Date(ref).getTime())/60000;
  if(m>SLA_YELLOW)return'critical';
  if(m>SLA_GREEN)return'risk';
  return'fresh';
}

async function applySlaRules(tenant){
  const leads=await tRead(F.leads,tenant);
  const allUsers=await tRead(F.users,tenant);
  let changed=false;
  for(const lead of leads){
    if(FINAL_ST.has(lead.status))continue;
    const prev=lead.alertLevel||'none';
    if(lead.status==='Reservado'&&!lead.reservadoAlertSent){
      const ref=lead.reservadoAt||lead.lastInteraction;
      const hrs=ref?(Date.now()-new Date(ref).getTime())/3600000:0;
      if(hrs>72){
        lead.reservadoAlertSent=true;changed=true;
        const admin=allUsers.find(u=>u.role==='admin');
        const assignedUser=allUsers.find(u=>u.username===lead.assignedTo)||RMG_VENDORS.find(v=>v.username===lead.assignedTo);
        const msg='🔴 RESERVA VENCIDA (+72h): '+lead.name+'. La reserva lleva más de 3 días. Acción inmediata requerida.';
        alertStaff(tenant, admin, '🔴 Reserva Vencida', msg);
        alertStaff(tenant, assignedUser, '🔴 Reserva Vencida', msg);
      }
    }
    if(lead.status==='Nuevo'){
      const ref=(lead.status==='esperando_respuesta_chileautos'||lead.status==='esperando_respuesta_general')?lead.lastInteraction:(lead.lastClientTs||lead.lastInteraction);
      const mins=ref?(Date.now()-new Date(ref).getTime())/60000:0;
      if(mins>SLA_REASSIGN&&!lead.reassigned && enHorarioHabil()){
        const nextObj=await rrNext(tenant,lead.assignedTo);
        if(nextObj&&nextObj.username!==lead.assignedTo){
          const aiSumR=lead.ai_summary?' Resumen IA: '+lead.ai_summary:'';
          lead.assignedTo=nextObj.username;lead.reassigned=true;lead.reassignedAt=new Date().toISOString();lead.adminReassignAlertSent=false;changed=true;
          alertStaff(tenant, nextObj, '🚨 Reasignación', '🚨 REASIGNACIÓN: Se te asignó el lead ['+lead.name+'] porque el anterior no respondió en 30 min.'+aiSumR);
        }else{lead.reassigned=true;lead.reassignedAt=new Date().toISOString();lead.adminReassignAlertSent=false;changed=true;}
      }
      if(lead.reassigned&&lead.reassignedAt&&lead.unread&&lead.adminReassignAlertSent===false){
        const minsR=(Date.now()-new Date(lead.reassignedAt).getTime())/60000;
        if(minsR>SLA_REASSIGN){
          lead.adminReassignAlertSent=true;changed=true;
          const adminU=allUsers.find(u=>u.role==='admin');
          const aiSumA=lead.ai_summary?' Resumen IA: '+lead.ai_summary:'';
          alertStaff(tenant, adminU, '📢 Alerta Admin', '📢 ALERTA ADMIN: ['+lead.name+'] lleva 30+ min sin atención tras reasignación.'+aiSumA);
        }
      }
    }
    const lvl=calcAlert(lead);
    if(lvl!==prev){lead.alertLevel=lvl;changed=true;}
    if(lead.botActive===undefined){lead.botActive=true;changed=true;}
  }
  if(changed)await tWrite(F.leads,tenant,leads);
  return leads;
}

function parseDateRange(start,end){let s=null,e=null;if(start){const d=new Date(start);if(!isNaN(d)){d.setHours(0,0,0,0);s=d.getTime();}}if(end){const d=new Date(end);if(!isNaN(d)){d.setHours(23,59,59,999);e=d.getTime();}}return{s,e};}
function inRange(lead,s,e){if(s===null&&e===null)return true;const ts=new Date(lead.lastInteraction||0).getTime();return(s===null||ts>=s)&&(e===null||ts<=e);}

async function seed(){

  try {
    const db = JSON.parse(fsSync.readFileSync(F.leads, 'utf8'));
    let modified = false;
    for (const t in db) {
      for (const l of db[t]) {
        ['lastInteraction','lastClientTs','createdAt','reservadoAt'].forEach(k => {
          if (l[k] && typeof l[k] === 'string' && (l[k].includes('12-31') || l[k].includes('31-12'))) {
            l[k] = new Date().toISOString(); modified = true;
          }
        });
      }
    }
    if (modified) fsSync.writeFileSync(F.leads, JSON.stringify(db, null, 2));
  } catch(e) {}

  // GUARD: nunca sobreescribir leads si ya existen en disco
  try {
    const existing = JSON.parse(fs.readFileSync ? require('fs').readFileSync(F.leads,'utf8') : '{}');
    const total = Object.values(existing).reduce((a,v)=>a+(Array.isArray(v)?v.length:0),0);
    if(total > 0){
      console.log('[SEED] Leads protegidos en disco:',total,'— seed omite leads');
      // solo seed users/config, nunca leads
    }
  } catch(e){}

  // PROTECCIÓN: si /var/data/leads.json tiene datos, no tocar
  try {
    const leadsData = JSON.parse(fs.readFileSync ? require('fs').readFileSync(F.leads,'utf8') : '{}');
    const totalLeads = Object.values(leadsData).reduce((a,v)=>a+(Array.isArray(v)?v.length:0),0);
    if(totalLeads > 0){ console.log('[SEED] Leads existentes:', totalLeads, '— no se sobreescriben'); }
  } catch(e){}

  const users=await read(F.users);
  if(!users.demo_automotora){users.demo_automotora=[
    {username:'gerente',password:'demo',name:'Andrés Salas',role:'admin',phone:'56912000001',status:'Activo'},
            {username:'recepcion',password:'demo',name:'Daniela Ortiz',role:'secretaria',phone:'56912000004',status:'Activo'}
  ];}else{
    // BLOQUEADO: no recrear vendors demo automaticamente
  }
  if(!users.demo_clinica)users.demo_clinica=[{username:'gerente',password:'demo',name:'Dr. Hernán Vidal',role:'admin',phone:'56912000010',status:'Activo'},{username:'vendedor1',password:'demo',name:'Karina Bravo',role:'vendedor',phone:'56912000011',status:'Activo'},{username:'recepcion',password:'demo',name:'Marcela Tapia',role:'secretaria',phone:'56912000012',status:'Activo'}];
  await write(F.users,users);
  const cfg=await read(F.config);
  if(!cfg.demo_automotora)cfg.demo_automotora={businessName:'RMG Autos',accentColor:'#3b82f6',stages:['Nuevo','En Proceso','Contactado','Calificado','Negociación','Agendado','Reservado','Cerrado','Abandonado']};
  else if(cfg.demo_automotora.stages&&!cfg.demo_automotora.stages.includes('Reservado')){
    const ci=cfg.demo_automotora.stages.indexOf('Cerrado');
    if(ci!==-1)cfg.demo_automotora.stages.splice(ci,0,'Reservado');
    else cfg.demo_automotora.stages.push('Reservado');
  }
  if(!cfg.demo_clinica)cfg.demo_clinica={businessName:'Clínica Vital',accentColor:'#0d9488',stages:['Nuevo','En Proceso','Contactado','Agendado','Calificado','Atendido','Seguimiento','Cerrado','Abandonado']};
  await write(F.config,cfg);
  const bot=await read(F.bot);
  if(!bot.demo_clinica)bot.demo_clinica={greeting:'Hola 👋 Soy la asistente de Clínica Vital. ¿En qué te puedo ayudar?'};
  await write(F.bot,bot);
  const inv=await read(F.inventory);
  if(!inv.demo_automotora)inv.demo_automotora=[];
  if(!inv.demo_clinica)inv.demo_clinica=[{id:'VIT-DERM',brand:'',model:'Hora Dermatología',stock:12,price:45000},{id:'VIT-GIN',brand:'',model:'Hora Ginecología',stock:9,price:50000},{id:'VIT-MG',brand:'',model:'Medicina General',stock:25,price:32000}];
  await write(F.inventory,inv);
  const spend=await read(F.spend);
  if(!spend.demo_automotora)spend.demo_automotora={'Meta Ads':1200000,'Google Ads':900000,'Chileautos':600000,'WhatsApp':0,'Instagram':350000,'Landing Page':0,'Referido':0};
  if(!spend.demo_clinica)spend.demo_clinica={'Meta Ads':620000,'Google Ads':880000,'Instagram':310000,'Landing Page':0};
  await write(F.spend,spend);
  // 🛡️ AUTO-BORRADO DE LEADS DESACTIVADO POR SEGURIDAD
}

const auth=(...roles)=>async(req,res,next)=>{
  const token=req.header('X-Auth-Token')||req.query.token;
  const sess=sessions.get(token);
  if(!sess)return res.status(401).json({error:'No autenticado'});
  if(roles.length&&!roles.includes(sess.user.role))return res.status(403).json({error:'Sin permisos'});
  req.user=sess.user;req.tenant=sess.tenant;next();
};
const byRole=(leads,user)=>user.role==='vendedor'?leads.filter(l=>l.assignedTo===user.username):leads;

app.post('/api/auth/login',async(req,res)=>{
  const{username,password,tenant}=req.body||{};const t=validT(tenant);const users=await tRead(F.users,t);
  const u=users.find(x=>x.username===username&&x.password===password);
  if(!u)return res.status(401).json({error:'Credenciales incorrectas'});
  const token=crypto.randomBytes(24).toString('hex');const safe={username:u.username,name:u.name,role:u.role};
  sessions.set(token,{user:safe,tenant:t});res.json({token,user:safe,tenant:t,expires:Date.now()+86400000});
});
app.post('/api/auth/logout',(req,res)=>{sessions.delete(req.header('X-Auth-Token'));res.json({ok:true});});
app.get('/api/me',auth(),(req,res)=>res.json({user:req.user,tenant:req.tenant}));

app.get('/api/users',auth('admin'),async(req,res)=>{const users=await tRead(F.users,req.tenant);res.json(users.map(u=>({username:u.username,name:u.name,role:u.role,status:u.status||'Activo',phone:u.phone||''})));});
app.post('/api/users',auth('admin'),async(req,res)=>{const{username,password,name,role,phone,status}=req.body||{};if(!username||!name||!role)return res.status(400).json({error:'username,name,role requeridos'});const users=await tRead(F.users,req.tenant);if(users.find(u=>u.username===username))return res.status(409).json({error:'Ya existe'});const nu={username,password:password||'demo',name,role,phone:phone||'',status:status||'Activo'};users.push(nu);await tWrite(F.users,req.tenant,users);res.status(201).json(nu);});
app.put('/api/users/:username',auth('admin'),async(req,res)=>{const users=await tRead(F.users,req.tenant);const idx=users.findIndex(u=>u.username===req.params.username);if(idx===-1)return res.status(404).json({error:'No encontrado'});const{name,role,phone,status,password}=req.body||{};if(name)users[idx].name=name;if(role)users[idx].role=role;if(phone!==undefined)users[idx].phone=phone;if(status)users[idx].status=status;if(password)users[idx].password=password;await tWrite(F.users,req.tenant,users);res.json(users[idx]);});
app.delete('/api/users/:username',auth('admin'),async(req,res)=>{const users=await tRead(F.users,req.tenant);const idx=users.findIndex(u=>u.username===req.params.username);if(idx===-1)return res.status(404).json({error:'No encontrado'});if(users[idx].role==='admin')return res.status(403).json({error:'No se puede eliminar admin'});users.splice(idx,1);await tWrite(F.users,req.tenant,users);res.json({ok:true});});


// [NUEVO ENDPOINT: ENVIAR ARCHIVO A WA]
const multer = require('multer');
const uploadWA = multer({ dest: '/tmp/' }); // Guardado temporal
app.post('/api/leads/:id/send-media', auth('admin','vendedor'), uploadWA.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({error: 'Archivo requerido'});
    const leads = await tRead(F.leads, req.tenant);
    const idx = leads.findIndex(x => x.id == req.params.id);
    if(idx === -1) return res.status(404).json({error: 'Lead no encontrado'});

    const token = (process.env.WA_TOKEN || '').trim();
    const phoneId = (process.env.WA_PHONE_ID || '').trim();
    const phone = (leads[idx].phone || '').replace(/\D/g,'');
    if(!token || !phoneId || !phone) return res.status(500).json({error: 'WA no configurado o sin telefono'});

    // Servir el archivo temporalmente como URL pública
    const tmpName = req.file.filename || path.basename(req.file.path);
    const mimeToExt = {'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov','application/pdf':'pdf','application/msword':'doc','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx'};
    const ext = mimeToExt[req.file.mimetype] || 'bin';
    const namedPath = req.file.path + '.' + ext;
    fsSync.renameSync(req.file.path, namedPath);
    req.file.path = namedPath;
    const publicUrl = (process.env.RENDER_EXTERNAL_URL || 'https://body-elite-giftcards.onrender.com') + '/tmp-media/' + tmpName + '.' + ext;

    // Determinar tipo
    let type = 'document';
    if(req.file.mimetype.startsWith('image/')) type = 'image';
    if(req.file.mimetype.startsWith('video/')) type = 'video';

    // Enviar con link público (Meta descarga el archivo)
    const mediaObj = { link: publicUrl };
    if (type === 'document') mediaObj.filename = req.file.originalname || tmpName;

    const msgBody = {
      messaging_product: 'whatsapp',
      to: phone,
      type: type,
      [type]: mediaObj
    };

    const sndRes = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody)
    });
    const sndJson = await sndRes.json();
    console.log('[SEND-MEDIA] to:', phone, '| type:', type, '| url:', publicUrl, '| response:', JSON.stringify(sndJson));

    // Borrar temporal después de 60s
    setTimeout(() => { try { fsSync.unlinkSync(req.file.path); } catch(_){} }, 60000);

    if(sndRes.ok && sndJson.messages) {
      leads[idx].chatHistory = leads[idx].chatHistory || [];
      leads[idx].chatHistory.push({ role: 'agent', content: '[ARCHIVO ENVIADO AL CLIENTE]', ts: Date.now(), agent: req.user.username });
      await tWrite(F.leads, req.tenant, leads);
      return res.json({ success: true });
    } else {
      return res.status(502).json({error: 'Error al enviar por WA', details: sndJson});
    }
  } catch(e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

app.get('/api/leads',auth(),async(req,res)=>{
  const all=await applySlaRules(req.tenant);const{s,e}=parseDateRange(req.query.start,req.query.end);
  let leads=byRole(all,req.user);if(s!==null||e!==null)leads=leads.filter(l=>inRange(l,s,e));
  if(req.query.seller&&req.user.role==='admin')leads=leads.filter(l=>l.assignedTo===req.query.seller);
  leads.forEach(l=>{if(!Array.isArray(l.chatHistory))l.chatHistory=[];if(!Array.isArray(l.notes))l.notes=[];if(!l.intentSignal)l.intentSignal='NONE';if(!l.lastClientTs)l.lastClientTs=l.lastInteraction||new Date().toISOString();});
  leads.sort((a,b)=>new Date(b.lastClientTs||0)-new Date(a.lastClientTs||0));res.json(leads);
});
app.get('/api/leads/:id',auth(),async(req,res)=>{await applySlaRules(req.tenant);const leads=await tRead(F.leads,req.tenant);const l=leads.find(x=>x.id==req.params.id);if(!l)return res.status(404).json({error:'No encontrado'});if(req.user.role==='vendedor'&&l.assignedTo!==req.user.username)return res.status(403).json({error:'Sin permisos'});res.json(l);});
app.patch('/api/leads/:id',auth(),async(req,res)=>{
  const leads=await tRead(F.leads,req.tenant);const idx=leads.findIndex(x=>x.id==req.params.id);
  if(idx===-1)return res.status(404).json({error:'No encontrado'});
  if(req.user.role==='vendedor'&&leads[idx].assignedTo!==req.user.username)return res.status(403).json({error:'Sin permisos'});
  const ALLOWED=['status','interest','name','phone','botActive','nextAction','pastActions','source','lastClientTs','lastInteraction','createdAt'];if(req.user.role!=='vendedor')ALLOWED.push('assignedTo');
  // Borrado individual via patch status '_delete_'
  if(req.body.status==='_delete_'){
    const before=leads.length;
    const remaining=leads.filter(x=>x.id!=req.params.id);
    await tWrite(F.leads,req.tenant,remaining);
    return res.json({ok:true,deleted:before-remaining.length});
  }
  const patch={};for(const k of ALLOWED)if(req.body[k]!==undefined)patch[k]=req.body[k];
  if(patch.status!==undefined&&!VALID_ST.has(patch.status))return res.status(400).json({error:'Status inválido'});
  if(req.body.note&&String(req.body.note).trim()){leads[idx].notes=Array.isArray(leads[idx].notes)?leads[idx].notes:[];leads[idx].notes.push({content:String(req.body.note).trim(),author:req.user.name||req.user.username,ts:Date.now()});}
  if(patch.status==='Reservado'&&leads[idx].status!=='Reservado')patch.reservadoAt=new Date().toISOString();
  if(patch.status==='Nuevo' && (leads[idx].status==='esperando_respuesta_chileautos'||leads[idx].status==='esperando_respuesta_general')){
  const now=new Date().toISOString();
  patch.lastClientTs=now;
  patch.lastInteraction=now;
  patch.alertLevel='none';
}
  Object.assign(leads[idx],patch);
  if(patch.lastInteraction===undefined) leads[idx].lastInteraction=new Date().toISOString();leads[idx].unread=false;leads[idx].alertLevel=calcAlert(leads[idx]);
  await tWrite(F.leads,req.tenant,leads);res.json(leads[idx]);
});
app.put('/api/leads/:id',auth(),async(req,res)=>{const leads=await tRead(F.leads,req.tenant);const idx=leads.findIndex(x=>x.id==req.params.id);if(idx===-1)return res.status(404).json({error:'No encontrado'});if(req.user.role==='vendedor'&&leads[idx].assignedTo!==req.user.username)return res.status(403).json({error:'Sin permisos'});if(req.user.role==='vendedor')delete req.body.assignedTo;leads[idx]={...leads[idx],...req.body,lastInteraction:new Date().toISOString()};leads[idx].alertLevel=calcAlert(leads[idx]);await tWrite(F.leads,req.tenant,leads);res.json(leads[idx]);});

app.post('/api/leads/:id/resumen',auth('admin','vendedor'),async(req,res)=>{
  const leads=await tRead(F.leads,req.tenant);
  const idx=leads.findIndex(x=>x.id==req.params.id);
  if(idx===-1)return res.status(404).json({error:'No encontrado'});
  const lead=leads[idx];

  // [SPRINT5-MULTIMEDIA-BACKEND]
  (async () => {
    try {
      const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (message && lead) {
        if (!lead.media) lead.media = [];
        let changed = false;

        if (message.type === 'image' && message.image) {
          const mediaObj = {
            type: 'image',
            url: message.image.id || message.image.link || '',
            text: message.image.caption || '',
            ts: Date.now()
          };
          lead.media.push(mediaObj);
          lead.chatHistory = lead.chatHistory || [];
          lead.chatHistory.push({ role: 'user', content: `[IMAGEN RECIBIDA] ${mediaObj.text ? '— ' + mediaObj.text : ''}`.trim(), ts: mediaObj.ts });
          changed = true;
        }

        if (message.type === 'audio' && message.audio) {
          const mediaObj = {
            type: 'audio',
            url: message.audio.id || message.audio.link || '',
            text: '[Audio Recibido]',
            ts: Date.now()
          };
          lead.media.push(mediaObj);
          lead.chatHistory = lead.chatHistory || [];
          lead.chatHistory.push({ role: 'user', content: `[AUDIO RECIBIDO]`, ts: mediaObj.ts });
          changed = true;
        }
      }
    } catch (e) { console.error('Error procesando multimedia:', e); }
  })();
  const histSnip=(lead.chatHistory||[]).slice(-14).map(m=>(m.role==='user'?'Cliente':m.role==='agent'?'Vendedor':'IA')+': '+m.content).join('\n');
  const notasSnip=(lead.notes||[]).filter(n=>n.author!=='Resumen IA').slice(-5).map(n=>n.author+': '+n.content).join('\n');
  if(!histSnip)return res.status(400).json({error:'Sin historial'});
  try{
    const r=await openai.chat.completions.create({model:'gpt-4o-mini',temperature:0.4,max_tokens:200,
      messages:[{role:'system',content:'Eres un asistente comercial de automotora. Con el historial de chat y las notas del vendedor, redacta un BRIEFING narrativo de maximo 3 lineas: (1) [Nombre] consulta por [auto especifico]. (2) [Que dijo sobre financiamiento, retoma, fecha o acuerdo]. (3) Sugerencia: [accion concreta para el vendedor ahora]. Espanol directo, sin emojis, sin titulos, solo el parrafo.'},
                {role:'user',content:'NOMBRE: '+lead.name+'\nHISTORIAL:\n'+histSnip+(notasSnip?'\nNOTAS DEL VENDEDOR:\n'+notasSnip:'')}]});
    const resumen=(r.choices?.[0]?.message?.content||'').trim();
    if(!resumen)return res.status(500).json({error:'Sin respuesta de OpenAI'});
    lead.ai_summary=resumen;
    await tWrite(F.leads,req.tenant,leads);
    res.json({ok:true,ai_summary:resumen,lead});
  }catch(e){
    console.error('[resumen-error]',e.message);
    res.status(500).json({error:e.message});
  }
});

app.post('/api/leads/:id/bot',auth(),async(req,res)=>{const leads=await tRead(F.leads,req.tenant);const idx=leads.findIndex(x=>x.id==req.params.id);if(idx===-1)return res.status(404).json({error:'No encontrado'});if(req.user.role==='vendedor'&&leads[idx].assignedTo!==req.user.username)return res.status(403).json({error:'Sin permisos'});leads[idx].botActive=!!req.body.botActive;await tWrite(F.leads,req.tenant,leads);res.json(leads[idx]);});
app.post('/api/leads/:id/message',auth('admin','vendedor'),async(req,res)=>{
  const{content}=req.body||{};if(!content)return res.status(400).json({error:'content requerido'});
  const leads=await tRead(F.leads,req.tenant);const idx=leads.findIndex(x=>x.id==req.params.id);
  if(idx===-1)return res.status(404).json({error:'No encontrado'});
  if(req.user.role==='vendedor'&&leads[idx].assignedTo!==req.user.username)return res.status(403).json({error:'Sin permisos'});
  leads[idx].chatHistory=leads[idx].chatHistory||[];
  leads[idx].chatHistory.push({role:'agent',content,ts:Date.now(),agent:req.user.username,agentName:req.user.name||req.user.username});
  leads[idx].botPersona=req.user.name||req.user.username;
  leads[idx].unread=false;leads[idx].lastInteraction=new Date().toISOString();leads[idx].alertLevel=calcAlert(leads[idx]);
  await tWrite(F.leads,req.tenant,leads);
  const phone=(leads[idx].phone||'').replace(/\D/g,'');if(phone)sendWA(phone,content).catch(()=>{});
  res.json(leads[idx]);
});

app.get('/api/dashboard/vendedor',auth('admin','vendedor'),async(req,res)=>{
  const all=await applySlaRules(req.tenant);const{s,e}=parseDateRange(req.query.start,req.query.end);
  let leads=(s!==null||e!==null)?all.filter(l=>inRange(l,s,e)):all;
  if(req.user.role==='vendedor') leads=leads.filter(l=>l.assignedTo===req.user.username);
  const nuevos=leads.filter(l=>l.status==='Nuevo');const closed=leads.filter(l=>l.status==='Cerrado').length;
  const now=Date.now();const minOf=l=>(now-new Date(l.lastClientTs||l.lastInteraction).getTime())/60000;
  const avgResp=nuevos.length?Math.round(nuevos.reduce((a,l)=>a+minOf(l),0)/nuevos.length):0;
  res.json({total:leads.length,active:leads.filter(l=>!FINAL_ST.has(l.status)).length,closed,unread:leads.filter(l=>l.unread).length,sla:{fresh:nuevos.filter(l=>l.alertLevel==='fresh').length,risk:nuevos.filter(l=>l.alertLevel==='risk').length,critical:nuevos.filter(l=>l.alertLevel==='critical').length,reassigned:leads.filter(l=>l.reassigned).length},avgResponseMin:avgResp,convRate:leads.length?((closed/leads.length)*100).toFixed(1):'0.0',byStatus:{nuevo:nuevos.length,contactado:leads.filter(l=>l.status==='Contactado').length,calificado:leads.filter(l=>l.status==='Calificado').length,agendado:leads.filter(l=>l.status==='Agendado').length,negociacion:leads.filter(l=>l.status==='Negociación').length,seguimiento:leads.filter(l=>l.status==='Seguimiento').length,cerrado:closed,perdido:leads.filter(l=>['Abandonado','Perdido'].includes(l.status)).length}});
});
app.get('/api/dashboard/kpis',auth('admin'),async(req,res)=>{
  const all=await applySlaRules(req.tenant);const{s,e}=parseDateRange(req.query.start,req.query.end);
  const leads=(s!==null||e!==null)?all.filter(l=>inRange(l,s,e)):all;
  const nuevos=leads.filter(l=>l.status==='Nuevo');const closed=leads.filter(l=>l.status==='Cerrado').length;
  const now=Date.now();const minOf=l=>(now-new Date(l.lastClientTs||l.lastInteraction).getTime())/60000;
  const avg=nuevos.length?Math.round(nuevos.reduce((a,l)=>a+minOf(l),0)/nuevos.length):0;
  res.json({total:leads.length,active:leads.filter(l=>!FINAL_ST.has(l.status)).length,closed,qualified:leads.filter(l=>l.status==='Calificado').length,unread:leads.filter(l=>l.unread).length,slaFresh:nuevos.filter(l=>l.alertLevel==='fresh').length,slaRisk:nuevos.filter(l=>l.alertLevel==='risk').length,slaCritical:nuevos.filter(l=>l.alertLevel==='critical').length,followFresh:leads.filter(l=>l.status!=='Nuevo'&&l.unread&&l.alertLevel==='fresh').length,followRisk:leads.filter(l=>l.status!=='Nuevo'&&l.unread&&l.alertLevel==='risk').length,followCritical:leads.filter(l=>l.status!=='Nuevo'&&l.unread&&l.alertLevel==='critical').length,avgResponseMin:avg,conversionRate:leads.length?((closed/leads.length)*100).toFixed(1):'0.0'});
});
app.get('/api/dashboard/team',auth('admin'),async(req,res)=>{
  const users=await tRead(F.users,req.tenant);const all=await tRead(F.leads,req.tenant);
  const{s,e}=parseDateRange(req.query.start,req.query.end);const leads=(s!==null||e!==null)?all.filter(l=>inRange(l,s,e)):all;
  const now=Date.now();const minOf=l=>(now-new Date(l.lastClientTs||l.lastInteraction).getTime())/60000;
  res.json(users.filter(u=>u.role==='vendedor').map(v=>{
    const own=leads.filter(l=>l.assignedTo===v.username);const nv=own.filter(l=>l.status==='Nuevo');const closed=own.filter(l=>l.status==='Cerrado').length;
    const avgResp=nv.length?Math.round(nv.reduce((a,l)=>a+minOf(l),0)/nv.length):0;
    return{username:v.username,name:v.name,total:own.length,sla:{fresh:own.filter(l=>l.alertLevel==='fresh').length,risk:own.filter(l=>l.alertLevel==='risk').length,critical:own.filter(l=>l.alertLevel==='critical').length},closed,unread:own.filter(l=>l.unread).length,convRate:own.length?((closed/own.length)*100).toFixed(1):'0.0',avgResponseMin:avgResp,byStatus:{nuevo:nv.length,contactado:own.filter(l=>l.status==='Contactado').length,calificado:own.filter(l=>l.status==='Calificado').length,agendado:own.filter(l=>l.status==='Agendado').length,negociacion:own.filter(l=>l.status==='Negociación').length,seguimiento:own.filter(l=>l.status==='Seguimiento').length,cerrado:closed,abandonado:own.filter(l=>['Abandonado','Perdido'].includes(l.status)).length},leads:own.map(l=>({...l,chatHistory:Array.isArray(l.chatHistory)?l.chatHistory:[],notes:Array.isArray(l.notes)?l.notes:[],intentSignal:l.intentSignal||'NONE'}))};
  }).filter(v=>v.total>0));
});
app.get('/api/analytics/channels',auth('admin'),async(req,res)=>{
  const all=await tRead(F.leads,req.tenant);
  const{s,e}=parseDateRange(req.query.start,req.query.end);
  let leads=(s!==null||e!==null)?all.filter(l=>inRange(l,s,e)):all;
  
  // ¡El Selector de Vendedor ahora filtra la analítica!
  if(req.query.seller) leads = leads.filter(l => l.assignedTo === req.query.seller);
  
  const ch={};
  for(const l of leads){
    const src=l.source||'Otro';
    let inter=l.interest||'Consulta Genérica';
    if(inter.length>45) inter=inter.substring(0,42)+'...';
    const c=src+' ➔ '+inter;
    
    if(!ch[c]){
      ch[c]={channel:inter,mainSrc:src,leads:0,nuevos:0,gestionados:0,cerrados:0,abandonados:0};
    }
    
    ch[c].leads++;
    if(l.status==='Nuevo') ch[c].nuevos++;
    else if(['Abandonado','Perdido'].includes(l.status)) ch[c].abandonados++;
    else if(l.status==='Cerrado') ch[c].cerrados++;
    else ch[c].gestionados++;
  }
  
  const agrupado = {};
  for(const val of Object.values(ch)) {
      if(!agrupado[val.mainSrc]) {
          agrupado[val.mainSrc] = {
              mainSrc: val.mainSrc,
              leads: 0, nuevos: 0, gestionados: 0, cerrados: 0, abandonados: 0,
              sub: []
          };
      }
      agrupado[val.mainSrc].leads += val.leads;
      agrupado[val.mainSrc].nuevos += val.nuevos;
      agrupado[val.mainSrc].gestionados += val.gestionados;
      agrupado[val.mainSrc].cerrados += val.cerrados;
      agrupado[val.mainSrc].abandonados += val.abandonados;
      agrupado[val.mainSrc].sub.push(val);
  }

  const resultado = Object.values(agrupado).map(g => {
      const operados = g.gestionados + g.cerrados;
      g.contactabilidad = g.leads ? ((operados / g.leads) * 100).toFixed(1) + '%' : '0.0%';
      g.fuga = g.leads ? ((g.abandonados / g.leads) * 100).toFixed(1) + '%' : '0.0%';
      g.sub = g.sub.map(s => {
          const sOperados = s.gestionados + s.cerrados;
          s.contactabilidad = s.leads ? ((sOperados / s.leads) * 100).toFixed(1) + '%' : '0.0%';
          s.fuga = s.leads ? ((s.abandonados / s.leads) * 100).toFixed(1) + '%' : '0.0%';
          return s;
      }).sort((a,b) => b.leads - a.leads);
      return g;
  }).sort((a,b) => b.leads - a.leads);

  res.json(resultado);
});
app.get('/api/pipeline',auth(),async(req,res)=>{const cfg=await tRead(F.config,req.tenant,{});const all=await applySlaRules(req.tenant);const{s,e}=parseDateRange(req.query.start,req.query.end);let leads=byRole(all,req.user);if(s!==null||e!==null)leads=leads.filter(l=>inRange(l,s,e));if(req.query.seller&&req.user.role==='admin')leads=leads.filter(l=>l.assignedTo===req.query.seller);res.json((cfg.stages||[]).map(st=>({stage:st,leads:leads.filter(l=>l.status===st)})));});
app.get('/api/config',auth(),async(req,res)=>res.json(await tRead(F.config,req.tenant,{})));
app.put('/api/config',auth('admin'),async(req,res)=>{const u={...await tRead(F.config,req.tenant,{}),...req.body};await tWrite(F.config,req.tenant,u);res.json(u);});
app.get('/api/bot',auth('admin'),async(req,res)=>res.json(await tRead(F.bot,req.tenant,{})));
app.put('/api/bot',auth('admin'),async(req,res)=>{const u={...await tRead(F.bot,req.tenant,{}),...req.body};await tWrite(F.bot,req.tenant,u);res.json(u);});
app.get('/api/inventory',auth('admin','vendedor'),async(req,res)=>res.json(await tRead(F.inventory,req.tenant)));

app.post('/api/force-sla',auth('admin'),async(req,res)=>{
  const leads=await tRead(F.leads,req.tenant);
  const ms=31*60000;let count=0;
  for(const l of leads){
    if(l.status==='Nuevo'){
      l.lastClientTs=new Date(new Date(l.lastClientTs||Date.now()).getTime()-ms).toISOString();
      l.lastInteraction=new Date(new Date(l.lastInteraction||Date.now()).getTime()-ms).toISOString();
      l.alertLevel=calcAlert(l);count++;
    }
  }
  await tWrite(F.leads,req.tenant,leads);
  const updated=await applySlaRules(req.tenant);
  res.json({ok:true,count,leads:updated.filter(l=>l.status==='Nuevo')});
});
app.post('/api/demo/fastforward',auth('admin'),async(req,res)=>{
  const{leadId,minutes=35}=req.body||{};const leads=await tRead(F.leads,req.tenant);const idx=leads.findIndex(x=>x.id==leadId);if(idx===-1)return res.status(404).json({error:'Lead no encontrado'});
  const ms=minutes*60000;leads[idx].lastClientTs=new Date(new Date(leads[idx].lastClientTs||Date.now()).getTime()-ms).toISOString();leads[idx].lastInteraction=new Date(new Date(leads[idx].lastInteraction||Date.now()).getTime()-ms).toISOString();leads[idx].alertLevel=calcAlert(leads[idx]);await tWrite(F.leads,req.tenant,leads);res.json({ok:true,lead:leads[idx]});
});

app.post('/api/chat',async(req,res)=>{
  const tenant=validT(req.body?.tenant||req.query.tenant);const{sessionId,message}=req.body||{};
  if(!sessionId||!message)return res.status(400).json({error:'sessionId y message requeridos'});
  const leads=await tRead(F.leads,tenant);const allUsers=await tRead(F.users,tenant);
  let sess=chatSessions.get(sessionId),captured=false,leadId;
  if(!sess){
    leadId=Date.now();const assignedObj=await rrNext(tenant);const assigned=assignedObj?.username||'vendedor1';const n=new Date().toISOString();
    leads.unshift({id:leadId,name:'Visitante',phone:'Pendiente',source:'Chat Web',status:'Nuevo',lastInteraction:n,lastClientTs:n,interest:message.slice(0,80),sessionId,assignedTo:assigned,botActive:true,alertLevel:'none',intentSignal:'NONE',unread:true,notes:[],chatHistory:[]});
    sess={tenant,leadId,step:0};chatSessions.set(sessionId,sess);captured=true;
    alertStaff(tenant, assignedObj, '🔔 Nuevo Lead', `🔔 NUEVO LEAD: "${message.slice(0,60)}" — atiéndelo en el CRM ahora.`);
  }else{leadId=sess.leadId;sess.step++;}
  const idx=leads.findIndex(l=>l.id===leadId);
  leads[idx].chatHistory=leads[idx].chatHistory||[];leads[idx].chatHistory.push({role:'user',content:message,ts:Date.now()});
  leads[idx].unread=true;
    // Marcar secuencia WA como respondida
    if (leads[idx].waSequence) leads[idx].waSequence.replied = true;
  if(leads[idx].botActive!==false){
    if(message.trim().toLowerCase()==='/reset'){leads.splice(idx,1);await tWrite(F.leads,tenant,leads);return res.json({reply:'🔄 Lead eliminado. Listo para nuevo ingreso desde Chileautos.',status:'eliminado',alertLevel:'none'});}
    const assignedUserChat=allUsers.find(u=>u.username===leads[idx].assignedTo)||RMG_VENDORS.find(v=>v.username===leads[idx].assignedTo);
    const assignedNameChat=leads[idx].botPersona||assignedUserChat?.name||'Cata';
    const p=await marcela(tenant,leads[idx].chatHistory.slice(0,-1),message,leads[idx].notes,assignedNameChat,leads[idx].source);
    applySignal(leads[idx],p);
    
    if(p.schedule_detected && p.schedule_text) {
        leads[idx].notes = Array.isArray(leads[idx].notes) ? leads[idx].notes : [];
        leads[idx].notes.push({content: '🚨 CITA AGENDADA POR IA: ' + p.schedule_text, author: 'Sistema', ts: Date.now()});
        leads[idx].intentSignal = 'BLUE';
        leads[idx].nextAction = {text: '📞 Llamar al cliente: ' + p.schedule_text, date: new Date(Date.now()+60000).toISOString(), createdAt: new Date().toISOString(), delegateToIA: false, iaCompleted: false};
    }

    if(!p.reply || p.reply.trim() === '') {
        leads[idx].notes = Array.isArray(leads[idx].notes) ? leads[idx].notes : [];
        leads[idx].notes.push({content: '🤫 IA detectó fin de conversación.', author: 'Sistema', ts: Date.now()});
    } else {
        leads[idx].chatHistory.push({role:'bot',content:p.reply,ts:Date.now()});
    }
    if(esKeywordCalif(message)&&!leads[idx].keywordAlertSent){
      leads[idx].keywordAlertSent=true;
      leads[idx].intentSignal='BLUE';
      try{
        const histSnip=leads[idx].chatHistory.slice(-10).map(m=>(m.role==='user'?'Cliente':'Asesor')+': '+m.content).join('\n');
        const notasSnip=(leads[idx].notes||[]).filter(n=>n.author!=='Resumen IA').slice(-3).map(n=>n.author+': '+n.content).join('\n');
        const resComp=await openai.chat.completions.create({model:'gpt-4o-mini',temperature:0.4,max_tokens:200,messages:[{role:'system',content:'Eres un asistente comercial de automotora. Con el historial de chat y las notas del vendedor, redacta un BRIEFING narrativo de maximo 3 lineas: (1) [Nombre] consulta por [auto especifico]. (2) [Que dijo sobre financiamiento, retoma, fecha o acuerdo]. (3) Sugerencia: [accion concreta para el vendedor ahora]. Espanol directo, sin emojis, sin titulos, solo el parrafo.'},{role:'user',content:'NOMBRE: '+leads[idx].name+'\nHISTORIAL:\n'+histSnip+(notasSnip?'\nNOTAS DEL VENDEDOR:\n'+notasSnip:'')}]});
        const resumenIA=(resComp.choices?.[0]?.message?.content||'').trim()||'Interés detectado en crédito/retoma.';
        leads[idx].ai_summary=resumenIA;
        alertStaff(tenant, assignedUserChat, '✅ Lead Asignado', '✅ Lead Asignado: '+leads[idx].name+'. Resumen IA: '+resumenIA+' — Entra al CRM para cerrar.');
      }catch(eIA){
        console.error('[Resumen-Error /chat]', eIA);
        leads[idx].notes.push({content:'🧠 Cliente mencionó crédito/retoma/seguro. (OpenAI falló: '+eIA.message+')',author:'Resumen IA',ts:Date.now()});
        alertStaff(tenant, assignedUserChat, '✅ Lead Asignado', '✅ Lead Asignado: '+leads[idx].name+'. Lee el resumen en la bitácora del CRM.');
      }
    }
    if(p.reply&&p.reply.indexOf('rmgautos.cl')!==-1){leads[idx].nextAction={text:'¿Pudiste ver la ficha en el enlace? Fíjate en los detalles del equipamiento 👀 ¿Qué te pareció?',date:new Date(Date.now()+3*60000).toISOString(),createdAt:new Date().toISOString(),delegateToIA:true,iaCompleted:false};}
    leads[idx].alertLevel=calcAlert(leads[idx]);
    await tWrite(F.leads,tenant,leads);
    return res.json({reply:p.reply,sessionId,leadCaptured:captured,leadId,intentSignal:leads[idx].intentSignal,status:leads[idx].status});
  }
  await tWrite(F.leads,tenant,leads);res.json({reply:null,sessionId,leadCaptured:captured,leadId,botPaused:true});
});


app.post('/api/leads/inbound', async (req, res) => {
  try {
    const { tenant='demo_automotora', name, phone='Pendiente', source='Chileautos', interest='', status='esperando_respuesta_chileautos', botActive=false, externalId=null, notes:extraNotes=[] } = req.body;
    const n = new Date().toISOString();
    const leads = await tRead(F.leads, tenant);

    // Deduplicar por externalId (leadId de Chileautos) o por teléfono si no es Pendiente
    let exists = null;
    if (externalId) {
      exists = leads.find(l => l.externalId === externalId);
    } else if (phone && phone !== 'Pendiente') {
      const clean2 = phone.replace(/\D/g,'');
      exists = leads.find(l => l.phone && l.phone.replace(/\D/g,'').includes(clean2));
    }
    if (exists) return res.json({ ok: true, leadId: exists.id, skipped: true });

    const clean = phone !== 'Pendiente' ? phone.replace(/\D/g,'') : '';
    const assignedObj = await rrNext(tenant) || { username: 'vendedor1' };
    const initNotes = [{ content: `Lead recibido desde ${source}. En sala de espera.`, author: 'Bot', ts: Date.now() }];
    const allNotes = [...initNotes, ...extraNotes];
    const lead = {
      id: Date.now(),
      externalId,
      name: name || 'Lead Chileautos',
      phone: clean ? '+' + clean : 'Pendiente',
      source,
      interest,
      status,
      botActive,
      alertLevel: 'none',
      intentSignal: 'NONE',
      unread: true,
      assignedTo: assignedObj.username,
      lastInteraction: n,
      lastClientTs: n,
      notes: allNotes,
      chatHistory: [],
      media: []
    };
    leads.unshift(lead);
    await tWrite(F.leads, tenant, leads);
    alertStaff(tenant, assignedObj, '🔔 Nuevo Lead Chileautos', '🔔 NUEVO LEAD CHILEAUTOS asignado a ti. Entra a FunnelOS → Chileautos para verlo.');
    console.log('[INBOUND] Lead creado:', name, phone, status, externalId || '');
    res.json({ ok: true, leadId: lead.id });
  } catch(e) {
    console.error('[INBOUND]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ENDPOINT: Crear lead manual desde el frontend ────────────────────────
app.post('/api/leads/manual', auth('admin','vendedor'), async (req, res) => {
  try {
    const tenant = req.tenant || 'demo_automotora';
    const { nombre, phone='Pendiente', canal='WhatsApp', asignado, interes='', nota='', status='Nuevo' } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre obligatorio' });
    const n = new Date().toISOString();
    const leads = await tRead(F.leads, tenant);
    if (phone !== 'Pendiente') {
      const clean2 = phone.replace(/\D/g,'');
      const exists = leads.find(l => l.phone && l.phone.replace(/\D/g,'').includes(clean2));
      if (exists) return res.status(400).json({ error: 'Ya existe un lead con ese telefono.' });
    }
    const initNotes = [];
    if (nota) initNotes.push({ content: nota, author: req.user?.username || 'Manual', ts: Date.now() });
    initNotes.push({ content: 'Lead creado manualmente. Canal: ' + canal, author: 'Sistema', ts: Date.now() });
    const lead = {
      id: Date.now(), name: nombre, phone, source: canal, interest: interes,
      status, botActive: status === 'Nuevo',
      alertLevel: 'none', intentSignal: 'NONE', unread: true,
      assignedTo: asignado || req.user?.username || 'vendedor1',
      lastInteraction: n, lastClientTs: status === 'Nuevo' ? n : new Date().toISOString(), createdAt: n,
      notes: initNotes, chatHistory: [], media: [], pastActions: [], nextAction: { text: '📞 Llamar al cliente (Plantilla WA enviada)', date: new Date(Date.now() + 30 * 60000).toISOString(), createdAt: n, delegateToIA: false, iaCompleted: false },
      waSequence: { step: 1, lastSentAt: n, replied: false } };
    leads.unshift(lead);
    await tWrite(F.leads, tenant, leads);
    const token = (process.env.WA_TOKEN || '').trim(), phoneId = (process.env.WA_PHONE_ID || '').trim();
    if (token && phoneId && phone !== 'Pendiente') {
      try {
        const phoneClean = phone.replace(/\D/g,'');
        const templateName = 'saludo1';
        const waRes = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: phoneClean, type: 'template',
            template: { name: templateName, language: { code: 'es' } }
          })
        });
        const waJson = await waRes.json();
        if (waRes.ok) {
          console.log('[LEAD-MANUAL] Plantilla WA enviada a', phone);
          const leads2 = await tRead(F.leads, tenant);
          const li = leads2.findIndex(l => l.id === lead.id);
          if (li !== -1) {
            leads2[li].chatHistory.push({ role: 'bot', content: '[PLANTILLA WA] Hola ' + nombre + ', te contactamos desde RMG Autos por el ' + (interes||'vehiculo') + '.', ts: Date.now() });
            await tWrite(F.leads, tenant, leads2);
          }
        } else { console.warn('[LEAD-MANUAL] Plantilla no enviada:', JSON.stringify(waJson)); }
      } catch(we) { console.error('[LEAD-MANUAL] WA exc:', we.message); }
    }
    const team = await tRead(F.users, tenant);
    const vend = (team||[]).find(u => u.username === lead.assignedTo);
    alertStaff(tenant, vend, '🔔 Nuevo Lead Manual', '🔔 NUEVO LEAD MANUAL [' + canal + ']: ' + nombre + ' asignado a ti en FunnelOS.');
    console.log('[LEAD-MANUAL] Creado:', nombre, phone, canal, status);
    res.json({ ok: true, leadId: lead.id });
  } catch(e) {
    console.error('[LEAD-MANUAL]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chileautos/webhook', async (req, res) => {
  try {
    res.sendStatus(200);
    const payload = req.body;
    const tenant = 'demo_automotora';
    const prospect = payload.Prospect || payload.prospect || {};
    const vehicle  = payload.Vehicle  || payload.vehicle  || {};
    const firstName = prospect.FirstName || prospect.firstName || '';
    const lastName  = prospect.LastName  || prospect.lastName  || '';
    const name = (firstName + ' ' + lastName).trim() || 'Lead Chileautos';
    const phones = prospect.PhoneNumbers || prospect.phoneNumbers || [];
    let rawPhone = '';
    if (Array.isArray(phones) && phones.length) {
      const mob = phones.find(p => (p.Type||p.type||'').toLowerCase().includes('mobile')) || phones[0];
      rawPhone = mob.Number || mob.number || mob.Value || mob.value || '';
    }
    const clean = rawPhone.replace(/\D/g,'');
    const phone  = clean ? (clean.startsWith('56') ? '+'+clean : '+56'+clean) : 'Pendiente';
    const vehicleTitle = vehicle.Title || vehicle.title || vehicle.Make && (vehicle.Make+' '+vehicle.Model+' '+(vehicle.Year||'')).trim() || 'Vehículo consultado';
    const externalId = payload.LeadId || payload.leadId || payload.Id || null;
    const n = new Date().toISOString();
    const leads = await tRead(F.leads, tenant);
    const phoneClean = phone.replace(/\D/g,'');
    const existing = leads.findIndex(l => {
      if (externalId && l.externalId === externalId) return true;
      if (phone !== 'Pendiente' && l.phone && l.phone.replace(/\D/g,'').includes(phoneClean)) return true;
      return false;
    });
    if (existing !== -1) {
      const existingLead = leads[existing];
      // Si ya está en sala de espera CA, es multicotizante real
      if (existingLead.status === 'esperando_respuesta_chileautos') {
        leads[existing].isMulticotizante = true;
        leads[existing].interest = vehicleTitle;
        leads[existing].history = leads[existing].history || [];
        leads[existing].history.push({ ts: Date.now(), content: '[SISTEMA] Nueva cotización vía Chileautos: ' + vehicleTitle });
        leads[existing].lastInteraction = n;
        await tWrite(F.leads, tenant, leads);
        console.log('[CA-WEBHOOK] Multicotizante en sala espera actualizado:', name, phone);
        return;
      }
      // Si ya tiene conversación activa (no es sala de espera), registrar en historial
      if (existingLead.chatHistory && existingLead.chatHistory.length > 0) {
        leads[existing].isMulticotizante = true;
        leads[existing].interest = vehicleTitle;
        leads[existing].history = leads[existing].history || [];
        leads[existing].history.push({ ts: Date.now(), content: '[SISTEMA] Nueva cotización vía Chileautos: ' + vehicleTitle });
        leads[existing].lastInteraction = n;
        await tWrite(F.leads, tenant, leads);
        console.log('[CA-WEBHOOK] Multicotizante con chat activo:', name, phone);
        return;
      }
      // Lead existe pero sin conversación → moverlo a sala de espera CA
      leads[existing].status = 'esperando_respuesta_chileautos';
      leads[existing].interest = vehicleTitle;
      leads[existing].source = 'Chileautos';
      leads[existing].externalId = externalId;
      leads[existing].isMulticotizante = false;
      leads[existing].botActive = false;
      leads[existing].lastInteraction = n;
      leads[existing].lastClientTs = new Date().toISOString();
      leads[existing].history = [{ ts: Date.now(), content: 'Lead recibido desde Chileautos: ' + vehicleTitle }];
      leads[existing].notes = [{ content: 'Lead recibido desde Chileautos. Vehículo: ' + vehicleTitle, author: 'Bot', ts: Date.now() }];
      leads[existing].chatHistory = [];
      await tWrite(F.leads, tenant, leads);
      console.log('[CA-WEBHOOK] Lead existente movido a sala espera CA:', name, phone);
      // Disparar WA igualmente para este lead
    }
    const assignedObj = await rrNext(tenant) || { username: 'vendedor1' };
    const newLead = {
      id: Date.now(), externalId, name, phone, source: 'Chileautos',
      interest: vehicleTitle, status: 'esperando_respuesta_chileautos',
      botActive: false, isMulticotizante: false, alertLevel: 'none',
      intentSignal: 'NONE', unread: true, assignedTo: assignedObj.username,
      lastInteraction: n, lastClientTs: n,
      history: [{ ts: Date.now(), content: 'Lead recibido desde Chileautos: ' + vehicleTitle }],
      notes: [{ content: 'Lead recibido desde Chileautos. Vehículo: ' + vehicleTitle, author: 'Bot', ts: Date.now() }],
      chatHistory: [], media: []
    };
    leads.unshift(newLead);
    await tWrite(F.leads, tenant, leads);
    const token = (process.env.WA_TOKEN || '').trim(), phoneId = (process.env.WA_PHONE_ID || '').trim();
    if (token && phoneId && phone !== 'Pendiente') {
      try {
        const templateName = 'saludo1';
        const waRes = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
          method: 'POST',
          headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: phoneClean,
            type: 'template',
            template: { name: templateName, language: { code: 'es' } }
          })
        });
        const waJson = await waRes.json();
        if (waRes.ok) {
          console.log('[CA-WEBHOOK] ✅ Plantilla WA enviada a', phone, '| template:', templateName);
          const leads2 = await tRead(F.leads, tenant);
          const nIdx = leads2.findIndex(l => l.externalId === externalId || (phone !== 'Pendiente' && l.phone && l.phone.replace(/\D/g,'').includes(phoneClean)));
          if (nIdx !== -1) {
            leads2[nIdx].chatHistory = leads2[nIdx].chatHistory || [];
            leads2[nIdx].chatHistory.push({ role: 'bot', content: `[PLANTILLA WA ENVIADA] Hola ${firstName||name}, te contactamos desde RMG Autos sobre el ${vehicleTitle} que consultaste en Chileautos.`, ts: Date.now() });
            await tWrite(F.leads, tenant, leads2);
          }
        } else {
          console.error('[CA-WEBHOOK] WA error:', JSON.stringify(waJson));
        }
      } catch(we) { console.error('[CA-WEBHOOK] WA exc:', we.message); }
    } else if (phone === 'Pendiente') {
      console.log('[CA-WEBHOOK] Sin teléfono — plantilla WA no enviada');
    }
    alertStaff(tenant, assignedObj, '🔔 Nuevo Lead Chileautos', '🔔 NUEVO LEAD CHILEAUTOS: ' + name + ' interesado en ' + vehicleTitle);
    console.log('[CA-WEBHOOK] Lead creado:', name, phone, vehicleTitle);
  } catch(e) {
    console.error('[CA-WEBHOOK]', e.message);
  }
});

app.get('/webhook',(req,res)=>{const vt=process.env.WA_VERIFY_TOKEN||'zara_token_123';if(req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===vt)return res.status(200).send(req.query['hub.challenge']);res.sendStatus(403);});

// --- PROXY DE MEDIA META ---
app.get('/api/media/:mediaId', async (req, res) => {
  try {
    const mediaId = req.params.mediaId;
    if (!mediaId || mediaId === 'undefined') return res.status(400).send('ID invalido');
    const token = (process.env.WA_TOKEN || '').trim();
    if (!token) return res.status(500).send('Error: Sin token WA_TOKEN configurado en el servidor');
    
    const uRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, { 
        headers: { 'Authorization': `Bearer ${token}` } 
    });
    const uData = await uRes.json();
    
    if (!uData.url) {
        console.error('Meta API Error:', uData);
        return res.status(404).send('Error de Meta: ' + JSON.stringify(uData));
    }
    
    const mRes = await fetch(uData.url, { 
        headers: { 'Authorization': `Bearer ${token}` } 
    });
    
    if (!mRes.ok) {
        const errText = await mRes.text();
        return res.status(mRes.status).send('Fallo al descargar archivo de Meta: ' + errText);
    }

    const buffer = await mRes.arrayBuffer();
    const contentType = mRes.headers.get('content-type');
    
    res.setHeader('Content-Type', contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error('Error en Proxy Multimedia:', e);
    res.status(500).send('Error interno en el servidor Node');
  }
});
// --- FIN PROXY ---

function detectSource(text){
  if(!text) return null;
  const t = text.toLowerCase();
  if(t.includes('chileautos')) return 'Chileautos';
  if(t.includes('yapo')) return 'Yapo';
  if(t.includes('mercadolibre')||t.includes('mercado libre')) return 'MercadoLibre';
  if(t.includes('facebook')||t.includes('meta')||t.includes('instagram')) return 'Meta Ads';
  if(t.includes('autocasion')||t.includes('auto casion')) return 'Autocasion';
  if(t.includes('dercocenter')||t.includes('derco')) return 'Derco';
  return null;
}
app.post('/webhook',async(req,res)=>{
  if(!req.body.object)return res.sendStatus(404);res.sendStatus(200);
  try{
    const val=req.body.entry?.[0]?.changes?.[0]?.value;const msg=val?.messages?.[0];if(!msg)return;
    const from=msg.from;
    // Extracción robusta: cubre text, button, interactive (reply/list), template, order y sticker
    let body=
      msg.text?.body                                        // mensaje de texto normal
      || msg.button?.text                                   // clic en botón rápido
      || msg.interactive?.button_reply?.title               // botón interactivo
      || msg.interactive?.list_reply?.title                 // selección de lista
      || (msg.interactive?.nfm_reply?.response_json         // formulario (lead gen)
            ? (() => { try { const d=JSON.parse(msg.interactive.nfm_reply.response_json); return Object.values(d).join(' '); } catch(e){return null;} })()
            : null)
      || (msg.type==='order' ? '[ORDEN RECIBIDA]' : null)   // orden de catálogo
      || (msg.type==='sticker' ? '[STICKER]' : null)        // sticker — no null para no perder el lead
      || null;
    // Si el tipo es template el portal ya envió plantilla — creamos lead de todas formas
    if(req.body.entry?.[0]?.changes?.[0]?.value?.statuses) return res.sendStatus(200);
    if(!body && msg.type==='template') body='[Mensaje de plantilla automática]';
    // Log de tipos desconocidos para debugging
    if(!body && msg.type && !['image','audio','video','document'].includes(msg.type)){
      console.warn('[WH-UNKNOWN-TYPE] Tipo de mensaje no capturado:',msg.type,'from:',from,'payload:',JSON.stringify(msg).slice(0,200));
    }

    // R2: Captura referral de Meta Ads (WhatsApp Business API)
    const referral=msg.referral||null;
    const adTracing=referral?{
      ad_id:referral.headline_id||referral.source_id||referral.ad_id||null,
      headline:referral.headline||null,
      source_url:referral.source_url||null,
      source_type:referral.source_type||null,
      media_type:referral.media_type||null,
    }:null;

    // --- MULTIMEDIA HANDLER V4 ---
    if (msg.type === 'image' || msg.type === 'audio') {
      const contactName = val.contacts?.[0]?.profile?.name || 'WhatsApp Lead';
      const tenant = 'demo_automotora';
      const ld = await read(F.leads);
      if (!ld[tenant]) ld[tenant] = [];
      let idx = ld[tenant].findIndex(l => l.phone && l.phone.replace(/\D/g, '').includes(from.replace(/\D/g, '')));
      
      if (idx === -1) {
        const assignedObj = await rrNext(tenant) || {username: 'vendedor1'};
        const n = new Date().toISOString();
        ld[tenant].unshift({id: Date.now(), name: contactName, phone: '+' + from, source: ((() => {
        const txt = (typeof body === 'string' ? body : '').toLowerCase();
        if(!txt) return 'WhatsApp';
        if(txt.includes('mercadolibre') || txt.includes('mlc-')) return 'Mercado Libre';
        if(txt.includes('chileautos')) return 'Chileautos';
        if(txt.includes('yapo')) return 'Yapo';
        if(txt.includes('facebook') || txt.includes('instagram') || txt.includes('fb.me') || txt.includes('vi tu anuncio') || txt.includes('vi este anuncio')) return 'Meta Ads';
        return 'WhatsApp';
    })()), status: 'Nuevo', lastInteraction: n, lastClientTs: n, interest: msg.type === 'image' ? '[Foto Recibida]' : '[Audio Recibido]', assignedTo: assignedObj.username, botActive: true, alertLevel: 'none', intentSignal: 'NONE', unread: true, notes: [], chatHistory: [], media: []});
        idx = 0;
      }

      if (!ld[tenant][idx].media) ld[tenant][idx].media = [];
      
      if (msg.type === 'image') {
        const mediaId = msg.image.id;
        const caption = msg.image.caption || '';
        ld[tenant][idx].media.push({ type: 'image', url: mediaId, text: caption, ts: Date.now() });

        // Contar fotos de retoma acumuladas
        const photoCount = ld[tenant][idx].media.filter(m => m.type === 'image').length;
        const faltan = Math.max(0, 4 - photoCount);

        let photoBody = caption ? `[FOTO RECIBIDA] ${caption}` : `[FOTO RECIBIDA]`;

        ld[tenant][idx].chatHistory = ld[tenant][idx].chatHistory || [];
        ld[tenant][idx].chatHistory.push({ role: 'user', content: `[FOTO RECIBIDA]${caption ? ' — ' + caption : ''}`, ts: Date.now() });

        if (ld[tenant][idx].botActive !== false) {
          const allUsersIMG = await tRead(F.users, tenant);
          const assignedUserIMG = allUsersIMG.find(u => u.username === ld[tenant][idx].assignedTo) || RMG_VENDORS.find(v => v.username === ld[tenant][idx].assignedTo);
          const assignedNameIMG = ld[tenant][idx].botPersona || assignedUserIMG?.name || 'Cata';
          const pImg = await marcela(tenant, ld[tenant][idx].chatHistory.slice(0, -1), photoBody, ld[tenant][idx].notes, assignedNameIMG, ld[tenant][idx].source);
          if (pImg.reply && pImg.reply.trim()) {
            ld[tenant][idx].chatHistory.push({ role: 'bot', content: pImg.reply, ts: Date.now() });
            await tWrite(F.leads, tenant, ld[tenant]);
            await sendWA(from, pImg.reply);
            console.log('[WH-MEDIA] Foto procesada por bot. Fotos acumuladas:', photoCount);
          } else {
            await tWrite(F.leads, tenant, ld[tenant]);
          }
        } else {
          await tWrite(F.leads, tenant, ld[tenant]);
        }
        return; // evita doble procesamiento en flujo principal
      }

      if (msg.type === 'audio') {
        try {
          const audioId = msg.audio.id;
          const metaUrlRes = await fetch(`https://graph.facebook.com/v19.0/${audioId}`, { headers: { Authorization: `Bearer ${(process.env.WA_TOKEN || '').trim()}` } });
          const metaUrlData = await metaUrlRes.json();
          
          if (metaUrlData.url) {
            const audioRes = await fetch(metaUrlData.url, { headers: { Authorization: `Bearer ${(process.env.WA_TOKEN || '').trim()}` } });
            const arrayBuffer = await audioRes.arrayBuffer();
            const audioBuffer = Buffer.from(arrayBuffer);
            
            const { Readable } = require('stream');
            const readableStream = Readable.from(audioBuffer);
            readableStream.path = 'audio.ogg';
            
            const transcriptionRes = await openai.audio.transcriptions.create({ file: readableStream, model: 'whisper-1' });
            const transcription = transcriptionRes.text || '[Sin transcripción]';
            
            body = `[AUDIO TRANSCRITO]: "${transcription}". Responde al cliente considerando esto.`;
            ld[tenant][idx].chatHistory.push({ role: 'user', content: `[AUDIO RECIBIDO] 🎤 "${transcription}"`, ts: Date.now() });
          } else {
            throw new Error('URL de audio no encontrada');
          }
        } catch (err) {
          console.error('Error Whisper:', err.message);
          body = '[AUDIO RECIBIDO] El cliente envió una nota de voz, dile que en un momento lo escuchas.';
          ld[tenant][idx].chatHistory.push({ role: 'user', content: `[AUDIO RECIBIDO - Transcripción falló]`, ts: Date.now() });
        }
      }
      
      ld[tenant][idx].lastClientTs=new Date().toISOString();
      ld[tenant][idx].unread=true;ld[tenant][idx].lastClientTs=new Date().toISOString();
      await tWrite(F.leads, tenant, ld[tenant]);
      console.log('[WH-MEDIA] Guardado media para',from);
    }
// --- FIN MULTIMEDIA HANDLER V4 ---
    
    // Si body sigue null pero hay referral (clic desde anuncio), creamos lead igual
    if(!body && adTracing) body='[Contacto desde anuncio]';
    if(!body)return;
    if(isShield(body)){await sendWA(from,SHIELD_R);return;}

    // ── CATA APRENDE: comando de entrenamiento vía WhatsApp ──
    if(from.replace(/\D/g,'').includes('56983302067') && body.toLowerCase().startsWith('cata aprende')) {
      const conocimiento = body.replace(/^cata aprende[,:\s]*/i,'').trim();
      if(conocimiento) {
        const botData = await read(F.bot);
        if(!botData.demo_automotora) botData.demo_automotora = {};
        if(!botData.demo_automotora.knowledge) botData.demo_automotora.knowledge = [];
        const entrada = { ts: new Date().toISOString(), content: conocimiento };
        botData.demo_automotora.knowledge.push(entrada);
        await write(F.bot, botData);
        await sendWA(from, '✅ Aprendido. Ya tengo esa info para mis próximas conversaciones.');
      } else {
        await sendWA(from, '⚠️ No entendí qué debo aprender. Usa: *cata aprende, [información]*');
      }
      return;
    }

    // ── CATA OLVIDA: borra todo el knowledge ──
    if(from.replace(/\D/g,'').includes('56983302067') && body.toLowerCase().startsWith('cata olvida todo')) {
      const botData = await read(F.bot);
      if(botData.demo_automotora) botData.demo_automotora.knowledge = [];
      await write(F.bot, botData);
      await sendWA(from, '🗑️ Listo, borré todo lo que había aprendido.');
      return;
    }

    // ── CATA QUÉ SABES: lista el knowledge actual ──
    if(from.replace(/\D/g,'').includes('56983302067') && body.toLowerCase().startsWith('cata qué sabes')) {
      const botData = await read(F.bot);
      const know = botData.demo_automotora?.knowledge || [];
      if(know.length === 0) {
        await sendWA(from, 'No tengo conocimiento adicional guardado aún.');
      } else {
        const lista = know.map((k,i) => `${i+1}. ${k.content}`).join('\n');
        await sendWA(from, `📚 Lo que sé:\n${lista}`);
      }
      return;
    }
    const contactName=val.contacts?.[0]?.profile?.name||'WhatsApp Lead';const tenant='demo_automotora';
    const ld=await read(F.leads);if(!ld[tenant])ld[tenant]=[];
    let idx=ld[tenant].findIndex(l=>l.phone&&l.phone.replace(/\D/g,'').includes(from.replace(/\D/g,'')));
    if(idx===-1){
      const assignedObj=await rrNext(tenant)||{username:'vendedor1'};const n=new Date().toISOString();

      // ── Detectar origen portal (Yapo, MercadoLibre, Chileautos WA directo) ──
      let detectedSource = 'WhatsApp';
      let detectedInterest = body.slice(0, 80);
      let portalNote = null;

      const yapoMatch = body.match(/(?:Me interesa el anuncio\s*"([^"]+)"|hola[^.]*(?:yapo|anuncio)[^.]*?([A-Z][A-Z0-9 ]{5,40}))/i);
      const mlMatch   = body.match(/(?:publicaci[oó]n en Mercado Libre[^:\-]*[:\-]?\s*(.{0,60})|MLC-\d+|mercado libre[^.]*?([A-Z][A-Z0-9 ]{5,40}))/i);
      const caMatch   = body.match(/(?:auto en Chileautos[^:\-]*[:\-]?\s*(.{0,60})|chileautos[^.]*?([A-Z][A-Z0-9 ]{5,40}))/i);
      const metaMatchText = body.match(/anuncio en Meta|vi su anuncio|Mundialera/i);
      const hasReferral = (adTracing && adTracing.source_type === 'ad');
      
      if (hasReferral || metaMatchText) {
        detectedSource = 'Meta Ads';
        const titularAd = hasReferral ? (adTracing.headline || '') : '';
        const adId = hasReferral ? (adTracing.source_id || '') : '';

        if (titularAd.toLowerCase().includes('compra') || titularAd.toLowerCase().includes('vende') || (typeof body === 'string' && body.match(/compra directa|evaluar la venta|quiero vender|tasar|retoma|vender mi auto/i))) {
            detectedSource = 'Compra Directa';
        }
        
        let isMundialera = false;
        let autoClicado = '';
        
        if (titularAd.includes('3008') || titularAd.includes('Peugeot')) {
            autoClicado = 'Peugeot 3008 Hybrid (con TV de regalo 📺)'; isMundialera = true;
        } else if (titularAd.includes('Silverado') || titularAd.includes('Trailboss')) {
            autoClicado = 'Silverado Trailboss (Transferencia Gratis 📄)'; isMundialera = true;
        } else if (titularAd.includes('Landtrek')) {
            autoClicado = 'Landtrek Diésel (Precio Congelado ❄️)'; isMundialera = true;
        } else if (titularAd.includes('Mundialera') || titularAd.includes('TV') || titularAd.includes('Transf') || body.match(/Mundialera/i)) {
            isMundialera = true;
        }

        if (isMundialera) {
             detectedInterest = titularAd || 'Promoción Mundialera';
             if (autoClicado) {
                 portalNote = `Lead desde Meta Ads. Hizo clic en la lámina del: ${autoClicado}. INSTRUCCIÓN CRÍTICA IA: NO preguntes qué auto busca. Dile que viste su interés en el ${autoClicado} por la Promo Mundialera, confirma stock y ofrece beneficio. Mensaje del cliente: "${body.slice(0, 100)}"`;
             } else {
                 portalNote = `Lead desde Meta Ads. Promo Mundialera. INSTRUCCIÓN IA: Ofrece los 3 modelos de la promo (3008, Silverado, Landtrek). Mensaje del cliente: "${body.slice(0, 100)}"`;
             }
        } else {
             detectedInterest = titularAd || 'Anuncio Meta Ads';
             portalNote = `Lead Meta Ads (ID: ${adId}) — Lámina clicada: [${detectedInterest}]. Mensaje inicial: "${body.slice(0, 100)}"`;
        }
      } else if (yapoMatch) {
        detectedSource   = 'Yapo';
        detectedInterest = (yapoMatch[1] || yapoMatch[2] || '').trim() || body.slice(0, 80);
        portalNote = `Lead ingresó desde Yapo. Vehículo consultado: ${detectedInterest}`;
      } else if (mlMatch) {
        detectedSource   = 'MercadoLibre';
        detectedInterest = (mlMatch[1] || mlMatch[2] || '').trim() || body.slice(0, 80);
        portalNote = `Lead ingresó desde MercadoLibre. Interés: ${detectedInterest}`;
      } else if (caMatch) {
        detectedSource   = 'Chileautos';
        detectedInterest = (caMatch[1] || caMatch[2] || '').trim() || body.slice(0, 80);
        portalNote = `Lead ingresó desde Chileautos vía WA directo. Interés: ${detectedInterest}`;
      }

      const initNotes = portalNote
        ? [{ content: portalNote, author: 'Sistema', ts: Date.now() }]
        : [];

      ld[tenant].unshift({
        id: Date.now(), name: contactName, phone: '+'+from,
        source: detectedSource, status: 'Nuevo',
        lastInteraction: n, lastClientTs: n,
        interest: detectedInterest,
        assignedTo: assignedObj.username, botActive: true,
        alertLevel: 'none', intentSignal: 'NONE', unread: true,
        notes: initNotes, chatHistory: [],
        adTracing: adTracing
      });
      idx = 0;
      const srcTag = detectedSource !== 'WhatsApp' ? ` [${detectedSource}]` : '';
      alertStaff(tenant, assignedObj, '🔔 Nuevo Lead WA', `🔔 NUEVO LEAD WA${srcTag}: ${contactName} — "${detectedInterest.slice(0,60)}" — atiéndelo ahora.`);
    }
    if(ld[tenant][idx].status==='esperando_respuesta_chileautos'||ld[tenant][idx].status==='esperando_respuesta_general'){
      const prevSrc = ld[tenant][idx].status==='esperando_respuesta_chileautos' ? 'Chileautos' : (ld[tenant][idx].source||'Canal');
      ld[tenant][idx].status='Nuevo';
      ld[tenant][idx].botActive=true;
      ld[tenant][idx].unread=true;
      const _nowActivated=new Date().toISOString();
      ld[tenant][idx].lastClientTs=_nowActivated;
      ld[tenant][idx].lastInteraction=_nowActivated;
      ld[tenant][idx].alertLevel='none';
      ld[tenant][idx].notes=(ld[tenant][idx].notes||[]).concat({content:'✅ Cliente respondió. Activado en embudo desde sala de espera ('+prevSrc+').',author:'Sistema',ts:Date.now()});
      const _au=await tRead(F.users,tenant);
      const _av=_au.find(u=>u.username===ld[tenant][idx].assignedTo)||RMG_VENDORS.find(v=>v.username===ld[tenant][idx].assignedTo);
      alertStaff(tenant, _av, '🔔 Lead respondió', '🔔 '+prevSrc+': '+ld[tenant][idx].name+' respondió! Ya está en tu embudo.');
    }
    
    const mt_yapo = (body || '').match(/(?:Me interesa el anuncio\s*"([^"]+)"|hola[^.]*(?:yapo|anuncio)[^.]*?([A-Z][A-Z0-9 ]{5,40}))/i);
    const mt_ml   = (body || '').match(/(?:publicaci[oó]n en Mercado Libre[^:\-]*[:\-]?\s*(.{0,60})|MLC-\d+|mercado libre[^.]*?([A-Z][A-Z0-9 ]{5,40}))/i);
    const mt_meta = (adTracing && adTracing.source_type === 'ad') || (body || '').match(/anuncio en Meta|vi su anuncio|Mundialera|Promo/i);
    
    let newSource = null;
    let newInterest = null;

    if (mt_meta) {
        newSource = (adTracing && adTracing.headline && (adTracing.headline.toLowerCase().includes('compra') || adTracing.headline.toLowerCase().includes('vende'))) ? 'Compra Directa' : 'Meta Ads';
        newInterest = (adTracing && adTracing.headline) ? adTracing.headline : 'Anuncio Meta Ads';
        if (newInterest.includes('3008') || newInterest.includes('Peugeot')) newInterest = 'Peugeot 3008 Hybrid (con TV de regalo 📺)';
        else if (newInterest.includes('Silverado') || newInterest.includes('Trailboss')) newInterest = 'Silverado Trailboss (Transferencia Gratis 📄)';
        else if (newInterest.includes('Landtrek')) newInterest = 'Landtrek Diésel (Precio Congelado ❄️)';
    } else if (mt_yapo) {
        newSource = 'Yapo';
        newInterest = (mt_yapo[1] || mt_yapo[2] || 'Anuncio en Yapo').trim();
    } else if (mt_ml) {
        newSource = 'MercadoLibre';
        newInterest = (mt_ml[1] || mt_ml[2] || 'Anuncio en MercadoLibre').trim();
    }

    if (newSource && ld[tenant][idx].source !== newSource) {
        const oldSource = ld[tenant][idx].source || 'Desconocido';
        ld[tenant][idx].source = newSource;
        ld[tenant][idx].interest = newInterest;
        ld[tenant][idx].status = 'Nuevo';
        ld[tenant][idx].history = ld[tenant][idx].history || [];
        ld[tenant][idx].history.push({
            ts: Date.now(),
            content: `♻️ [Reingreso Multicanal] El cliente volvió a contactar. Origen anterior: ${oldSource}. Nuevo origen: ${newSource}. Interés: ${newInterest}`
        });
        ld[tenant][idx].notes = ld[tenant][idx].notes || [];
        ld[tenant][idx].notes.push({
            content: `♻️ Reingreso detectado desde ${newSource}. Interés actualizado a: ${newInterest}`,
            author: 'Sistema',
            ts: Date.now()
        });
        const _au = await tRead(F.users, tenant);
        const _av = _au.find(u => u.username === ld[tenant][idx].assignedTo) || RMG_VENDORS.find(v => v.username === ld[tenant][idx].assignedTo);
        if (_av && _av.phone) {
            alertStaff(tenant, _av, '🔔 Reingreso', `🔔 REINGRESO MULTICANAL: ${ld[tenant][idx].name} volvió a cotizar. Nuevo origen: ${newSource} (${newInterest}). Revisa el CRM.`);
        }
    }
    if(adTracing) ld[tenant][idx].adTracing = adTracing;
    
    ld[tenant][idx].chatHistory=ld[tenant][idx].chatHistory||[];ld[tenant][idx].chatHistory.push({role:'user',content:body,ts:Date.now()});
    ld[tenant][idx].unread=true;ld[tenant][idx].lastClientTs=new Date().toISOString();
    if(ld[tenant][idx].botActive!==false){
      if(body.trim().toLowerCase()==='/reset'){ld[tenant].splice(idx,1);await tWrite(F.leads,tenant,ld[tenant]);console.log('[RESET] Lead eliminado para',from,'— listo para nuevo ingreso');return;}

      // ── DEBOUNCE 5s ──
      if(msg?.id && processedMsgIds.has(msg.id)){console.log('[WH-DUP] Duplicado ignorado:',msg.id);return;}
      if(msg?.id){processedMsgIds.add(msg.id);setTimeout(()=>processedMsgIds.delete(msg.id),60000);}
      if(botDebounce.has(from)) clearTimeout(botDebounce.get(from).timer);
      const acc = botDebounce.get(from) || { messages: [] };
      acc.timer = setTimeout(async () => {
        botDebounce.delete(from);
        try {
          const _tok=(process.env.WA_TOKEN||'').trim(), _pid=(process.env.WA_PHONE_ID||'').trim();
          if(_tok&&_pid) fetch(`https://graph.facebook.com/v19.0/${_pid}/messages`,{method:'POST',headers:{Authorization:'Bearer '+_tok,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',status:'read',message_id:msg.id})}).catch(()=>{});
          const ldF=await read(F.leads); if(!ldF[tenant]) return;
          const idxF=ldF[tenant].findIndex(l=>l.phone&&l.phone.replace(/\D/g,'').includes(from.replace(/\D/g,'')));
          if(idxF===-1) return;
          const allUsersWH=await tRead(F.users,tenant);
          const assignedUserWH=allUsersWH.find(u=>u.username===ldF[tenant][idxF].assignedTo)||RMG_VENDORS.find(v=>v.username===ldF[tenant][idxF].assignedTo);
          const assignedNameWH=ldF[tenant][idxF].botPersona||assignedUserWH?.name||'Cata';
          const fullHistory = ldF[tenant][idxF].chatHistory;
          const lastUserMsg = fullHistory.filter(m=>m.role==='user').slice(-1)[0]?.content || body;
          const p=await marcela(tenant,fullHistory.slice(0,-1),lastUserMsg,ldF[tenant][idxF].notes,assignedNameWH,ldF[tenant][idxF].source);
          applySignal(ldF[tenant][idxF],p);
          if(p.schedule_detected&&p.schedule_text){ldF[tenant][idxF].notes=(ldF[tenant][idxF].notes||[]);ldF[tenant][idxF].notes.push({content:'🚨 CITA AGENDADA POR IA: '+p.schedule_text,author:'Sistema',ts:Date.now()});ldF[tenant][idxF].intentSignal='BLUE';ldF[tenant][idxF].nextAction={text:'📞 Llamar al cliente: '+p.schedule_text,date:new Date(Date.now()+60000).toISOString(),createdAt:new Date().toISOString(),delegateToIA:false,iaCompleted:false};}
          let _isEnd=false;
          if(!p.reply||p.reply.trim()===''){ldF[tenant][idxF].notes=(ldF[tenant][idxF].notes||[]);ldF[tenant][idxF].notes.push({content:'🤫 IA detectó fin de conversación.',author:'Sistema',ts:Date.now()});_isEnd=true;}
          else{ldF[tenant][idxF].chatHistory.push({role:'bot',content:p.reply,ts:Date.now()});if(p.reply.indexOf('rmgautos.cl')!==-1&&!(ldF[tenant][idxF].nextAction&&!ldF[tenant][idxF].nextAction.iaCompleted)){ldF[tenant][idxF].nextAction={text:'¿Pudiste ver la ficha en el enlace? Fíjate en los detalles del equipamiento 👀 ¿Qué te pareció?',date:new Date(Date.now()+3*60000).toISOString(),createdAt:new Date().toISOString(),delegateToIA:true,iaCompleted:false};}}
          if(esKeywordCalif(body)&&!ldF[tenant][idxF].keywordAlertSent){ldF[tenant][idxF].keywordAlertSent=true;ldF[tenant][idxF].intentSignal='BLUE';ldF[tenant][idxF].notes=(ldF[tenant][idxF].notes||[]);try{const hSW=ldF[tenant][idxF].chatHistory.slice(-10).map(m=>(m.role==='user'?'Cliente':'Asesor')+': '+m.content).join('\n');const rCW=await openai.chat.completions.create({model:'gpt-4o-mini',temperature:0.4,max_tokens:200,messages:[{role:'system',content:'Briefing 3 líneas: (1) nombre y auto. (2) lo que dijo. (3) acción para el vendedor.'},{role:'user',content:'NOMBRE: '+ldF[tenant][idxF].name+'\nHISTORIAL:\n'+hSW}]});const rIAWH=(rCW.choices?.[0]?.message?.content||'').trim()||'Interés detectado.';ldF[tenant][idxF].ai_summary=rIAWH;alertStaff(tenant,assignedUserWH,'✅ Lead Asignado','✅ Lead: '+ldF[tenant][idxF].name+'. Resumen: '+rIAWH+' — Entra al CRM.');}catch(eW){ldF[tenant][idxF].notes.push({content:'🧠 IA falló: '+eW.message,author:'Sistema',ts:Date.now()});alertStaff(tenant,assignedUserWH,'✅ Lead Asignado','✅ Lead: '+ldF[tenant][idxF].name+'. Revisa bitácora.');}}
          if(!_isEnd) await sendWA(from,p.reply);
          ldF[tenant][idxF].lastInteraction=new Date().toISOString();ldF[tenant][idxF].alertLevel=calcAlert(ldF[tenant][idxF]);
          await write(F.leads,ldF);
          try{await notifyTenantPush(tenant,ldF[tenant]||[]);}catch(_){}
        }catch(eDeb){console.error('[DEBOUNCE-ERR]',eDeb.message);}
      },5000);
      botDebounce.set(from,acc);
      ld[tenant][idx].lastInteraction=new Date().toISOString();ld[tenant][idx].alertLevel=calcAlert(ld[tenant][idx]);
      await write(F.leads,ld); return;
    }
    // Bot pausado — solo guardar
    ld[tenant][idx].lastInteraction=new Date().toISOString();ld[tenant][idx].alertLevel=calcAlert(ld[tenant][idx]);
    await write(F.leads,ld);try{await notifyTenantPush(tenant,ld[tenant]||[]);}catch(_){}
  }catch(e){console.error('Webhook:',e);}
});

// ── NUEVO: endpoint para actualizar inventario desde el navegador ──
app.post('/api/inventory/push', async (req, res) => {
  if(req.headers['x-push-key'] !== (process.env.PUSH_KEY||'rmg2025push')) return res.status(401).json({error:'key invalida'});
  try {
    const items = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Array vacio' });
    const pSign = String.fromCharCode(36);
    const dataStr = items.map(i =>
      '- ' + i.model + (i.year ? ' ' + i.year : '') + (i.km ? ' | ' + i.km : '') +
      ' | ' + pSign + (i.price ? parseInt(i.price).toLocaleString('es-CL') : 'consultar') +
      (i.link ? ' | ' + i.link : '')
    ).join('\n');
    scrapeCache = { ts: Date.now(), data: dataStr, items };
    await tWrite(F.inventory, req.tenant, items);
    console.log('[INV-PUSH] ' + items.length + ' autos actualizados por admin');
    res.json({ ok: true, count: items.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inventory/scraper',auth('admin','vendedor'),async(req,res)=>{
  let dbInv = await tRead(F.inventory,req.tenant);
  if(!Array.isArray(dbInv)) dbInv = [];
  const webItems = (scrapeCache.items && scrapeCache.items.length) ? scrapeCache.items : [];
  const finalInv = webItems.length > 0 ? webItems : dbInv;
  if (webItems.length > 0) {
    try { await tWrite(F.inventory, req.tenant, webItems); } catch(e) { console.error('[INV-SYNC]', e.message); }
  }
  res.json({ts:scrapeCache.ts, raw:scrapeCache.data||'', structured: finalInv});
});
setInterval(async()=>{
  for(const t of TENANTS){
    try{
      const leads=await tRead(F.leads,t);let changed=false;
      for(const lead of leads){
        if(FINAL_ST.has(lead.status))continue;
        const na=lead.nextAction;
                continue; // IA PROACTIVA ELIMINADA DE RAIZ
        if(!na||!na.date||!na.text||na.iaCompleted===true)continue;
        if(new Date(na.date)>new Date())continue;
        try{
          const histSnip=(lead.chatHistory||[]).slice(-10).map(m=>(m.role==='user'?'Cliente':m.role==='agent'?'Vendedor':'IA')+': '+m.content).join('\n');
          const comp=await openai.chat.completions.create({model:'gpt-4o-mini',temperature:0.6,max_tokens:160,messages:[{role:'user',content:'Eres Cata, asesora de RMG Autos. Redacta mensaje breve de seguimiento en español chileno (max 2 oraciones). Instrucción: "'+na.text+'". Historial:\n'+histSnip+'\n\nREGLA CRÍTICA: TIENES ESTRICTAMENTE PROHIBIDO INVENTAR PRECIOS, TASAR VEHÍCULOS O NEGOCIAR VALORES DE RETOMA. Jamás des una oferta de dinero por un auto en parte de pago. Limítate al seguimiento sin involucrar montos.'}]});
          const iaMsg=(comp.choices?.[0]?.message?.content||'').trim();
          if(!iaMsg)continue;
          const phone=(lead.phone||'').replace(/\D/g,'');
          if(phone)await sendWA(phone,iaMsg).catch(()=>{});
          lead.chatHistory=lead.chatHistory||[];
          lead.chatHistory.push({role:'ia_proactiva',content:iaMsg,ts:Date.now(),agentName:'IA Proactiva'});
          na.iaCompleted=true;na.iaCompletedAt=new Date().toISOString();
          lead.lastInteraction=new Date().toISOString();changed=true;
          console.log('[IA-Proactiva] Enviado a '+lead.name);
        }catch(eP){console.error('[IA-Proactiva]',lead.name,eP.message);}
      }
      if(changed)await tWrite(F.leads,t,leads);
    }catch(eT){console.error('[IA-Proactiva-cron]',eT.message);}
  }
},60000);

// ════════════════════════════════════════════════════════════════════════════
// CRON Sprint 3 — Alertas SLA Riesgo (20m) + Retargeting Post-Link (2m)
// Corre cada 30 segundos. Cada lead lleva flags para evitar repeticion.
// ════════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  for (const t of TENANTS) {
    try {
      const leads = await tRead(F.leads, t);
      const users = await tRead(F.users, t);
      let changed = false;

      for (const lead of leads) {
        if (FINAL_ST.has(lead.status)) continue;

        // ─── TAREA 1: Alerta SLA riesgo a los 20 min sin atencion ──────────
        if (lead.status === 'Nuevo' && !lead.reassigned && !lead.riskAlertSent) {
          const ref = lead.lastClientTs || lead.lastInteraction;
          if (ref) {
            const minsSinAtencion = (Date.now() - new Date(ref).getTime()) / 60000;
            if (minsSinAtencion >= 20 && minsSinAtencion < 30) {
              const assigned = users.find(u => u.username === lead.assignedTo)
                            || RMG_VENDORS.find(v => v.username === lead.assignedTo);
              if (assigned && assigned.phone) {
                const msg = '🚨 ALERTA: El lead [' + lead.name + '] lleva 20 min sin atención. '
                          + 'Te quedan 10 min antes de que el sistema lo reasigne.';
                sendWA(assigned.phone, msg).catch(() => {});
                console.log('[SLA-Risk] Alerta 20m enviada a', assigned.username, 'por lead', lead.name);
              }
              lead.riskAlertSent = true;
              changed = true;
            }
          }
        }

        /* ─── TAREA 2: ANULADA ─── 
 Choque de trenes resuelto. IA Proactiva maneja el retargeting ahora. 
*/
      }

      if (changed) await tWrite(F.leads, t, leads);
    } catch (e) {
      console.error('[Sprint3-Cron]', t, e.message);
    }
  }
}, 30000);


app.post('/api/leads/bulk-delete',auth('admin'),async(req,res)=>{const ids=req.body.ids||[];if(!ids.length)return res.status(400).json({error:'vacio'});let leads=await tRead(F.leads,req.tenant);const before=leads.length;leads=leads.filter(l=>!ids.includes(l.id));await tWrite(F.leads,req.tenant,leads);res.json({ok:true,deleted:before-leads.length});});

app.delete('/api/leads/wipe',auth('admin'),async(req,res)=>{
  const leads=await read(F.leads);
  const tenant=req.tenant||'demo_automotora';
  const prev=(leads[tenant]||[]).length;
  leads[tenant]=[];
  if(req.query.all==='true'){
    for(const t of TENANTS){leads[t]=[];}
  }
  await write(F.leads,leads);
  console.log('[WIPE] Leads eliminados:',prev,'tenant:',tenant);
  res.json({ok:true,deleted:prev,tenant});
});


app.put('/api/config/password',auth('admin'),async(req,res)=>{
  const{newPassword}=req.body||{};
  if(!newPassword||newPassword.length<3)return res.status(400).json({error:'Clave muy corta'});
  const users=await tRead(F.users,req.tenant);
  users.forEach(u=>{u.password=newPassword;});
  await tWrite(F.users,req.tenant,users);
  console.log('[CONFIG] Clave actualizada para tenant:',req.tenant);
  res.json({ok:true,updated:users.length});
});

app.use(express.static(path.join(__dirname,'public')));
app.get('/tmp-media/:name', (req, res) => {
  const fp = require('path').join('/tmp', req.params.name);
  if (!fsSync.existsSync(fp)) return res.status(404).send('Not found');
  const ext = fp.split('.').pop().toLowerCase();
  const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', mp4:'video/mp4', mov:'video/quicktime', pdf:'application/pdf', doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const mime = mimeMap[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.sendFile(fp);
});
app.get('/api/push/vapid-public-key',(req,res)=>{
  const key=process.env.VAPID_PUBLIC_KEY;
  if(!key)return res.status(503).json({error:'VAPID no configurado'});
  res.json({publicKey:key});
});


// ═══════════════════════════════════════════════════
// AGENTE PRECIOS MERCADO — scraper Chileautos + Yapo
// ═══════════════════════════════════════════════════
let precioCache={ts:0,data:{}};
const PRECIO_TTL=6*60*60*1000;

async function scrapePreciosMercado(modelos){
  const now=Date.now();
  if(Object.keys(precioCache.data).length&&(now-precioCache.ts)<PRECIO_TTL)return precioCache.data;
  const res2={};
  for(const m of modelos){
    try{
      const q=encodeURIComponent(m.query);
      const r1=await fetch('https://www.chileautos.cl/vehiculos/?q='+q+'&sort=precio_asc',{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0'}});
      if(r1.ok){const h=await r1.text();const pp=[];const re=/[$]\s?([\d.]+)/g;let x;while((x=re.exec(h))!==null){const v=parseInt(x[1].replace(/\./g,''),10);if(v>=2000000&&v<=80000000)pp.push(v);}if(pp.length){pp.sort((a,b)=>a-b);res2[m.id]=res2[m.id]||{};res2[m.id].chileautos={min:pp[0],max:pp[pp.length-1],median:pp[Math.floor(pp.length/2)],count:pp.length};}}
      await new Promise(r=>setTimeout(r,1100));
      const r2=await fetch('https://www.yapo.cl/chile/autos_y_camionetas?q='+q+'&order=price_asc',{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0'}});
      if(r2.ok){const h=await r2.text();const pp=[];const re=/[$]\s?([\d.]+)/g;let x;while((x=re.exec(h))!==null){const v=parseInt(x[1].replace(/\./g,''),10);if(v>=2000000&&v<=80000000)pp.push(v);}if(pp.length){pp.sort((a,b)=>a-b);res2[m.id]=res2[m.id]||{};res2[m.id].yapo={min:pp[0],max:pp[pp.length-1],median:pp[Math.floor(pp.length/2)],count:pp.length};}}
      await new Promise(r=>setTimeout(r,1100));
    }catch(e){console.warn('[PrecioAgent]',m.id,e.message);}
  }
  precioCache={ts:Date.now(),data:res2};
  console.log('[PrecioAgent] OK:',Object.keys(res2).length,'modelos');
  return res2;
}

app.get('/api/precios/mercado',auth('admin','vendedor'),async(req,res)=>{
  try{
    if(req.query.refresh==='1')precioCache.ts=0;
    await scrapeRMG();
    const inv=(scrapeCache.items&&scrapeCache.items.length)?scrapeCache.items:[];
    const modelos=inv.map(i=>({id:i.id,brand:i.brand,model:i.model,year:i.year,precio_lista:i.precio_lista,precio_credito:i.precio_credito,km:i.km,link:i.link,query:(i.brand+' '+(i.model||'').split(' ').slice(0,2).join(' ')+' '+(i.year||'')).trim()}));
    const precios=await scrapePreciosMercado(modelos);
    const data=modelos.map(m=>{
      const p=precios[m.id]||{};
      const ref=p.chileautos?.median||p.yapo?.median||null;
      const diff=ref?Math.round((m.precio_lista-ref)/ref*100):null;
      return{...m,mercado:p,mercado_ref:ref,diff_pct:diff,posicion:diff===null?'sin datos':diff<-5?'bajo mercado':diff>5?'sobre mercado':'en mercado',ts:new Date(precioCache.ts||Date.now()).toISOString()};
    });
    res.json({ok:true,count:data.length,data,cache_ts:precioCache.ts});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/precios/inventario',auth('admin','vendedor'),async(req,res)=>{
  try{await scrapeRMG();const inv=(scrapeCache.items&&scrapeCache.items.length)?scrapeCache.items:[];res.json({ok:true,count:inv.length,data:inv,ts:scrapeCache.ts});}
  catch(e){res.status(500).json({error:e.message});}
});

// ── ANÁLISIS IA DE LEADS ────────────────────────────────────────
app.post('/api/leads/analisis-ia', auth('admin','vendedor'), async (req, res) => {
  try {
    const { leadIds, filtros } = req.body || {};
    const allLeads = await tRead(F.leads, req.tenant);
    const allUsers = await tRead(F.users, req.tenant);
    let leads = allLeads;
    if (leadIds && leadIds.length) {
      leads = allLeads.filter(l => leadIds.includes(String(l.id)));
    } else if (filtros) {
      if (filtros.source) leads = leads.filter(l => l.source === filtros.source);
      if (filtros.status) leads = leads.filter(l => l.status === filtros.status);
      if (filtros.assignedTo) leads = leads.filter(l => l.assignedTo === filtros.assignedTo);
      if (filtros.desde) leads = leads.filter(l => new Date(l.lastInteraction||l.createdAt||0) >= new Date(filtros.desde));
      if (filtros.hasta) leads = leads.filter(l => new Date(l.lastInteraction||l.createdAt||0) <= new Date(filtros.hasta));
    }
    if (!leads.length) return res.status(400).json({ error: 'No hay leads con esos criterios' });
    const contexto = leads.map(l => {
      const vendedor = allUsers.find(u => u.username === l.assignedTo)?.name || l.assignedTo || 'Sin asignar';
      const diasSinResp = l.lastClientTs ? Math.floor((Date.now() - new Date(l.lastClientTs).getTime()) / 86400000) : '?';
      const diasEnCRM = l.createdAt ? Math.floor((Date.now() - new Date(l.createdAt).getTime()) / 86400000) : '?';
      const chat = (l.chatHistory || []).slice(-5).map(m => `[${m.role==='user'?'Cliente':'Asesor'}]: ${(m.content||'').slice(0,120)}`).join('\n');
      const notas = (l.notes || []).slice(-3).map(n => `${n.author||'?'}: ${(n.content||'').slice(0,100)}`).join(' | ');
      const agenda = l.nextAction?.text ? `Agenda: ${l.nextAction.text} (${l.nextAction.date||'sin fecha'})` : '';
      const creado = l.createdAt ? new Date(l.createdAt).toLocaleDateString('es-CL') : '?';
      const ultimaAct = l.lastClientTs ? new Date(l.lastClientTs).toLocaleDateString('es-CL') : '?';
      return `---\nLEAD: ${l.name} | TEL: ${l.phone} | ORIGEN: ${l.source} | ESTADO: ${l.status}\nVENDEDOR: ${vendedor} | CREADO: ${creado} | ULTIMA ACT: ${ultimaAct} | DIAS SIN RESP: ${diasSinResp}d | DIAS EN CRM: ${diasEnCRM}d\nINTERES: ${(l.interest||'No especificado').slice(0,100)}${agenda?'\n'+agenda:''}\nNOTAS: ${notas||'Sin notas'}\nCHAT:\n${chat||'Sin historial'}`;
    }).join('\n\n');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('data: ' + JSON.stringify({type:'start', total: leads.length}) + '\n\n');
    const esProfundo = (req.body || {}).profundo === true;
    const promptRapido = 'Eres un analista comercial senior de una automotora chilena. Analiza estos ' + leads.length + ' leads del CRM.\n\nPara cada lead entrega:\n**Nombre** | Estado | Origen | Vendedor | Dias sin respuesta\n- Diagnostico: que esta pasando con este lead especificamente\n- Estancamiento: por que no avanza (basate en el chat y notas reales)\n- Accion HOY: que hacer hoy, especifico con nombre del cliente y auto\n- Urgencia: Alta / Media / Baja\n\nFinal del reporte: resumen por vendedor con sus leads y top 5 prioridades del dia.\n\n' + contexto + '\n\nEspanol. Se especifico con los nombres reales, autos mencionados y conversaciones. No uses frases genericas.';
    const promptProfundo = 'Eres un analista comercial senior de una automotora chilena. Realiza un ANALISIS PROFUNDO Y COMPLETO del embudo de ventas con estos ' + leads.length + ' leads.\n\nESTRUCTURA DEL REPORTE:\n\n## 1. RESUMEN EJECUTIVO\nMetricas clave: total leads, tasa conversion por estado, tiempo promedio en CRM, canales mas efectivos.\n\n## 2. DIAGNOSTICO POR VENDEDOR\nPara cada vendedor: leads asignados, distribucion por estado, dias promedio sin respuesta, oportunidades calientes y leads abandonados.\n\n## 3. ANALISIS POR CANAL\nRendimiento de cada origen (WhatsApp, MercadoLibre, Chileautos, Meta Ads, etc): volumen, conversion, calidad de leads.\n\n## 4. LEADS CRITICOS (top 10 prioridad)\nLos leads que requieren accion URGENTE HOY con nombre, telefono, vendedor asignado y accion especifica.\n\n## 5. LEADS EN RIESGO DE PERDIDA\nLeads con mas de 5 dias sin actividad que aun estan en estados activos. Accion de rescate sugerida.\n\n## 6. RECOMENDACIONES ESTRATEGICAS\n5 acciones concretas para mejorar el embudo esta semana.\n\n' + contexto + '\n\nEspanol. Usa los nombres reales de clientes, autos y vendedores. Se especifico y accionable.';
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini', temperature: 0.3, max_tokens: 8000, stream: true,
      messages: [{ role: 'user', content: esProfundo ? promptProfundo : promptRapido }]
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) res.write('data: ' + JSON.stringify({type:'delta', text: delta}) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({type:'done', total: leads.length}) + '\n\n');
    res.end();
  } catch(e) {
    console.error('[ANALISIS-IA]', e.message);
    try { res.write('data: ' + JSON.stringify({type:'error', error: e.message}) + '\n\n'); res.end(); } catch(_) {}
  }
});

// ─── BACKUPS: listar y descargar ─────────────────────────────────────────────
app.get('/api/backups/list', auth('admin'), async (req, res) => {
  try {
    const dir = require('path').join(DATA, 'backups');
    if (!fsSync.existsSync(dir)) return res.json({ backups: [] });
    const files = fsSync.readdirSync(dir)
      .filter(f => f.endsWith('.tar.gz'))
      .map(f => {
        const st = fsSync.statSync(require('path').join(dir, f));
        return { name: f, size: st.size, mtime: st.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ backups: files });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backups/download/:filename', auth('admin'), (req, res) => {
  try {
    const dir = require('path').join(DATA, 'backups');
    const file = require('path').join(dir, req.params.filename);
    if (!fsSync.existsSync(file)) return res.status(404).json({ error: 'No encontrado' });
    res.download(file, req.params.filename);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
setInterval(async()=>{for(const t of TENANTS){try{await applySlaRules(t);}catch(e){console.error('SLA',t,e.message);}}},60000);

// ── SPRINT 4: Tasación Request ──────────────────────────────────────────────
app.post('/api/tasacion/request', auth('admin','vendedor'), async (req, res) => {
  try {
    const tenant = req.tenant;
    const { leadId } = req.body;
    const leads = await tRead(F.leads, tenant, []);
    const lead = leads.find(l => l.id == leadId);
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

    const ti = lead.tradeIn || {};
    const texto = `📋 SOLICITUD DE TASACIÓN\n👤 Cliente: ${lead.name}\n📱 Tel: ${lead.phone||'?'}\n\n🚗 Vehículo en retoma:\n• Marca/Modelo: ${ti.make||'?'} ${ti.model||'?'}\n• Año: ${ti.year||'?'}\n• Patente: ${ti.plate||'?'}\n• Color: ${ti.color||'?'}\n• Km: ${ti.km||'?'}\n• Versión: ${ti.version||'?'}\n\nPor favor evaluar y registrar la oferta en el CRM.`;

    const users = await tRead(F.users, tenant, []);
    const admins = users.filter(u => u.role === 'admin' && u.status === 'Activo');
    let notifiedCount = 0;
    for (const admin of admins) {
      if (admin.phone) {
        const ti7 = lead.tradeIn || {};
        await sendWATemplate(admin.phone, 'alerta_tasacion', [
          lead.name || 'S/N',
          String(lead.phone || '').replace(/\D/g, ''),
          ti7.make || '?',
          ti7.model || '?',
          ti7.color || '?',
          ti7.plate || '?'
        ]).catch(()=>{});
        notifiedCount++;
      }
    }
    res.json({ ok: true, notified: notifiedCount });
  } catch (err) {
    console.error('/api/tasacion/request error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── SPRINT 4: Tasación Offer ─────────────────────────────────────────────────
app.post('/api/tasacion/offer', auth('admin'), async (req, res) => {
  try {
    const tenant = req.tenant;
    const { leadId, offerAmount } = req.body;
    const leads = await tRead(F.leads, tenant, []);
    const lead = leads.find(l => String(l.id) == String(leadId));
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

    if (!lead.tradeIn) lead.tradeIn = { make:'', model:'', year:'', color:'', status:'Pendiente', offer:0 };
    lead.tradeIn.offer = Number(offerAmount);
    lead.tradeIn.status = 'Evaluado';

    await tWrite(F.leads, tenant, leads);

    const fmt = new Intl.NumberFormat('es-CL', { style:'currency', currency:'CLP', maximumFractionDigits:0 }).format(lead.tradeIn.offer);
    if (lead.assignedTo) {
      const users = await tRead(F.users, tenant, []);
      const vendedor = users.find(u => u.username === lead.assignedTo) || RMG_VENDORS.find(v => v.username === lead.assignedTo);
      if (vendedor && vendedor.phone) {
        const msg = `✅ TASACIÓN LISTA\nLead: ${lead.name}\nRetoma: ${lead.tradeIn.make} ${lead.tradeIn.model} ${lead.tradeIn.year}\nOferta taller: ${fmt}\nYa puedes informar al cliente.`;
        await sendWA(vendedor.phone, msg);
      }
    }
    res.json({ ok: true, offer: lead.tradeIn.offer, status: lead.tradeIn.status });
  } catch (err) {
    console.error('/api/tasacion/offer error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── SPRINT 4: PATCH tradeIn fields ──────────────────────────────────────────
app.patch('/api/leads/:id/tradein', auth('admin','vendedor'), async (req, res) => {
  try {
    const tenant = req.tenant;
    const leads = await tRead(F.leads, tenant, []);
    const lead = leads.find(l => String(l.id) === String(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

    if (!lead.tradeIn) lead.tradeIn = { make:'', model:'', year:'', color:'', status:'Pendiente', offer:0 };
    const { make, model, year, color, plate, km, version } = req.body;
    if (make    !== undefined) lead.tradeIn.make    = make;
    if (model   !== undefined) lead.tradeIn.model   = model;
    if (year    !== undefined) lead.tradeIn.year    = year;
    if (color   !== undefined) lead.tradeIn.color   = color;
    if (plate   !== undefined) lead.tradeIn.plate   = plate;
    if (km      !== undefined) lead.tradeIn.km      = km;
    if (version !== undefined) lead.tradeIn.version = version;
    lead.notes = Array.isArray(lead.notes) ? lead.notes : [];
    lead.notes.push({ content: `🚗 Datos retoma: ${make||'?'} ${model||'?'} ${year||'?'} | Patente: ${plate||'?'} | Km: ${km||'?'} | Versión: ${version||'?'} | Color: ${color||'?'}`, author: req.user?.name||'Sistema', ts: Date.now() });
    await tWrite(F.leads, tenant, leads);
    res.json({ ok: true, tradeIn: lead.tradeIn });
  } catch (err) {
    console.error('/api/leads/:id/tradein PATCH error:', err);
    res.status(500).json({ error: err.message });
  }
});




// ── PUSH endpoints ────────────────────────────────────────────────
app.post('/api/push/subscribe',auth(),async(req,res)=>{
  const{subscription}=req.body;
  if(!subscription||!subscription.endpoint)return res.status(400).json({error:'subscription requerida'});
  const key=req.tenant+':'+req.user.username;
  _pushSubs[key]=_pushSubs[key]||[];
  if(!_pushSubs[key].some(s=>s.endpoint===subscription.endpoint)){_pushSubs[key].push(subscription);await _saveSubs();}
  res.json({ok:true});
});
app.post('/api/push/unsubscribe',auth(),async(req,res)=>{
  const{endpoint}=req.body;
  const key=req.tenant+':'+req.user.username;
  if(_pushSubs[key]){_pushSubs[key]=_pushSubs[key].filter(s=>s.endpoint!==endpoint);await _saveSubs();}
  res.json({ok:true});
});
// ── fin PUSH endpoints ────────────────────────────────────────────


app.post('/markAsRead', express.json(), (req, res) => {
    const { id } = req.body;
    const leads = JSON.parse(fsSync.readFileSync(F.leads, 'utf8'));
    let found = false;
    for (let tenant in leads) {
        leads[tenant].forEach(l => {
            if (l.id == id) { l.unread = false; found = true; }
        });
    }
    if (found) fsSync.writeFileSync(F.leads, JSON.stringify(leads, null, 2));
    res.json({ success: true });
});


// ─── ARQUITECTURA OFICIAL DE REGLAS DE NEGOCIO (MAPA JC) ─────────────────

// [PUNTOS 7, 8, 9]: Motor de envío Meta con soporte de variables dinámicas
async function sendWATemplate(phone, templateName, params) {
  const token = (process.env.WA_TOKEN || '').trim(), phoneId = (process.env.WA_PHONE_ID || '').trim();
  if (!token || !phoneId || !phone) return false;
  
  let components = [];
  if (params && params.length > 0) {
      components = [{
          type: 'body',
          parameters: params.map(p => ({ type: 'text', text: String(p || '') }))
      }];
  }
  const pClean = String(phone).replace(/\D/g, '');
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: pClean, type: 'template',
      template: { name: templateName, language: { code: 'es' }, components }
    })
  });
  if(!res.ok) console.error(`[META ERR ${templateName}]:`, await res.text());
  return res.ok;
}

// [PUNTO 9]: Disparo manual por botón verde desde el CRM
app.post('/api/leads/:id/send-template', auth('admin','vendedor'), async (req, res) => {
  try {
    const { templateName, params } = req.body;
    if (!templateName) return res.status(400).json({ error: 'Falta templateName' });
    const leads = await tRead(F.leads, req.tenant);
    const idx = leads.findIndex(x => x.id == req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Lead no encontrado' });
    
    const pClean = String(leads[idx].phone || '').replace(/\D/g, '');
    const ok = await sendWATemplate(pClean, templateName, params || [leads[idx].name || 'Estimado']);
    if (ok) {
        leads[idx].chatHistory.push({ role: 'agent', content: `[META] Plantilla ${templateName} enviada manualmente`, ts: Date.now() });
        await tWrite(F.leads, req.tenant, leads);
        return res.json({ success: true });
    } else {
        return res.status(500).json({ error: 'Rechazo de Meta al disparar plantilla' });
    }
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// [PUNTOS 1 al 8]: Super-Cron Maestro de Lógica Comercial
setInterval(async () => {
  try {
    for (const t of TENANTS) {
      const leads = await tRead(F.leads, t);
      const users = await tRead(F.users, t);
      let changed = false;

      const admins = users.filter(u => u.role === 'admin' && u.phone);
      const avisar = async (fono, txt) => { if(fono) await sendWA(fono, txt).catch(()=>{}); };
      const avisarAdmins = async (txt) => { for(const a of admins) await avisar(a.phone, txt); };

      for (const l of leads) {
        if (!l || FINAL_ST.has(l.status)) continue;
        const fCliente = l.phone ? String(l.phone).replace(/\D/g, '') : null;
        const vend = users.find(u => u.username === l.assignedTo);
        const ref = l.created_at || l.lastClientTs || l.lastInteraction || Date.now();
        const minsSinAtencion = (Date.now() - new Date(ref).getTime()) / 60000;

        // [PUNTO 6]: Alerta Nuevo Lead — plantilla alerta_nuevo_lead
        if (!l.alertaNuevoSent && l.status === 'Nuevo') {
            l.alertaNuevoSent = true; changed = true;
            const p6 = [l.name || 'S/N', l.source || 'Directo', l.interest || 'No especificado'];
            if (vend && vend.phone) await sendWATemplate(vend.phone, 'alerta_nuevo_lead', p6).catch(()=>{});
            for (const a of admins) { if (a.phone) await sendWATemplate(a.phone, 'alerta_nuevo_lead', p6).catch(()=>{}); }
        }

        // [PUNTO 1]: Alerta Tasación (Solo Admins)
        if (!l.alertaTasSent && (l.source === 'Compramos tu auto' || (l.interest && l.interest.toLowerCase().includes('tasar')))) {
            l.alertaTasSent = true; changed = true;
            await avisarAdmins(`🔔 ALERTA TASACIÓN: El usuario [${l.name || 'S/N'}] solicitó tazar su vehículo.`);
        }

        // [PUNTO 2]: Alerta Reserva Vencida (3 días -> Staff + Admin)
        if ((l.status === 'Reserva' || l.status === 'Reservado') && !l.alertaReserva3d) {
            const dias = (Date.now() - new Date(l.reservadoAt || l.lastInteraction).getTime()) / (1000*60*60*24);
            if (dias >= 3) {
                l.alertaReserva3d = true; changed = true;
                const pRV = [l.name || 'S/N'];
                if (vend && vend.phone) await sendWATemplate(vend.phone, 'alerta_reserva_vencida', pRV).catch(()=>{});
                for (const a of admins) { if (a.phone) await sendWATemplate(a.phone, 'alerta_reserva_vencida', pRV).catch(()=>{}); }
            }
        }

        // [PUNTO 4]: Alerta SLA Riesgo (20 min sin atención -> Solo Vendedor)
        if (l.status === 'Nuevo' && !l.alertaSla20 && minsSinAtencion >= 20 && minsSinAtencion < 30) {
            l.alertaSla20 = true; changed = true;
            if (vend && vend.phone) await sendWATemplate(vend.phone, 'alerta_sla_riesgo', [l.name || 'S/N']).catch(()=>{});
        }

        // [PUNTO 5]: Alerta Reasignación (30 min -> Al NUEVO vendedor)
        if (l.status === 'Nuevo' && !l.reasignado30 && minsSinAtencion >= 30) {
            l.reasignado30 = true; changed = true;
            const nextObj = await rrNext(t, l.assignedTo);
            if (nextObj && nextObj.username !== l.assignedTo) {
                l.assignedTo = nextObj.username;
                if (nextObj.phone) await sendWATemplate(nextObj.phone, 'alerta_reasignacion', [l.name || 'S/N', l.interest || 'No especificado']).catch(()=>{});
            }
        }

        // [PUNTO 3]: Alerta Admin Sin (30 min sin atenderse -> Solo Admins)
        if (l.status === 'Nuevo' && !l.alertaAdminSin30 && minsSinAtencion >= 30) {
            l.alertaAdminSin30 = true; changed = true;
            for (const a of admins) { if (a.phone) await sendWATemplate(a.phone, 'alerta_admin_sin_atencion', [l.name || 'S/N']).catch(()=>{}); }
        }

        // [PUNTOS 7 y 8]: Automatización Sala de Espera (Plantillas Meta a Clientes)
        if (fCliente && l.sala_espera === true && !l.replied) {
            // Punto 7: saludo1 al entrar a sala de espera
            if (!l.saludo1_ts) {
                const ok = await sendWATemplate(fCliente, 'saludo1', [l.name || 'Estimado']);
                if (ok) {
                    l.saludo1_ts = Date.now(); changed = true;
                    l.chatHistory.push({ role: 'bot', content: '[META] saludo1 automático enviado', ts: Date.now() });
                }
            }
            // Punto 8: saludo2 a los 20 min de saludo1
            else if (l.saludo1_ts && !l.saludo2_ts && ((Date.now() - l.saludo1_ts)/60000) >= 20) {
                const ok = await sendWATemplate(fCliente, 'saludo2', [l.name || 'Estimado']);
                if (ok) {
                    l.saludo2_ts = Date.now(); changed = true;
                    l.chatHistory.push({ role: 'bot', content: '[META] saludo2 automático enviado', ts: Date.now() });
                }
            }
        }
      }
      if (changed) await tWrite(F.leads, t, leads);
    }
  } catch(e) { console.error('[CRON-MAESTRO-ERR]', e.message); }
}, 20000);
// ─────────────────────────────────────────────────────────────────────────


// ─── OPERACIÓN FORENSE DE RESCATE DE DATA ────────────────────────────────
app.get('/api/rescate', async (req, res) => {
    const fsP = require('fs').promises;
    const path = require('path');
    let reporte = {
        entorno: process.env.RENDER ? 'Nube Render' : 'Local',
        ruta_base_data: DATA,
        existe_data: fsSync.existsSync(DATA),
        archivos_detectados: [],
        backups_detectados: [],
        diagnostico_leads_json: null
    };

    try {
        if (fsSync.existsSync(DATA)) {
            const files = await fsP.readdir(DATA);
            for (const f of files) {
                const full = path.join(DATA, f);
                const st = await fsP.stat(full);
                if (st.isFile()) {
                    reporte.archivos_detectados.push({
                        archivo: f,
                        bytes: st.size,
                        ultima_modificacion: new Date(st.mtimeMs).toISOString()
                    });
                }
            }
        }

        const dirBak = path.join(DATA, 'backups');
        if (fsSync.existsSync(dirBak)) {
            const baks = await fsP.readdir(dirBak);
            for (const b of baks) {
                const st = await fsP.stat(path.join(dirBak, b));
                reporte.backups_detectados.push({
                    backup: b,
                    bytes: st.size,
                    ultima_modificacion: new Date(st.mtimeMs).toISOString()
                });
            }
        }

        const leadsPath = path.join(DATA, 'leads.json');
        if (fsSync.existsSync(leadsPath)) {
            const crudo = await fsP.readFile(leadsPath, 'utf8');
            try {
                const j = JSON.parse(crudo);
                reporte.diagnostico_leads_json = {
                    es_json_valido: true,
                    tenants_internos: Object.keys(j),
                    demo_automotora_leads: Array.isArray(j.demo_automotora) ? j.demo_automotora.length : 'Falta array'
                };
            } catch(e) { reporte.diagnostico_leads_json = 'CORRUPTO (No parsea como JSON)'; }
        } else {
            reporte.diagnostico_leads_json = 'NO EXISTE EL ARCHIVO LEADS.JSON';
        }
    } catch(e) { reporte.error_escaneo = e.message; }

    res.header('Content-Type', 'application/json');
    res.send(JSON.stringify(reporte, null, 2));
});
// ─────────────────────────────────────────────────────────────────────────


// ─── AUTO-CONVERTIDOR UNIVERSAL DE FORMATO DE BÓVEDA ─────────────────────
app.get('/api/curar-bd', async (req, res) => {
    const fsP = require('fs').promises;
    const path = require('path');
    const archivoFisico = path.join(DATA, 'leads.json');

    try {
        if (!fsSync.existsSync(archivoFisico)) {
            return res.status(404).json({ error: 'No se encontró el archivo leads.json en ' + DATA });
        }

        const crudo = await fsP.readFile(archivoFisico, 'utf8');
        let data = JSON.parse(crudo);
        let leadsRecuperados = [];

        // Escenario A: El JSON es un Array plano directo [ {...}, {...} ]
        if (Array.isArray(data)) {
            leadsRecuperados = data;
        } 
        // Escenario B: El JSON es un Object { "llave": [...] }
        else if (data && typeof data === 'object') {
            // Buscamos en todas las llaves internas acumulando cualquier lead vivo
            for (const key of Object.keys(data)) {
                if (Array.isArray(data[key])) {
                    leadsRecuperados = leadsRecuperados.concat(data[key]);
                }
            }
        }

        if (leadsRecuperados.length === 0) {
            return res.json({ error: 'El archivo existe y pesa, pero no se detectaron objetos de leads en su interior.' });
        }

        // Limpiamos duplicados por ID
        let unicos = [];
        let mapa = new Set();
        for (const l of leadsRecuperados) {
            if (l && l.id && !mapa.has(l.id)) {
                mapa.add(l.id);
                unicos.push(l);
            }
        }

        // CURA DEFINITIVA: Empaquetamos todo bajo la llave maestra 'demo_automotora'
        const bóvedaCurada = {
            "demo_automotora": unicos
        };

        const strLimpio = JSON.stringify(bóvedaCurada, null, 2);
        await fsP.writeFile(archivoFisico, strLimpio, 'utf8');
        await fsP.writeFile(path.join(DATA, 'leads_default.json'), strLimpio, 'utf8');

        return res.json({
            exito: true,
            mensaje: '🏆 ¡BASE DE DATOS CURADA Y RE-EMPAQUETADA CON ÉXITO!',
            leads_totales_restaurados: unicos.length,
            formato_implantado: 'demo_automotora'
        });
    } catch(e) {
        return res.status(500).json({ error: 'Error curando la base de datos: ' + e.message });
    }
});
// ─────────────────────────────────────────────────────────────────────────



// ─── VOLCADO NATIVO DE BÓVEDA (EXCLUSIVO GERENCIA / ADMIN) ───────────────

// ─────────────────────────────────────────────────────────────────────────


// ─── VOLCADO NATIVO DE BÓVEDA (SOLO GERENCIA / ADMIN) ────────────────────
app.get('/api/descarga-absoluta-jc', auth('admin'), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.download(F.leads, 'RESPALDO_ABSOLUTO_SISTEMA.json');
});
// ─────────────────────────────────────────────────────────────────────────


// ─── AUTO-BACKUP HORARIO /var/data → /var/data/backups/ ──────────────────────
// Corre cada 1 hora. Guarda los últimos 24 archivos (= 24 horas de historia).
// No toca ningún archivo del disco principal, solo lee y comprime.
const BACKUP_DIR = require('path').join(DATA, 'backups');
if (!fsSync.existsSync(BACKUP_DIR)) fsSync.mkdirSync(BACKUP_DIR, { recursive: true });

async function runHourlyBackup() {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = require('path').join(BACKUP_DIR, 'backup-' + ts + '.tar.gz');

    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      // Excluir la carpeta backups/ del propio backup para no crear recursión
      const tar = spawn('tar', ['--exclude=./backups', '-czf', outFile, '-C', DATA, '.']);
      tar.stderr.on('data', d => console.error('[BACKUP-AUTO]', d.toString().trim()));
      tar.on('close', code => code === 0 ? resolve() : reject(new Error('tar exit ' + code)));
    });

    const stat = fsSync.statSync(outFile);
    console.log('[BACKUP-AUTO] OK:', require('path').basename(outFile), '-', Math.round(stat.size / 1024) + 'KB');

    // Rotar: eliminar backups más viejos de 24
    const MAX_BACKUPS = 24;
    const files = fsSync.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.tar.gz'))
      .map(f => ({ name: f, mtime: fsSync.statSync(require('path').join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      toDelete.forEach(f => {
        fsSync.unlinkSync(require('path').join(BACKUP_DIR, f.name));
        console.log('[BACKUP-AUTO] Rotado (eliminado):', f.name);
      });
    }
  } catch(e) {
    console.error('[BACKUP-AUTO] Error:', e.message);
  }
}

// Primer backup al arrancar (5 min después para no solapar con seed)
setTimeout(runHourlyBackup, 5 * 60 * 1000);
// Luego cada 1 hora
setInterval(runHourlyBackup, 60 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT,()=>{console.log(`🚀 FunnelOS :${PORT} | SLA_GREEN=${SLA_GREEN} SLA_REASSIGN=${SLA_REASSIGN} SLA_YELLOW=${SLA_YELLOW}`);seed().catch(console.error);});
