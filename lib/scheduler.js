'use strict';
/**
 * VerifactIA — Scheduler de vigilancia programada.
 *
 * Revisa las fuentes de forma automática y mantiene la bandeja viva, como una
 * redacción real. Dos modos:
 *   - intervalo: cada N segundos/minutos
 *   - horas fijas: ['06:00','12:00','18:00'] (cortes informativos)
 *
 * En cada ciclo:
 *   1. Ejecuta el pipeline (ingesta + clasificación + RUINE + memoria).
 *   2. Detecta noticias NUEVAS de alta prioridad (vía memoria).
 *   3. Notifica al encargado (email / log) — el humano decide después.
 *
 * El scheduler es ligero: por defecto NO genera fichas IA en cada ciclo
 * (eso es on-demand), salvo que se pida pre-generar el top.
 */

const { registrarEvento } = require('./memory');
const { notificarAlertas } = require('./alerts');

// Estado por modalidad
const estado = {
  tvn:   { activo: false, timer: null, config: null, ultimo: null, proximo: null },
  banca: { activo: false, timer: null, config: null, ultimo: null, proximo: null },
};

let _ejecutarPipeline = null; // inyectado para evitar require circular
function configurarEjecutor(fn) { _ejecutarPipeline = fn; }

async function correrCiclo(modo, topN) {
  if (!_ejecutarPipeline) return;
  try {
    registrarEvento('ciclo', `🔄 Ciclo programado iniciado (${modo.toUpperCase()})`, { modo });
    const r = await _ejecutarPipeline({ modo, topN: topN || 0, cache: false });

    // Noticias nuevas de alta prioridad detectadas por la memoria
    const alertas = (r.bandeja_priorizada || []).filter(n => n.alta_prioridad_nueva);
    if (alertas.length) {
      await notificarAlertas(alertas, modo);
    }
    estado[modo].ultimo = { ts: new Date().toISOString(), alertas: alertas.length, total: r.total_priorizadas };
    registrarEvento('ciclo_fin', `✅ Ciclo ${modo.toUpperCase()} completo: ${r.total_priorizadas} noticias` +
      (alertas.length ? ` · 🔴 ${alertas.length} alerta(s)` : ''), { modo });
    return r;
  } catch (e) {
    registrarEvento('ciclo_error', `⚠ Error en ciclo ${modo}: ${e.message}`, { modo });
  }
}

// ── Cálculo del próximo disparo para modo horas fijas ─────────────
function msHastaProximaHora(horas) {
  const ahora = new Date();
  let menor = Infinity;
  for (const h of horas) {
    const [hh, mm] = h.split(':').map(Number);
    const t = new Date(ahora);
    t.setHours(hh, mm || 0, 0, 0);
    let diff = t - ahora;
    if (diff <= 0) diff += 24 * 3600 * 1000; // mañana
    if (diff < menor) menor = diff;
  }
  return menor === Infinity ? null : menor;
}

/**
 * Inicia el scheduler para una modalidad.
 * config: { modo, tipo:'intervalo'|'horas', segundos?, horas?:['HH:MM'], topN? }
 */
function iniciar(config) {
  const modo = config.modo === 'banca' ? 'banca' : 'tvn';
  detener(modo); // limpia timer previo
  estado[modo].activo = true;
  estado[modo].config = config;

  const topN = config.topN || 0; // 0 = solo detectar/priorizar (ligero), sin fichas IA

  if (config.tipo === 'horas' && Array.isArray(config.horas) && config.horas.length) {
    const programar = () => {
      const ms = msHastaProximaHora(config.horas);
      estado[modo].proximo = new Date(Date.now() + ms).toISOString();
      estado[modo].timer = setTimeout(async () => {
        await correrCiclo(modo, topN);
        if (estado[modo].activo) programar(); // reprograma la siguiente hora
      }, ms);
    };
    programar();
    registrarEvento('scheduler', `⏰ Programado ${modo.toUpperCase()} a horas fijas: ${config.horas.join(', ')}`, { modo });
  } else {
    const segundos = Math.max(10, parseInt(config.segundos || 1800, 10)); // mín 10s, def 30 min
    // Robusto ante suspensión del equipo: en vez de un setInterval largo (que se
    // congela si la PC duerme), un tick corto compara el RELOJ REAL con el próximo
    // disparo. Si la máquina estuvo dormida y ya pasó la hora, dispara al despertar.
    let proximoMs = Date.now() + segundos * 1000;
    estado[modo].proximo = new Date(proximoMs).toISOString();
    const tick = Math.min(segundos, 30) * 1000; // revisa al menos cada 30s
    estado[modo].timer = setInterval(async () => {
      if (Date.now() >= proximoMs) {
        proximoMs = Date.now() + segundos * 1000;
        estado[modo].proximo = new Date(proximoMs).toISOString();
        await correrCiclo(modo, topN);
      }
    }, tick);
    registrarEvento('scheduler', `⏱ Programado ${modo.toUpperCase()} cada ${segundos}s (reloj real)`, { modo });
  }
  return estadoScheduler(modo);
}

function detener(modo) {
  const m = modo === 'banca' ? 'banca' : 'tvn';
  if (estado[m].timer) { clearInterval(estado[m].timer); clearTimeout(estado[m].timer); }
  estado[m].timer = null;
  if (estado[m].activo) registrarEvento('scheduler', `⏹ Scheduler ${m.toUpperCase()} detenido`, { modo: m });
  estado[m].activo = false;
  estado[m].proximo = null;
  return estadoScheduler(m);
}

function estadoScheduler(modo) {
  if (modo) return { modo, ...estado[modo], timer: undefined };
  return {
    tvn:   { ...estado.tvn, timer: undefined },
    banca: { ...estado.banca, timer: undefined },
  };
}

module.exports = { configurarEjecutor, iniciar, detener, estadoScheduler, correrCiclo };
