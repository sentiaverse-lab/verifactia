'use strict';
/**
 * VerifactIA — Motor de priorización RUINE.
 * Fórmula oficial del reto: P = 30R + 25I + 20U + 15N + 10E
 * R=Relevancia, U=Urgencia, I=Impacto, N=Novedad, E=Evidencia
 * Todos normalizados 0-1. P en rango 0-100.
 * Rangos: bajo [0,40), medio [40,70), alto [70,100].
 */

const TEMAS_PANAMA = ['economia', 'logistica_canal', 'turismo', 'regulacion', 'servicios_publicos', 'eventos_naturales', 'seguridad'];
const TEMAS_BANCA  = ['liquidez', 'credito', 'comercio_exterior', 'inversion', 'inflacion_regional', 'regulacion_financiera'];

/**
 * Calcula el puntaje RUINE para una noticia/grupo.
 * @param {object} item - noticia con campos enriquecidos
 * @param {object[]} todasNoticias - corpus completo para calcular novedad
 * @param {string} modo - 'tvn' | 'banca'
 */
function calcularPuntaje(item, todasNoticias, modo = 'tvn') {
  const temasRelevantes = modo === 'banca' ? TEMAS_BANCA : TEMAS_PANAMA;
  const ahora = Date.now();

  // R — Relevancia (0-1): ¿es relevante para Panamá y para el modo?
  let R = 0;
  const esPanama = /panamá|panama|paname|canal|PTY|PANAMAeño/i.test(item.titulo + (item.descripcion || ''));
  if (esPanama) R += 0.5;
  if (temasRelevantes.includes(item.tema)) R += 0.3;
  if (item.origen === 'tvn_rss') R += 0.2; // fuente local suma
  // Relevancia geográfica de sismos: cercanía a Panamá (centro ~8.5N, 80W)
  if (item.sismo_meta && typeof item.sismo_meta.lat === 'number') {
    const dLat = item.sismo_meta.lat - 8.5, dLng = item.sismo_meta.lng + 80;
    const distKm = Math.sqrt(dLat * dLat + dLng * dLng) * 111;
    if (distKm <= 150) R += 0.5; else if (distKm <= 350) R += 0.35; else if (distKm <= 600) R += 0.2; else R += 0.05;
    if (/panama/i.test(item.titulo)) R += 0.2;
  }
  R = Math.min(1, R);

  // I — Impacto potencial (0-1): señales de impacto público/sectorial
  let I = 0.3; // base
  if (/millones|miles|crisis|emergencia|urgente|crítico|record|histórico/i.test(item.titulo)) I += 0.3;
  if (/presidente|gobierno|asamblea|ministerio|banco nacional/i.test(item.titulo)) I += 0.2;
  if (item.fuentes_independientes > 2) I += 0.2; // corroborado por varias fuentes
  // Impacto geofísico: magnitud, "sentido" y alerta PAGER elevan el impacto
  if (item.sismo_meta) {
    const mag = item.sismo_meta.magnitude || item.magnitud || 0;
    if (mag >= 6) I += 0.4; else if (mag >= 5) I += 0.25; else if (mag >= 4.5) I += 0.15;
    if (item.sismo_meta.felt > 0) I += 0.1;
    if (item.sismo_meta.tsunami) I += 0.3;
    if (item.sismo_meta.alert && item.sismo_meta.alert !== 'green') I += 0.2;
  }
  I = Math.min(1, I);

  // U — Urgencia (0-1): qué tan reciente es
  let U = 0.3;
  if (item.fecha_publicacion) {
    const horas = (ahora - new Date(item.fecha_publicacion).getTime()) / 3600000;
    if (horas <= 6)  U = 1.0;
    else if (horas <= 24) U = 0.85;
    else if (horas <= 72) U = 0.65;
    else if (horas <= 168) U = 0.45; // 1 semana
    else U = 0.2;
  }

  // N — Novedad (0-1): ¿es diferente a eventos ya agrupados?
  let N = 0.7; // asumimos novedad por defecto
  if (item.n_articulos > 1) {
    // Si es un grupo grande, penalizamos novedad (mucha repetición)
    N = Math.max(0.2, 1 - (item.n_articulos - 1) * 0.1);
  }

  // E — Evidencia disponible (0-1): ¿tenemos fuentes primarias identificables?
  let E = 0.3; // base con solo titular/metadata
  if (item.fuente_primaria) E = 0.9; // dato oficial directo (USGS, BM) → evidencia casi completa
  if (item.fuentes_independientes > 1) E += 0.2;
  if (item.url && item.url.startsWith('http')) E += 0.2;
  if (item.tiene_indicador_relacionado) E += 0.3; // cruzado con datos del Banco Mundial
  E = Math.min(1, E);

  // Fórmula oficial del reto
  const P = (30 * R) + (25 * I) + (20 * U) + (15 * N) + (10 * E);

  // Nivel
  let nivel;
  if (P >= 70) nivel = 'alto';
  else if (P >= 40) nivel = 'medio';
  else nivel = 'bajo';

  // Estado de evidencia (independiente del puntaje)
  let estado_evidencia;
  if (E >= 0.7) estado_evidencia = 'suficiente_para_borrador';
  else if (E >= 0.4) estado_evidencia = 'parcial';
  else estado_evidencia = 'insuficiente';

  return {
    puntaje: Math.round(P * 100) / 100,
    nivel,
    estado_evidencia,
    componentes: {
      R: Math.round(R * 100) / 100,
      I: Math.round(I * 100) / 100,
      U: Math.round(U * 100) / 100,
      N: Math.round(N * 100) / 100,
      E: Math.round(E * 100) / 100,
    },
    formula: `P = 30×${R.toFixed(2)} + 25×${I.toFixed(2)} + 20×${U.toFixed(2)} + 15×${N.toFixed(2)} + 10×${E.toFixed(2)} = ${P.toFixed(1)}`,
    reglas_version: '1.0',
    alerta: estado_evidencia === 'insuficiente' && nivel === 'alto'
      ? 'PRIORIDAD ALTA CON EVIDENCIA INSUFICIENTE — requiere investigación antes de publicar'
      : null,
  };
}

/**
 * Prioriza una lista de noticias/grupos.
 * Retorna lista ordenada de mayor a menor puntaje.
 * Empate: mayor urgencia → luego id.
 */
function priorizar(items, modo = 'tvn') {
  const conPuntaje = items.map(item => ({
    ...item,
    prioridad: calcularPuntaje(item, items, modo),
  }));

  // Ordenar: mayor puntaje primero; empate: mayor U; empate: menor id
  conPuntaje.sort((a, b) => {
    const dp = b.prioridad.puntaje - a.prioridad.puntaje;
    if (Math.abs(dp) > 0.01) return dp;
    const du = b.prioridad.componentes.U - a.prioridad.componentes.U;
    if (Math.abs(du) > 0.01) return du;
    return String(a.id_noticia || a.representante_id).localeCompare(String(b.id_noticia || b.representante_id));
  });

  return conPuntaje;
}

/**
 * Cruza noticias con indicadores del Banco Mundial
 * para enriquecer el campo tiene_indicador_relacionado.
 */
function cruzarConIndicadores(noticias, indicadores) {
  const ultimos = {}; // { pais_indicador: valor_mas_reciente }
  indicadores.forEach(ind => {
    if (ind.pais_iso3 === 'PAN' && ind.valor !== null && ind.valor !== '') {
      const k = ind.indicador_id;
      if (!ultimos[k] || ind.anio > (ultimos[k].anio || 0)) {
        ultimos[k] = ind;
      }
    }
  });

  return noticias.map(n => {
    const tiene = (
      (/econom|pib|inflac|desemple/i.test(n.titulo) && ultimos['NY.GDP.MKTP.KD.ZG']) ||
      (/precio|inflac/i.test(n.titulo) && ultimos['FP.CPI.TOTL.ZG']) ||
      (/canal|logísti|comercio/i.test(n.titulo) && ultimos['NE.EXP.GNFS.ZS'])
    );
    return { ...n, tiene_indicador_relacionado: !!tiene };
  });
}

module.exports = { priorizar, calcularPuntaje, cruzarConIndicadores };
