'use strict';
/**
 * VerifactIA — Memoria persistente entre ciclos.
 *
 * Optimiza los procesos: en vez de empezar de cero en cada corrida del
 * scheduler, recuerda qué noticias ya vio, su huella y su ficha. Así:
 *   - No re-gasta IA en noticias ya procesadas (reusa la ficha guardada).
 *   - Distingue NUEVO / ACTUALIZADO / YA VISTO de forma confiable.
 *   - Recuerda decisiones del editor (descartado no vuelve a subir).
 *   - Permite detectar lo verdaderamente nuevo → base de las alertas.
 *
 * Almacén: JSON en disco (sin dependencias nuevas, viaja en el deploy).
 */

const fs = require('fs');
const path = require('path');

const MEM_DIR  = path.join(__dirname, '..', 'data', 'memoria');
const MEM_PATH = path.join(MEM_DIR, 'memoria.json');
const LOG_PATH = path.join(MEM_DIR, 'eventos.json'); // bitácora cronológica (histórico/feed)
fs.mkdirSync(MEM_DIR, { recursive: true });

// ── Bitácora de eventos (histórico por feed, auditoría) ───────────
const MAX_EVENTOS = 500; // conserva los últimos N
function cargarEventos() {
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch (_) { return []; }
}
function registrarEvento(tipo, mensaje, extra = {}) {
  const eventos = cargarEventos();
  eventos.unshift({ ts: new Date().toISOString(), tipo, mensaje, ...extra });
  if (eventos.length > MAX_EVENTOS) eventos.length = MAX_EVENTOS;
  fs.writeFileSync(LOG_PATH, JSON.stringify(eventos, null, 2), 'utf8');
}
function obtenerEventos(limite = 100, filtroModo = null) {
  const eventos = cargarEventos();
  const filtrados = filtroModo ? eventos.filter(e => !e.modo || e.modo === filtroModo) : eventos;
  return filtrados.slice(0, limite);
}

// Estructura: { noticias: { [id]: registro }, meta: { ... } }
function cargar() {
  try { return JSON.parse(fs.readFileSync(MEM_PATH, 'utf8')); }
  catch (_) { return { noticias: {}, meta: { creada: new Date().toISOString(), ciclos: 0 } }; }
}
function guardar(mem) {
  mem.meta = mem.meta || {};
  mem.meta.actualizada = new Date().toISOString();
  fs.writeFileSync(MEM_PATH, JSON.stringify(mem, null, 2), 'utf8');
}

/**
 * Huella de una noticia: cambia si el contenido relevante cambió
 * (título, nº de fuentes independientes, puntaje). Sirve para detectar updates.
 */
function huella(item) {
  const t = (item.titulo || '').trim().toLowerCase();
  const f = item.fuentes_independientes || 1;
  const p = item.prioridad?.puntaje ?? item.puntaje ?? 0;
  return `${t}::${f}::${Math.round(p)}`;
}

/**
 * Clasifica un corpus priorizado contra la memoria.
 * Devuelve cada item con _estado_memoria: 'nuevo' | 'actualizado' | 'visto'
 * y marca _alta_prioridad_nueva si es nuevo y supera el umbral RUINE.
 */
function clasificarContraMemoria(items, opciones = {}) {
  const umbralAlerta = opciones.umbralAlerta ?? 70; // nivel 'alto'
  const mem = cargar();
  const ahora = new Date().toISOString();
  const resultado = [];
  let nuevos = 0, actualizados = 0, vistos = 0, alertas = 0;

  for (const item of items) {
    const id = item.id_noticia || item.id || item.representante_id;
    if (!id) { resultado.push({ ...item, _estado_memoria: 'nuevo' }); continue; }

    const h = huella(item);
    const previo = mem.noticias[id];
    const puntaje = item.prioridad?.puntaje ?? item.puntaje ?? 0;
    let estado;

    if (!previo) {
      estado = 'nuevo';
      nuevos++;
    } else if (previo.huella !== h) {
      estado = 'actualizado';
      actualizados++;
    } else {
      estado = 'visto';
      vistos++;
    }

    const esAltaPrioridadNueva = estado === 'nuevo' && puntaje >= umbralAlerta;
    if (esAltaPrioridadNueva) {
      alertas++;
      registrarEvento('alerta', `🔴 Nueva noticia de ALTA prioridad: ${item.titulo}`, {
        id, puntaje: Math.round(puntaje), modo: opciones.modo || null,
      });
    } else if (estado === 'nuevo') {
      registrarEvento('nueva', `🆕 Nueva noticia detectada: ${item.titulo}`, {
        id, puntaje: Math.round(puntaje), modo: opciones.modo || null,
      });
    }

    // Actualizar memoria (preserva decisión del editor y ficha previa)
    mem.noticias[id] = {
      id,
      huella: h,
      titulo: item.titulo,
      puntaje,
      primera_vez: previo?.primera_vez || ahora,
      ultima_vez: ahora,
      veces_visto: (previo?.veces_visto || 0) + 1,
      estado_editor: previo?.estado_editor || null, // decisión humana recordada
      ficha_cacheada: previo?.ficha_cacheada || null,
    };

    resultado.push({
      ...item,
      _estado_memoria: estado,
      _alta_prioridad_nueva: esAltaPrioridadNueva,
      _veces_visto: mem.noticias[id].veces_visto,
      _primera_vez: mem.noticias[id].primera_vez,
      estado_editor_recordado: mem.noticias[id].estado_editor,
    });
  }

  mem.meta.ciclos = (mem.meta.ciclos || 0) + 1;
  mem.meta.ultimo_ciclo = { ts: ahora, nuevos, actualizados, vistos, alertas };
  guardar(mem);

  return {
    items: resultado,
    resumen: { nuevos, actualizados, vistos, alertas, total: items.length, ciclo: mem.meta.ciclos },
  };
}

/** Recupera una ficha cacheada en memoria (evita re-gastar IA). */
function obtenerFichaCacheada(id) {
  const mem = cargar();
  return mem.noticias[id]?.ficha_cacheada || null;
}

/** Guarda la ficha generada para reusarla en próximos ciclos. */
function guardarFichaCacheada(id, ficha) {
  if (!id) return;
  const mem = cargar();
  if (!mem.noticias[id]) mem.noticias[id] = { id, primera_vez: new Date().toISOString(), veces_visto: 0 };
  mem.noticias[id].ficha_cacheada = ficha;
  guardar(mem);
}

/** Recuerda la decisión del editor (nuevo/en_revision/aprobado/descartado). */
function recordarDecisionEditor(id, estado, revisor = 'editor') {
  if (!id) return;
  const mem = cargar();
  if (!mem.noticias[id]) mem.noticias[id] = { id, primera_vez: new Date().toISOString(), veces_visto: 0 };
  mem.noticias[id].estado_editor = estado;
  guardar(mem);
  const etiquetas = {
    en_revision: '👁 en revisión', aprobado_como_borrador: '✅ aprobado como borrador',
    requiere_evidencia: '⚠ requiere evidencia', descartado: '🗑 descartado', nuevo: '🆕 nuevo',
  };
  registrarEvento('decision', `${revisor} marcó una noticia: ${etiquetas[estado] || estado}`, {
    id, estado, titulo: mem.noticias[id].titulo,
  });
}

/** Estado de la memoria (para panel/diagnóstico). */
function estadoMemoria() {
  const mem = cargar();
  const total = Object.keys(mem.noticias).length;
  const descartadas = Object.values(mem.noticias).filter(n => n.estado_editor === 'descartado').length;
  const aprobadas = Object.values(mem.noticias).filter(n => n.estado_editor === 'aprobado_como_borrador').length;
  return {
    total_recordadas: total,
    descartadas,
    aprobadas,
    ciclos: mem.meta?.ciclos || 0,
    ultimo_ciclo: mem.meta?.ultimo_ciclo || null,
  };
}

/** Limpia la memoria (reset para empezar de cero). */
function reiniciarMemoria() {
  guardar({ noticias: {}, meta: { creada: new Date().toISOString(), ciclos: 0 } });
}

module.exports = {
  clasificarContraMemoria,
  obtenerFichaCacheada,
  guardarFichaCacheada,
  recordarDecisionEditor,
  estadoMemoria,
  reiniciarMemoria,
  registrarEvento,
  obtenerEventos,
  huella,
};
