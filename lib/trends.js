'use strict';
/**
 * VerifactIA — Tendencias de contexto (datos INDEPENDIENTES, sin relación causal).
 *
 * Dos indicadores separados, cada uno comparado contra su propio histórico:
 *   1. Sismos cerca de Panamá — USGS (count endpoint histórico).
 *   2. Tormentas solares / actividad solar — NOAA (número de manchas solares SSN).
 *
 * REGLA DE HONESTIDAD: son dos fenómenos SEPARADOS. NO se insinúa que uno
 * cause/prediga al otro ni que predigan sismos. Solo describimos la tendencia
 * observada (aumentó / disminuyó / estable) con su fuente.
 */

const https = require('https');

function fetchText(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'VerifactIA/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function clasificarTendencia(actual, referencia, umbralPct = 10) {
  if (!referencia || referencia === 0) return { etiqueta: 'sin referencia', flecha: '→', pct: null };
  const pct = Math.round(((actual - referencia) / referencia) * 100);
  if (pct >= umbralPct) return { etiqueta: 'por encima del promedio', flecha: '↑', pct };
  if (pct <= -umbralPct) return { etiqueta: 'por debajo del promedio', flecha: '↓', pct };
  return { etiqueta: 'en línea con el promedio', flecha: '→', pct };
}

/**
 * Tendencia sísmica: sismos cerca de Panamá en los últimos N días vs el promedio
 * del mismo período-ventana en años anteriores. Usa el count endpoint (barato).
 */
async function tendenciaSismica(dias = 60, anios = 10) {
  const caja = 'minlatitude=3&maxlatitude=13&minlongitude=-88&maxlongitude=-74&minmagnitude=3';
  const countEntre = async (start, end) => {
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/count?format=text&starttime=${start}&endtime=${end}&${caja}`;
    const t = await fetchText(url);
    const n = parseInt(String(t).trim(), 10);
    return isNaN(n) ? null : n;
  };

  const hoy = new Date();
  const inicioActual = new Date(hoy.getTime() - dias * 86400000);
  const actual = await countEntre(inicioActual.toISOString().slice(0, 10), hoy.toISOString().slice(0, 10));

  // Promedio de la misma ventana de 'dias' en los últimos 'anios' años
  const previos = [];
  for (let a = 1; a <= anios; a++) {
    const fin = new Date(hoy); fin.setFullYear(hoy.getFullYear() - a);
    const ini = new Date(fin.getTime() - dias * 86400000);
    try {
      const c = await countEntre(ini.toISOString().slice(0, 10), fin.toISOString().slice(0, 10));
      if (c !== null) previos.push(c);
    } catch (_) { /* omitir año que falle */ }
  }
  const promedio = previos.length ? previos.reduce((s, x) => s + x, 0) / previos.length : null;
  const tend = (actual !== null && promedio !== null) ? clasificarTendencia(actual, promedio) : { etiqueta: 'sin referencia', flecha: '→', pct: null };

  return {
    indicador: 'Actividad sísmica cerca de Panamá',
    ventana_dias: dias,
    actual,
    promedio_historico: promedio !== null ? Math.round(promedio * 10) / 10 : null,
    anios_comparados: previos.length,
    tendencia: tend,
    fuente: 'USGS Earthquake Catalog',
    disclaimer: 'Describe actividad observada. No predice sismos futuros.',
  };
}

/**
 * Tendencia solar: número de manchas solares (SSN) del último mes disponible
 * vs el mismo mes del año anterior. Indicador clásico de "tormentas solares".
 */
async function tendenciaSolar() {
  const url = 'https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json';
  try {
    const txt = await fetchText(url);
    const serie = JSON.parse(txt).filter(r => typeof r.ssn === 'number' && r.ssn >= 0);
    if (serie.length < 13) throw new Error('serie corta');
    const ultimo = serie[serie.length - 1];
    const hace12m = serie[serie.length - 13];
    const tend = clasificarTendencia(ultimo.ssn, hace12m.ssn);
    return {
      indicador: 'Actividad solar (manchas solares)',
      mes_actual: ultimo['time-tag'],
      ssn_actual: Math.round(ultimo.ssn * 10) / 10,
      ssn_hace_12m: Math.round(hace12m.ssn * 10) / 10,
      f107_actual: ultimo['f10.7'] ?? null,
      tendencia: tend,
      fuente: 'NOAA SWPC — Observed Solar Cycle Indices',
      disclaimer: 'Dato independiente de clima espacial. Sin relación causal con la sismicidad.',
    };
  } catch (e) {
    return { indicador: 'Actividad solar (manchas solares)', error: e.message, fuente: 'NOAA SWPC' };
  }
}

/**
 * Tendencia de temperatura en Ciudad de Panamá: media de los últimos N días
 * vs la media del mismo período-ventana en años anteriores (archivo histórico).
 * Dato independiente de contexto climático (relevante por fenómenos como El Niño).
 */
async function tendenciaTemperatura(dias = 60, anios = 8) {
  const LAT = 8.98, LON = -79.52; // Ciudad de Panamá
  const fetchJSON = async (u) => JSON.parse(await fetchText(u, 15000));

  const hoy = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);

  // Media reciente (archivo histórico llega hasta ~hace 5 días; usamos ventana reciente)
  const finAct = new Date(hoy.getTime() - 5 * 86400000);
  const iniAct = new Date(finAct.getTime() - dias * 86400000);
  const urlAct = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&start_date=${iso(iniAct)}&end_date=${iso(finAct)}&daily=temperature_2m_mean&timezone=America%2FPanama`;

  let mediaActual = null;
  try {
    const j = await fetchJSON(urlAct);
    const a = (j.daily?.temperature_2m_mean || []).filter(x => x != null);
    if (a.length) mediaActual = a.reduce((s, x) => s + x, 0) / a.length;
  } catch (_) {}

  // Media histórica del mismo rango mes/día en años anteriores
  const medias = [];
  for (let k = 1; k <= anios; k++) {
    const fin = new Date(finAct); fin.setFullYear(finAct.getFullYear() - k);
    const ini = new Date(fin.getTime() - dias * 86400000);
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&start_date=${iso(ini)}&end_date=${iso(fin)}&daily=temperature_2m_mean&timezone=America%2FPanama`;
    try {
      const j = await fetchJSON(url);
      const a = (j.daily?.temperature_2m_mean || []).filter(x => x != null);
      if (a.length) medias.push(a.reduce((s, x) => s + x, 0) / a.length);
    } catch (_) {}
  }
  const mediaHist = medias.length ? medias.reduce((s, x) => s + x, 0) / medias.length : null;

  let tend = { etiqueta: 'sin referencia', flecha: '→', pct: null, delta: null };
  if (mediaActual !== null && mediaHist !== null) {
    const delta = Math.round((mediaActual - mediaHist) * 10) / 10;
    const base = clasificarTendencia(mediaActual, mediaHist, 1.5); // 1.5% ~ margen
    // Para temperatura, mejor umbral en grados: ±0.5°C
    const etiqueta = delta >= 0.5 ? 'más cálido que lo normal' : delta <= -0.5 ? 'más fresco que lo normal' : 'en línea con lo normal';
    const flecha = delta >= 0.5 ? '↑' : delta <= -0.5 ? '↓' : '→';
    tend = { etiqueta, flecha, pct: base.pct, delta };
  }

  return {
    indicador: 'Temperatura (Ciudad de Panamá)',
    ventana_dias: dias,
    media_actual: mediaActual !== null ? Math.round(mediaActual * 10) / 10 : null,
    media_historica: mediaHist !== null ? Math.round(mediaHist * 10) / 10 : null,
    anios_comparados: medias.length,
    tendencia: tend,
    fuente: 'Open-Meteo (archivo histórico)',
    disclaimer: 'Contexto climático observado (relevante ante fenómenos como El Niño). No es pronóstico del tiempo.',
  };
}

/** Calcula las tres tendencias en paralelo. Tolerante a fallos (devuelve lo que haya). */
async function calcularTendencias(dias = 60) {
  const [sismica, solar, temperatura] = await Promise.allSettled([
    tendenciaSismica(dias), tendenciaSolar(), tendenciaTemperatura(dias),
  ]);
  return {
    sismica: sismica.status === 'fulfilled' ? sismica.value : null,
    solar: solar.status === 'fulfilled' ? solar.value : null,
    temperatura: temperatura.status === 'fulfilled' ? temperatura.value : null,
    generado: new Date().toISOString(),
  };
}

module.exports = { calcularTendencias, tendenciaSismica, tendenciaSolar, tendenciaTemperatura, clasificarTendencia };
