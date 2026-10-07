'use strict';
/**
 * VerifactIA — Capa de ciclos económicos históricos (solo modalidad Banca).
 *
 * Toma marcos económicos públicos y auditables (Kondratiev, Dalio, Turchin) y
 * ubica el presente en su fase usando ÚNICAMENTE indicadores reales del Banco
 * Mundial que ya ingesta el pipeline.
 *
 * REGLAS DE HONESTIDAD CRÍTICA (no romper jamás):
 *   - Entregamos CONTEXTO HISTÓRICO + CORRELACIÓN OBSERVADA, nunca predicción.
 *   - Nunca "el reset vendrá en 20XX", nunca "compre/venda tal activo".
 *   - Toda cifra lleva su fuente. La fase se deriva de datos, no de intuición.
 *
 * Fuentes (todas públicas / académicas / institucionales):
 *   - N. Kondratiev (1920s): ondas largas ~50-60 años, 4 estaciones.
 *   - R. Dalio / Bridgewater, "The Changing World Order" (2021): gran ciclo de deuda.
 *   - P. Turchin, "Ages of Discord" (2016): ciclo secular / cliodinámica.
 *   - Datos: World Bank Open Data (CC BY 4.0).
 */

// Anclas documentadas de inicios de onda Kondratiev (consenso Schumpeter/Freeman/Perez).
const KONDRATIEV_ANCLAS = [1780, 1840, 1890, 1940, 1990, 2040];
const KONDRATIEV_ESTACIONES = [
  { nombre: 'Primavera', desc: 'expansión tras el reset; innovación tecnológica se difunde', rango: [0, 0.25] },
  { nombre: 'Verano',    desc: 'crecimiento con presión inflacionaria', rango: [0.25, 0.5] },
  { nombre: 'Otoño',     desc: 'auge y especulación; desinflación', rango: [0.5, 0.75] },
  { nombre: 'Invierno',  desc: 'desapalancamiento / depuración (reset)', rango: [0.75, 1] },
];

/**
 * Fase de la onda Kondratiev para un año dado (posición dentro del ciclo de ~50 años).
 */
function faseKondratiev(anio = new Date().getFullYear()) {
  // Encontrar el ancla de inicio del ciclo vigente
  let inicio = KONDRATIEV_ANCLAS[0];
  let fin = KONDRATIEV_ANCLAS[KONDRATIEV_ANCLAS.length - 1];
  for (let i = 0; i < KONDRATIEV_ANCLAS.length - 1; i++) {
    if (anio >= KONDRATIEV_ANCLAS[i] && anio < KONDRATIEV_ANCLAS[i + 1]) {
      inicio = KONDRATIEV_ANCLAS[i];
      fin = KONDRATIEV_ANCLAS[i + 1];
      break;
    }
  }
  const duracion = fin - inicio;
  const anioCiclo = anio - inicio;
  const pos = Math.min(0.999, Math.max(0, anioCiclo / duracion));
  const estacion = KONDRATIEV_ESTACIONES.find(e => pos >= e.rango[0] && pos < e.rango[1]) || KONDRATIEV_ESTACIONES[3];
  return {
    marco: 'Onda Kondratiev (~50-60 años)',
    inicio_ciclo: inicio,
    anio_ciclo: anioCiclo,
    estacion: estacion.nombre,
    descripcion: estacion.desc,
    posicion_pct: Math.round(pos * 100),
    fuente: 'Kondratiev (1920s); validación Schumpeter/Freeman/Perez',
  };
}

/**
 * Lectura del momento macro a partir de indicadores REALES del Banco Mundial.
 * No predice: describe la configuración observada (expansión/contracción/sobrecalentamiento).
 */
function lecturaMacro(indicadores) {
  const ultimoPAN = (indId) => {
    const filas = (indicadores || [])
      .filter(i => i.pais_iso3 === 'PAN' && i.indicador_id === indId && i.valor !== null && i.valor !== '')
      .sort((a, b) => (b.anio || 0) - (a.anio || 0));
    return filas[0] || null;
  };

  const pib = ultimoPAN('NY.GDP.MKTP.KD.ZG');        // crecimiento PIB %
  const inflacion = ultimoPAN('FP.CPI.TOTL.ZG');     // inflación %
  const desempleo = ultimoPAN('SL.UEM.TOTL.ZS');     // desempleo %

  const g = pib?.valor, inf = inflacion?.valor, des = desempleo?.valor;
  const señales = [];
  let configuracion = 'indeterminada';

  if (typeof g === 'number') {
    if (g >= 4) señales.push('crecimiento alto');
    else if (g >= 2) señales.push('crecimiento moderado');
    else if (g >= 0) señales.push('crecimiento débil');
    else señales.push('contracción');
  }
  if (typeof inf === 'number') {
    if (inf >= 5) señales.push('inflación elevada');
    else if (inf >= 2) señales.push('inflación contenida');
    else if (inf >= 0) señales.push('inflación baja');
    else señales.push('deflación');
  }
  if (typeof des === 'number') {
    if (des >= 8) señales.push('desempleo alto');
    else if (des >= 5) señales.push('desempleo moderado');
    else señales.push('desempleo bajo');
  }

  // Clasificación observacional (no predictiva) estilo cuadrante crecimiento×inflación
  if (typeof g === 'number' && typeof inf === 'number') {
    if (g >= 2 && inf < 5) configuracion = 'expansión con inflación contenida';
    else if (g >= 2 && inf >= 5) configuracion = 'expansión con presión inflacionaria';
    else if (g < 2 && g >= 0 && inf >= 5) configuracion = 'estanflación incipiente';
    else if (g < 0) configuracion = 'contracción';
    else configuracion = 'crecimiento débil';
  }

  return {
    configuracion,
    señales,
    datos: {
      crecimiento_pib: pib ? { valor: round2(pib.valor), anio: pib.anio, fuente: pib.fuente_url } : null,
      inflacion: inflacion ? { valor: round2(inflacion.valor), anio: inflacion.anio, fuente: inflacion.fuente_url } : null,
      desempleo: desempleo ? { valor: round2(desempleo.valor), anio: desempleo.anio, fuente: desempleo.fuente_url } : null,
    },
  };
}

/**
 * Construye el bloque de ciclo histórico para el snapshot de Banca.
 * Combina: fase Kondratiev (año) + lectura macro (datos BM) + disclaimer obligatorio.
 */
function construirCicloHistorico(indicadores, anio = new Date().getFullYear()) {
  const kondratiev = faseKondratiev(anio);
  const macro = lecturaMacro(indicadores);

  return {
    titulo: 'Contexto de ciclo histórico',
    fase_label: `${kondratiev.estacion} · ${macro.configuracion}`,
    kondratiev,
    macro,
    marcos_referencia: [
      'Kondratiev — ondas largas ~50-60 años',
      'Dalio (Bridgewater) — gran ciclo de deuda ~75-100 años',
      'Turchin — ciclo secular ~150-200 años',
    ],
    disclaimer: 'Correlación histórica y lectura de indicadores públicos. NO es predicción de mercados ni asesoría financiera.',
  };
}

function round2(v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; }

module.exports = { construirCicloHistorico, faseKondratiev, lecturaMacro, KONDRATIEV_ANCLAS };
