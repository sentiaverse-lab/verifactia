'use strict';
/**
 * VerifactIA — Módulo de ingesta de datos públicos.
 * Conecta con: TVN RSS, GDELT DOC 2.0, Banco Mundial Indicators API, USGS Earthquakes.
 * Normaliza todo a estructuras canónicas y guarda en data/.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// SHA-256 de un archivo (hex). Devuelve null si no existe.
function sha256File(filepath) {
  try {
    const buf = fs.readFileSync(filepath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (_) { return null; }
}

const DATA_DIR = path.join(__dirname, '..', 'data', 'raw');
const PROC_DIR = path.join(__dirname, '..', 'data', 'processed');

[DATA_DIR, PROC_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Utilidades HTTP ───────────────────────────────────────────────
function fetchText(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'VerifactIA/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
  });
}

function fetchJSON(url, timeoutMs = 20000) {
  return fetchText(url, timeoutMs).then(t => JSON.parse(t));
}

// ── 1. TVN RSS ────────────────────────────────────────────────────
// RSS público de TVN Panamá
const TVN_RSS_URLS = [
  'https://www.tvn-2.com/rss/',
  'https://www.tvn-2.com/feed/',
];

async function ingestTVN() {
  const log = [];
  let xml = null;
  let usedUrl = null;
  for (const url of TVN_RSS_URLS) {
    try { xml = await fetchText(url); usedUrl = url; break; }
    catch (e) { log.push(`TVN RSS ${url}: ${e.message}`); }
  }
  if (!xml) {
    log.push('TVN RSS: no se pudo conectar — usando muestra vacía');
    return { noticias: [], log };
  }
  const noticias = parseRSS(xml, 'TVN');
  log.push(`TVN RSS OK (${noticias.length} items) de ${usedUrl}`);
  return { noticias, log };
}

// ── 2. GDELT DOC 2.0 ─────────────────────────────────────────────
const GDELT_QUERIES = [
  'Panama economia',
  'Panama logistica Canal',
  'Panama turismo',
  'Panama regulacion',
  'Panama eventos naturales',
];

async function ingestGDELT() {
  const log = [];
  let all = [];
  let fallos429 = 0;

  // GDELT da 429 desde redes residenciales/datacenter. Por defecto deshabilitado
  // para demos rápidas. Activar con GDELT_ENABLED=true cuando la red lo permita.
  if (String(process.env.GDELT_ENABLED).toLowerCase() !== 'true') {
    log.push('GDELT: deshabilitado (GDELT_ENABLED!=true) — usando solo TVN RSS');
    return { noticias: [], log };
  }

  for (const q of GDELT_QUERIES) {
    // Corta-circuito: si GDELT ya rechazó 2 veces (rate-limit), no insistir — ahorra ~30s
    if (fallos429 >= 2) {
      log.push(`GDELT: omitiendo "${q}" (rate-limit detectado, corta-circuito)`);
      continue;
    }
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=50&format=json&timespan=30d&sourcelang=spanish`;
    try {
      await new Promise(r => setTimeout(r, 800)); // delay corto para espaciar peticiones
      const data = await fetchJSON(url, 8000); // timeout agresivo: GDELT lento = no vale la pena esperar
      const arts = (data.articles || []).map(a => ({
        id_noticia: `gdelt_${slugify(a.url || a.seendate || Math.random())}`,
        titulo: (a.title || '').trim(),
        url: a.url || '',
        medio: a.domain || 'gdelt',
        idioma: a.language || 'Spanish',
        fecha_publicacion: isoDate(a.seendate),
        fecha_deteccion: isoDate(a.seendate),
        fecha_extraccion: new Date().toISOString(),
        tema: inferTema(a.title || '', q),
        origen: 'gdelt',
        alcance_texto: 'titular+metadata',
        query_origen: q,
      }));
      all = all.concat(arts);
      log.push(`GDELT "${q}": ${arts.length} artículos`);
    } catch (e) {
      if (/429/.test(e.message) || /Timeout/.test(e.message)) fallos429++;
      log.push(`GDELT "${q}" ERROR: ${e.message}`);
    }
  }
  // Deduplicar por URL
  const seen = new Set();
  const unique = all.filter(a => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url); return true;
  });
  log.push(`GDELT total único: ${unique.length}`);
  return { noticias: unique, log };
}

// ── 3. Banco Mundial ─────────────────────────────────────────────
const WB_COUNTRIES = ['PAN', 'CRI', 'COL', 'DOM', 'MEX', 'GTM'];
const WB_INDICATORS = [
  { id: 'NY.GDP.MKTP.KD.ZG', nombre: 'Crecimiento PIB (%)' },
  { id: 'FP.CPI.TOTL.ZG',    nombre: 'Inflación (%)' },
  { id: 'SL.UEM.TOTL.ZS',    nombre: 'Desempleo (%)' },
  { id: 'SP.POP.TOTL',        nombre: 'Población' },
  { id: 'IT.NET.USER.ZS',     nombre: 'Uso internet (%)' },
  { id: 'NE.EXP.GNFS.ZS',    nombre: 'Exportaciones/PIB (%)' },
];

async function ingestBancoMundial() {
  const log = [];
  const rows = [];
  for (const ind of WB_INDICATORS) {
    const url = `https://api.worldbank.org/v2/country/${WB_COUNTRIES.join(';')}/indicator/${ind.id}?format=json&per_page=500&date=2010:2024`;
    try {
      const data = await fetchJSON(url, 30000);
      const items = data[1] || [];
      items.forEach(item => {
        rows.push({
          pais_iso3: item.countryiso3code || item.country?.id,
          indicador_id: ind.id,
          indicador_nombre: ind.nombre,
          anio: item.date ? parseInt(item.date) : null,
          valor: item.value,  // null si falta — mantenemos null explícito
          unidad: '%',
          fuente_url: `https://data.worldbank.org/indicator/${ind.id}`,
          fecha_extraccion: new Date().toISOString(),
          licencia: 'CC BY 4.0',
        });
      });
      log.push(`WB ${ind.id}: ${items.length} filas`);
    } catch (e) {
      log.push(`WB ${ind.id} ERROR: ${e.message}`);
    }
  }
  log.push(`Banco Mundial total: ${rows.length} filas`);
  return { indicadores: rows, log };
}

// ── 4. USGS Sismos (ventana reciente, datos frescos) ─────────────
async function ingestUSGS() {
  const log = [];
  // Ventana de los últimos 60 días → eventos recientes, no snapshot fijo de 2024.
  const dias = parseInt(process.env.USGS_DIAS || '60', 10);
  const start = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  // Caja regional ampliada: latitud 3-13, longitud -88 a -74 (Panamá + vecinos)
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minlatitude=3&maxlatitude=13&minlongitude=-88&maxlongitude=-74&minmagnitude=3`;
  try {
    const data = await fetchJSON(url, 30000);
    const features = (data.features || []).map(f => ({
      id: f.id,
      magnitude: f.properties?.mag,
      time: f.properties?.time ? new Date(f.properties.time).toISOString() : null,
      updated: f.properties?.updated ? new Date(f.properties.updated).toISOString() : null,
      longitude: f.geometry?.coordinates?.[0],
      latitude: f.geometry?.coordinates?.[1],
      depth: f.geometry?.coordinates?.[2],
      place: f.properties?.place,
      status: f.properties?.status,
      felt: f.properties?.felt,           // nº de reportes "lo sentí"
      alert: f.properties?.alert,          // green/yellow/orange/red (PAGER)
      tsunami: f.properties?.tsunami,
      significance: f.properties?.sig,     // relevancia USGS 0-1000
      url: f.properties?.url,
    }));
    log.push(`USGS sismos (${dias}d): ${features.length} eventos`);
    return { eventos: features, log };
  } catch (e) {
    log.push(`USGS ERROR: ${e.message}`);
    return { eventos: [], log };
  }
}

/**
 * Convierte sismos relevantes en NOTICIAS verificables para la bandeja.
 * Un sismo es "noticiable" si M≥4.5, fue sentido, o tiene alerta PAGER.
 * Fuente primaria oficial = evidencia perfecta (no requiere corroboración).
 */
function sismosComoNoticias(eventos) {
  const noticiables = (eventos || []).filter(e =>
    (e.magnitude || 0) >= 4.5 || (e.felt || 0) > 0 || (e.alert && e.alert !== 'green')
  );
  return noticiables.map(e => {
    const mag = (e.magnitude || 0).toFixed(1);
    const sentido = (e.felt || 0) > 0 ? ` · sentido por ${e.felt} ${e.felt === 1 ? 'persona' : 'personas'}` : '';
    const alerta = e.alert && e.alert !== 'green' ? ` · alerta ${e.alert.toUpperCase()}` : '';
    return {
      id_noticia: `usgs_${e.id}`,
      titulo: `Sismo de magnitud ${mag} — ${e.place || 'región de Panamá'}${sentido}${alerta}`,
      url: e.url || `https://earthquake.usgs.gov/earthquakes/eventpage/${e.id}`,
      medio: 'USGS (Servicio Geológico de EE.UU.)',
      idioma: 'Spanish',
      fecha_publicacion: e.time || new Date().toISOString(),
      fecha_deteccion: e.updated || e.time || new Date().toISOString(),
      fecha_extraccion: new Date().toISOString(),
      tema: 'eventos_naturales',
      origen: 'usgs',
      alcance_texto: 'evento+metadata_oficial',
      fuente_primaria: true,            // dato oficial → evidencia directa
      magnitud: e.magnitude,
      sismo_meta: { magnitude: e.magnitude, depthKm: e.depth, felt: e.felt, alert: e.alert, tsunami: e.tsunami, significance: e.significance, lat: e.latitude, lng: e.longitude },
    };
  });
}

// ── Parseo RSS ────────────────────────────────────────────────────
function parseRSS(xml, medio) {
  const items = [];
  const itemReg = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemReg.exec(xml)) !== null) {
    const blk = m[1];
    const titulo = stripTags(extract(blk, 'title'));
    const url = extract(blk, 'link') || extract(blk, 'guid');
    const fecha = extract(blk, 'pubDate') || extract(blk, 'dc:date');
    if (!titulo) continue;
    items.push({
      id_noticia: `tvn_${slugify(url || titulo)}`,
      titulo,
      url: url || '',
      medio,
      idioma: 'Spanish',
      fecha_publicacion: fecha ? new Date(fecha).toISOString() : new Date().toISOString(),
      fecha_deteccion: new Date().toISOString(),
      fecha_extraccion: new Date().toISOString(),
      tema: inferTema(titulo, ''),
      origen: 'tvn_rss',
      alcance_texto: 'titular+metadata',
    });
  }
  return items;
}

function extract(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return m ? (m[1] || m[2] || '').trim() : '';
}

function stripTags(s) { return (s || '').replace(/<[^>]+>/g, '').trim(); }

// ID DETERMINISTA: la misma noticia (misma url/título) produce SIEMPRE el mismo
// id entre corridas → la memoria la reconoce y no la recuenta como nueva.
function slugify(s) {
  const base = String(s).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  const hash = hashCorto(String(s));
  return `${base}_${hash}`;
}

function hashCorto(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

function isoDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6Z'));
  return isNaN(d) ? null : d.toISOString();
}

function inferTema(titulo, query) {
  const t = (titulo + ' ' + query).toLowerCase();
  if (/canal|logística|logist|puerto|carga|contenedor|transit/.test(t)) return 'logistica_canal';
  if (/turismo|tourist|hotel|visitante/.test(t)) return 'turismo';
  if (/econom|pib|inflac|precio|finanz|banco|credit|moneda/.test(t)) return 'economia';
  if (/sismo|terremoto|inundac|huracán|desastre|natural/.test(t)) return 'eventos_naturales';
  if (/regula|ley|decreto|norma|gobierno|ministe|presiden/.test(t)) return 'regulacion';
  if (/servicio|agua|electricidad|transporte|salud|educacion/.test(t)) return 'servicios_publicos';
  return 'general';
}

// ── Guardar datos ─────────────────────────────────────────────────
function saveCSV(rows, filepath, fields) {
  if (!rows.length) { fs.writeFileSync(filepath, fields.join(',') + '\n', 'utf8'); return; }
  const header = fields.join(',');
  const lines = rows.map(r => fields.map(f => {
    const v = r[f] === null || r[f] === undefined ? '' : String(r[f]);
    return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(','));
  fs.writeFileSync(filepath, [header, ...lines].join('\n'), 'utf8');
}

function saveJSON(data, filepath) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

// ── Función principal de ingesta ─────────────────────────────────
async function ingestarTodo() {
  console.log('[VerifactIA] Iniciando ingesta de datos públicos...');
  const manifest = {
    version: '1.0',
    fecha_corte_UTC: new Date().toISOString(),
    fuentes: {},
    cantidades: {},
    transformaciones: [],
  };

  // Las 4 fuentes son independientes → ingesta en paralelo
  const [tvn, gdelt, wb, usgs] = await Promise.all([
    ingestTVN(),
    ingestGDELT(),
    ingestBancoMundial(),
    ingestUSGS(),
  ]);
  tvn.log.forEach(l => console.log(' TVN:', l));
  gdelt.log.forEach(l => console.log(' GDELT:', l));
  wb.log.forEach(l => console.log(' WB:', l));
  usgs.log.forEach(l => console.log(' USGS:', l));

  // Sismos relevantes como noticias verificables (fuente primaria oficial)
  const sismosNoticia = sismosComoNoticias(usgs.eventos);
  if (sismosNoticia.length) console.log(` Sismos noticiables: ${sismosNoticia.length} (M≥4.5 / sentidos / con alerta)`);

  // Merge noticias + deduplicar por URL
  let noticias = [...tvn.noticias, ...gdelt.noticias, ...sismosNoticia];
  const seenUrls = new Set();
  noticias = noticias.filter(n => {
    if (!n.url) return true;
    if (seenUrls.has(n.url)) return false;
    seenUrls.add(n.url); return true;
  });
  console.log(` Total noticias únicas: ${noticias.length}`);

  // Guardar archivos
  const noticiaFields = ['id_noticia','titulo','url','medio','idioma','fecha_publicacion','fecha_deteccion','fecha_extraccion','tema','origen','alcance_texto'];
  saveCSV(noticias, path.join(DATA_DIR, 'noticias.csv'), noticiaFields);

  const indFields = ['pais_iso3','indicador_id','indicador_nombre','anio','valor','unidad','fuente_url','fecha_extraccion','licencia'];
  saveCSV(wb.indicadores, path.join(DATA_DIR, 'indicadores.csv'), indFields);

  saveJSON({ type: 'FeatureCollection', features: usgs.eventos.map(e => ({
    type: 'Feature', id: e.id,
    properties: { magnitude: e.magnitude, time: e.time, updated: e.updated, place: e.place, status: e.status, url: e.url, depth: e.depth },
    geometry: { type: 'Point', coordinates: [e.longitude, e.latitude, e.depth] }
  }))}, path.join(DATA_DIR, 'eventos.geojson'));

  // Manifest
  manifest.fuentes = {
    tvn: { url: 'https://www.tvn-2.com/rss/', tipo: 'RSS', licencia: 'solo metadatos' },
    gdelt: { url: 'https://api.gdeltproject.org/api/v2/doc/doc', tipo: 'API JSON', licencia: 'GDELT DOC 2.0' },
    banco_mundial: { url: 'https://api.worldbank.org/v2', tipo: 'API JSON', licencia: 'CC BY 4.0' },
    usgs: { url: 'https://earthquake.usgs.gov/fdsnws/event/1/query', tipo: 'API GeoJSON', licencia: 'Dominio público' },
  };
  manifest.cantidades = {
    noticias: noticias.length,
    indicadores: wb.indicadores.length,
    eventos_sismicos: usgs.eventos.length,
  };
  manifest.transformaciones = [
    'Deduplicacion por URL en noticias',
    'Clasificacion tematica automatica por palabras clave',
    'Fechas normalizadas a ISO 8601 UTC',
    'Nulos conservados explicitamente en indicadores',
  ];
  // SHA-256 del snapshot: hash por archivo (requisito del contrato de datos)
  manifest.sha256 = {
    'noticias.csv': sha256File(path.join(DATA_DIR, 'noticias.csv')),
    'indicadores.csv': sha256File(path.join(DATA_DIR, 'indicadores.csv')),
    'eventos.geojson': sha256File(path.join(DATA_DIR, 'eventos.geojson')),
  };
  // Hash combinado del snapshot completo (huella única del paquete de datos)
  manifest.sha256_snapshot = crypto.createHash('sha256')
    .update(Object.values(manifest.sha256).filter(Boolean).join('|'))
    .digest('hex');
  saveJSON(manifest, path.join(DATA_DIR, 'manifest.json'));

  console.log('[VerifactIA] Ingesta completa.');
  console.log(` Noticias: ${noticias.length} | Indicadores: ${wb.indicadores.length} | Sismos: ${usgs.eventos.length}`);
  return { noticias, indicadores: wb.indicadores, eventos: usgs.eventos, manifest };
}

module.exports = { ingestarTodo, inferTema };
