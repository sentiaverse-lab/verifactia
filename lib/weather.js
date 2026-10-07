'use strict';
/**
 * VerifactIA — Bloque de clima multi-ciudad (estilo noticiero).
 * Temperatura actual, máx/mín y probabilidad de lluvia por ciudad de Panamá.
 * Fuente: Open-Meteo (gratis, sin API key). Dato de contexto, no pronóstico editorial.
 */

const https = require('https');

const CIUDADES = [
  { nombre: 'Ciudad de Panamá', lat: 8.98, lon: -79.52 },
  { nombre: 'David',            lat: 8.43, lon: -82.43 },
  { nombre: 'Colón',            lat: 9.36, lon: -79.90 },
  { nombre: 'Santiago',         lat: 8.10, lon: -80.98 },
  { nombre: 'Chitré',           lat: 7.96, lon: -80.43 },
  { nombre: 'Bocas del Toro',   lat: 9.34, lon: -82.24 },
];

// WMO weather_code → etiqueta + icono (resumen de los grupos relevantes)
function describirClima(code) {
  if (code === 0) return { icono: '☀️', texto: 'despejado' };
  if (code <= 2) return { icono: '🌤️', texto: 'parcialmente nublado' };
  if (code === 3) return { icono: '☁️', texto: 'nublado' };
  if (code >= 45 && code <= 48) return { icono: '🌫️', texto: 'neblina' };
  if (code >= 51 && code <= 57) return { icono: '🌦️', texto: 'llovizna' };
  if (code >= 61 && code <= 67) return { icono: '🌧️', texto: 'lluvia' };
  if (code >= 80 && code <= 82) return { icono: '🌧️', texto: 'chubascos' };
  if (code >= 95) return { icono: '⛈️', texto: 'tormenta' };
  return { icono: '🌡️', texto: 'variable' };
}

function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'VerifactIA/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function climaCiudad(c) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
    `&current=temperature_2m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
    `&timezone=America%2FPanama&forecast_days=1`;
  const j = await fetchJSON(url);
  const code = j.daily?.weather_code?.[0];
  const desc = describirClima(code);
  return {
    ciudad: c.nombre,
    temp_actual: j.current?.temperature_2m ?? null,
    humedad: j.current?.relative_humidity_2m ?? null,
    max: j.daily?.temperature_2m_max?.[0] ?? null,
    min: j.daily?.temperature_2m_min?.[0] ?? null,
    prob_lluvia: j.daily?.precipitation_probability_max?.[0] ?? null,
    icono: desc.icono,
    condicion: desc.texto,
  };
}

/** Clima de todas las ciudades en paralelo. Tolerante a fallos. */
async function climaNacional() {
  const res = await Promise.allSettled(CIUDADES.map(climaCiudad));
  const ciudades = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  return {
    titulo: 'El tiempo en Panamá',
    ciudades,
    fuente: 'Open-Meteo',
    generado: new Date().toISOString(),
    nota: 'Condiciones actuales y probabilidad de lluvia por ciudad. Dato de contexto, no pronóstico editorial.',
  };
}

module.exports = { climaNacional, climaCiudad, describirClima, CIUDADES };
