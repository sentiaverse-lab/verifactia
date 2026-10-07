'use strict';
/**
 * VerifactIA — Clasificador temático + agrupador de duplicados.
 * Usa el enjambre de IA para clasificación semántica.
 * Baseline: reglas por palabras clave (siempre disponible sin IA).
 */

const TEMAS = [
  'economia', 'logistica_canal', 'turismo', 'regulacion',
  'servicios_publicos', 'eventos_naturales', 'seguridad', 'general'
];

const TEMAS_BANCA = [
  'liquidez', 'credito', 'comercio_exterior', 'inversion',
  'inflacion_regional', 'regulacion_financiera', 'general'
];

// ── Baseline por palabras clave ───────────────────────────────────
const REGLAS = [
  { tema: 'logistica_canal', pat: /canal|logísti|logisti|puerto|carga|contenedor|tránsito|transit|naviero|freight/i },
  { tema: 'turismo',         pat: /turismo|tourist|hotel|visitante|crucero|resort|hospedaje/i },
  { tema: 'economia',        pat: /econom|pib|inflac|precio|finanz|banco|crédito|credito|moneda|fiscal|presupuest/i },
  { tema: 'eventos_naturales', pat: /sismo|terremoto|inundac|huracán|huracan|desastre|natural|lluvia|sequía/i },
  { tema: 'regulacion',      pat: /ley|decreto|norma|gobierno|ministerio|presidente|asamblea|resolución/i },
  { tema: 'servicios_publicos', pat: /agua|electricidad|transporte|salud|educación|educacion|idaan|etesa/i },
  { tema: 'seguridad',       pat: /crimen|delito|seguridad|policía|policia|violencia|narcotráfico|pandilla/i },
];

// ── Reglas BANCA (entorno económico/financiero) ──────────────────
const REGLAS_BANCA = [
  { tema: 'liquidez',             pat: /liquidez|depósito|deposito|ahorro|efectivo|reserva|caja|solvencia/i },
  { tema: 'credito',             pat: /crédito|credito|préstamo|prestamo|financ|hipotec|tasa de interés|tasa de interes|morosidad|cartera/i },
  { tema: 'comercio_exterior',   pat: /exportac|importac|comercio exterior|canal de panam|puerto de|puertos|carga|arancel|balanza comercial|contenedor|logísti|logisti|naviero|zona libre/i },
  { tema: 'inversion',           pat: /inversión|inversion|bolsa|acciones|bono|capital|fondo|rendimiento|dividend|mercado de valores/i },
  { tema: 'inflacion_regional',  pat: /inflac|precio|costo de vida|canasta|ipc|encarec|devaluac|poder adquisitivo/i },
  { tema: 'regulacion_financiera', pat: /superintendencia|sbp|regulación|regulacion|basilea|norma bancaria|lavado|cumplimiento|banco nacional|ministerio de economía|mef/i },
];

function clasificarBaseline(titulo, descripcion = '', modo = 'tvn') {
  const texto = `${titulo} ${descripcion}`.toLowerCase();
  const reglas = modo === 'banca' ? REGLAS_BANCA : REGLAS;
  for (const r of reglas) {
    if (r.pat.test(texto)) return r.tema;
  }
  return 'general';
}

/**
 * ¿Esta noticia es relevante para el entorno económico/bancario?
 * Banca descarta farándula/deportes/sucesos y se queda con señales económicas.
 */
function esRelevanteBanca(titulo, descripcion = '') {
  const texto = `${titulo} ${descripcion}`.toLowerCase();
  // Señales económicas inequívocas. "puerto" exige contexto portuario/logístico real.
  const economico = /econom|financ|banc|crédito|credito|inflac|\bprecio|inversión|inversion|exportac|importac|comercio exterior|comercio inter|canal de panam|puerto de|puertos|aranc|dólar|dolar|tasa de inter|\bpib\b|fiscal|presupuest|deuda p|empleo|desemple|mercado de|bolsa de valores|monetari|liquidez|dep[oó]sito|recesión|recesion|balanza|remesa|crecimiento económic|zona libre|logísti|logisti/i;
  const ruido = /fútbol|futbol|\bgol\b|liga panameña|concierto|farándula|farandula|cantante|actor|actriz|novela|celebr|miss |reina de belleza|boxeo|béisbol|beisbol|selección de|seleccion de|viaja a|modelo|belleza|certamen/i;
  if (ruido.test(texto)) return false;      // ruido descarta siempre en banca
  return economico.test(texto);
}

// ── Similitud de Jaccard para agrupar duplicados ──────────────────
function tokenize(s) {
  return new Set((s || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3));
}

function jaccardSim(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  const inter = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Agrupa noticias sobre el mismo evento (similitud Jaccard > umbral).
 * Retorna grupos: cada grupo = array de ids_noticia.
 * Una agencia replicada = una sola procedencia (regla del reto).
 */
function agruparDuplicados(noticias, umbral = 0.35) {
  const grupos = []; // [{ids, representante_id, fuentes_independientes}]
  const asignado = new Set();

  noticias.forEach((n, i) => {
    if (asignado.has(n.id_noticia)) return;
    const grupo = { ids: [n.id_noticia], representante_id: n.id_noticia, titulos: [n.titulo], medios: new Set([n.medio || n.origen]) };
    asignado.add(n.id_noticia);

    for (let j = i + 1; j < noticias.length; j++) {
      const m = noticias[j];
      if (asignado.has(m.id_noticia)) continue;
      const sim = jaccardSim(n.titulo, m.titulo);
      if (sim >= umbral) {
        grupo.ids.push(m.id_noticia);
        grupo.titulos.push(m.titulo);
        grupo.medios.add(m.medio || m.origen);
        asignado.add(m.id_noticia);
      }
    }
    grupos.push({
      grupo_id: `grp_${i}_${Date.now()}`,
      ids: grupo.ids,
      representante_id: grupo.representante_id,
      titulo_representante: grupo.titulos[0],
      n_articulos: grupo.ids.length,
      fuentes_independientes: grupo.medios.size, // ← clave: medios distintos
      medios: [...grupo.medios],
    });
  });
  return grupos;
}

// ── Clasificación semántica con IA (mejora al baseline) ──────────
async function clasificarConIA(noticias, ai, modo = 'tvn') {
  if (!ai || !ai.IA_HABILITADA) {
    // Fallback: baseline para todas
    return noticias.map(n => ({ ...n, tema: clasificarBaseline(n.titulo), clasificacion_fuente: 'baseline' }));
  }

  const temasList = modo === 'banca' ? TEMAS_BANCA : TEMAS;
  const lote = noticias.slice(0, 50); // procesar en lotes de 50

  const prompt = `Clasifica cada noticia en UNO de estos temas: ${temasList.join(', ')}.
Responde SOLO con JSON: [{"id": "id_noticia", "tema": "tema_elegido", "confianza": 0.0-1.0}]
Noticias:
${lote.map(n => `{"id":"${n.id_noticia}","titulo":${JSON.stringify(n.titulo)}}`).join('\n')}`;

  try {
    const resp = await ai.llamarIA([{ role: 'user', content: prompt }], 1200);
    const parsed = extraerJSON(resp);
    if (!Array.isArray(parsed)) throw new Error('respuesta no es array');
    const mapaIA = {};
    parsed.forEach(p => { if (p.id && p.tema) mapaIA[p.id] = { tema: p.tema, confianza: p.confianza || 0.8 }; });
    return noticias.map(n => ({
      ...n,
      tema: mapaIA[n.id_noticia]?.tema || clasificarBaseline(n.titulo),
      confianza_tema: mapaIA[n.id_noticia]?.confianza || null,
      clasificacion_fuente: mapaIA[n.id_noticia] ? 'ia' : 'baseline',
    }));
  } catch (e) {
    console.warn('[classifier] IA falló, usando baseline:', e.message);
    return noticias.map(n => ({ ...n, tema: clasificarBaseline(n.titulo), clasificacion_fuente: 'baseline' }));
  }
}

function extraerJSON(texto) {
  if (!texto) return null;
  const limpio = texto.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(limpio); } catch (_) {
    const m = limpio.match(/\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { return null; } }
    return null;
  }
}

module.exports = { clasificarBaseline, clasificarConIA, agruparDuplicados, esRelevanteBanca, TEMAS, TEMAS_BANCA };
