'use strict';
/**
 * VerifactIA — Pipeline orquestador principal.
 * Conecta: ingest → clasificar → agrupar → cruzar → priorizar → ficha → borrador → human-in-the-loop
 * Modalidad: 'tvn' | 'banca'
 */

const fs = require('fs');
const path = require('path');
const { ingestarTodo } = require('./ingest');
const { clasificarConIA, clasificarBaseline, agruparDuplicados, esRelevanteBanca } = require('./classifier');
const { priorizar, cruzarConIndicadores } = require('./prioritizer');
const { generarFicha, generarBorrador, IA_HABILITADA } = require('./generator');
const { construirCicloHistorico } = require('./cycles');
const { clasificarContraMemoria, guardarFichaCacheada, recordarDecisionEditor, estadoMemoria } = require('./memory');
const { calcularTendencias } = require('./trends');
const { climaNacional } = require('./weather');
const { obtenerMercados } = require('./markets');

// Cache de mercados (precios cambian: TTL 10 min)
let _mercadosCache = { data: null, ts: 0 };
const MERCADOS_TTL_MS = 10 * 60 * 1000;
async function obtenerMercadosCache() {
  if (_mercadosCache.data && (Date.now() - _mercadosCache.ts) < MERCADOS_TTL_MS) return _mercadosCache.data;
  try { const m = await obtenerMercados(); _mercadosCache = { data: m, ts: Date.now() }; return m; }
  catch (_) { return _mercadosCache.data; }
}

// Caché de tendencias (cambian lento: TTL 1h). El clima se refresca más seguido (TTL 20min).
let _tendenciasCache = { data: null, ts: 0 };
let _climaCache = { data: null, ts: 0 };
const TENDENCIAS_TTL_MS = 60 * 60 * 1000;
const CLIMA_TTL_MS = 20 * 60 * 1000;
async function obtenerTendencias() {
  const dias = parseInt(process.env.USGS_DIAS || '60', 10);
  // Tendencias (sismos/solar/temperatura) con TTL largo
  let tend = _tendenciasCache.data;
  if (!tend || (Date.now() - _tendenciasCache.ts) >= TENDENCIAS_TTL_MS) {
    try { tend = await calcularTendencias(dias); _tendenciasCache = { data: tend, ts: Date.now() }; }
    catch (_) { tend = _tendenciasCache.data; }
  }
  // Clima multi-ciudad con TTL corto
  let clima = _climaCache.data;
  if (!clima || (Date.now() - _climaCache.ts) >= CLIMA_TTL_MS) {
    try { clima = await climaNacional(); _climaCache = { data: clima, ts: Date.now() }; }
    catch (_) { clima = _climaCache.data; }
  }
  return { ...(tend || {}), _clima: clima || null };
}

const DATA_DIR  = path.join(__dirname, '..', 'data', 'processed');
const FICHAS_DIR = path.join(__dirname, '..', 'data', 'fichas');
[DATA_DIR, FICHAS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Estados del human-in-the-loop ───────────────────────────────
const ESTADOS = {
  NUEVO: 'nuevo',
  EN_REVISION: 'en_revision',
  REQUIERE_EVIDENCIA: 'requiere_evidencia',
  APROBADO_BORRADOR: 'aprobado_como_borrador',
  DESCARTADO: 'descartado',
};

// DB simple de revisiones (JSON en disco)
const REVISIONES_PATH = path.join(__dirname, '..', 'data', 'revisiones.json');
function cargarRevisiones() {
  try { return JSON.parse(fs.readFileSync(REVISIONES_PATH, 'utf8')); } catch (_) { return {}; }
}
function guardarRevisiones(rev) { fs.writeFileSync(REVISIONES_PATH, JSON.stringify(rev, null, 2), 'utf8'); }

function actualizarRevision(id, estado, nota = '', revisor = 'humano') {
  const rev = cargarRevisiones();
  rev[id] = { estado, nota, revisor, timestamp: new Date().toISOString() };
  guardarRevisiones(rev);
  return rev[id];
}

function obtenerEstado(id) {
  const rev = cargarRevisiones();
  return rev[id]?.estado || ESTADOS.NUEVO;
}

// ── Snapshot económico (panel de estadísticas distinto por modo) ──
function construirSnapshotEconomico(indicadores, eventos, modo, tendencias, mercados) {
  // Último valor disponible de cada indicador para Panamá
  const ultimoPAN = (indId) => {
    const filas = (indicadores || [])
      .filter(i => i.pais_iso3 === 'PAN' && i.indicador_id === indId && i.valor !== null && i.valor !== '')
      .sort((a, b) => (b.anio || 0) - (a.anio || 0));
    return filas[0] || null;
  };
  // Comparativo regional (último valor por país) de un indicador
  const regional = (indId) => {
    const porPais = {};
    (indicadores || [])
      .filter(i => i.indicador_id === indId && i.valor !== null && i.valor !== '')
      .forEach(i => {
        if (!porPais[i.pais_iso3] || i.anio > porPais[i.pais_iso3].anio) porPais[i.pais_iso3] = i;
      });
    return Object.values(porPais)
      .map(i => ({ pais: i.pais_iso3, valor: Math.round(i.valor * 100) / 100, anio: i.anio }))
      .sort((a, b) => b.valor - a.valor);
  };

  const fmt = (ind) => ind ? { valor: Math.round(ind.valor * 100) / 100, anio: ind.anio, unidad: ind.unidad } : null;

  if (modo === 'banca') {
    // Enfoque: entorno económico/financiero regional + ciclo histórico
    return {
      titulo: 'Entorno económico regional (Banco Mundial)',
      indicadores_clave: [
        { nombre: 'Crecimiento PIB Panamá', ...fmt(ultimoPAN('NY.GDP.MKTP.KD.ZG')) },
        { nombre: 'Inflación Panamá',        ...fmt(ultimoPAN('FP.CPI.TOTL.ZG')) },
        { nombre: 'Desempleo Panamá',        ...fmt(ultimoPAN('SL.UEM.TOTL.ZS')) },
        { nombre: 'Exportaciones/PIB',       ...fmt(ultimoPAN('NE.EXP.GNFS.ZS')) },
      ].filter(x => x.valor !== undefined),
      comparativo_regional: {
        indicador: 'Inflación (%) — último dato por país',
        datos: regional('FP.CPI.TOTL.ZG'),
      },
      ciclo_historico: construirCicloHistorico(indicadores),
      mercados: mercados || null,
      nota: 'Señales macro que contextualizan los boletines económicos.',
    };
  }

  // TVN editorial: enfoque en cobertura noticiosa + alertas naturales
  // Distancia al centro de Panamá (~8.5N, 80.5W) para separar nacional de regional.
  const distPanamaKm = (e) => {
    if (typeof e.latitude !== 'number' || typeof e.longitude !== 'number') return Infinity;
    const dLat = e.latitude - 8.5, dLng = e.longitude + 80.5;
    return Math.sqrt(dLat * dLat + dLng * dLng) * 111;
  };
  const sismosCercaPanama = (eventos || []).filter(e => distPanamaKm(e) <= 350);
  const sismosRegion = (eventos || []).length;
  const sismosFuertesPanama = sismosCercaPanama.filter(e => (e.magnitude || 0) >= 4.5).length;

  // Período real de la ventana de datos (no un año fijo)
  const dias = parseInt(process.env.USGS_DIAS || '60', 10);
  const periodo = `últimos ${dias} días`;

  return {
    titulo: 'Panorama informativo nacional',
    indicadores_clave: [
      { nombre: 'Sismos cerca de Panamá (≤350 km)', valor: sismosCercaPanama.length, unidad: 'sismos', anio: periodo },
      { nombre: 'Sismos relevantes M≥4.5 (Panamá)',  valor: sismosFuertesPanama, unidad: 'sismos', anio: periodo },
      { nombre: 'Monitoreados en la región',          valor: sismosRegion, unidad: 'sismos', anio: periodo },
      { nombre: 'Crecimiento PIB Panamá',             ...fmt(ultimoPAN('NY.GDP.MKTP.KD.ZG')) },
    ].filter(x => x.valor !== undefined),
    comparativo_regional: null,
    tendencias: tendencias || null,       // sismos / solar / temperatura (datos independientes)
    clima: tendencias?._clima || null,    // bloque multi-ciudad estilo noticiero
    nota: 'Actividad sísmica cercana a Panamá (fuente USGS) y pulso económico. La región incluye países vecinos como contexto.',
  };
}

/**
 * Genera una ficha+borrador individual para una noticia de la bandeja
 * que no entró en el top-N inicial (generación on-demand desde el server).
 */
async function generarFichaIndividual(itemBandeja, indicadores, modo = 'tvn') {
  // Reconstruir el item con la forma que esperan generarFicha/generarBorrador
  const item = {
    id_noticia: itemBandeja.id,
    representante_id: itemBandeja.id,
    titulo: itemBandeja.titulo,
    url: itemBandeja.url,
    medio: itemBandeja.medio,
    fecha_publicacion: itemBandeja.fecha,
    tema: itemBandeja.tema,
    fuentes_independientes: itemBandeja.fuentes_independientes || 1,
    tiene_indicador_relacionado: false,
    prioridad: {
      puntaje: itemBandeja.puntaje,
      nivel: itemBandeja.nivel,
      estado_evidencia: itemBandeja.estado_evidencia,
      componentes: itemBandeja.componentes,
      alerta: itemBandeja.alerta,
    },
  };

  const ficha = await generarFicha(item, indicadores, modo);
  const borrador = await generarBorrador(item, ficha, modo);

  const estadoHITL = ficha.estado_evidencia === 'insuficiente' ? ESTADOS.REQUIERE_EVIDENCIA : ESTADOS.NUEVO;
  const revisiones = cargarRevisiones();
  if (!revisiones[item.id_noticia]) {
    actualizarRevision(item.id_noticia, estadoHITL, 'Generado on-demand por VerifactIA');
  }

  return {
    id_caso: item.id_noticia,
    modalidad: modo,
    posicion_ranking: itemBandeja.posicion,
    noticia: { titulo: item.titulo, url: item.url, medio: item.medio, fecha: item.fecha_publicacion, tema: item.tema },
    prioridad: item.prioridad,
    ficha,
    borrador,
    estado_revision: revisiones[item.id_noticia]?.estado || estadoHITL,
    timestamp: new Date().toISOString(),
  };
}

// ── Pipeline completo ────────────────────────────────────────────
async function ejecutarPipeline(opciones = {}) {
  const modo = opciones.modo || 'tvn'; // 'tvn' | 'banca'
  const topN = opciones.topN || 10;    // cuántas noticias procesar a fondo
  const usarDatosCacheados = opciones.cache || false;

  console.log(`\n[VerifactIA] ═══ Pipeline ${modo.toUpperCase()} ═══`);
  const inicio = Date.now();

  // ── Etapa 1: Cargar datos ─────────────────────────────────────
  let datos;
  const cachePath = path.join(DATA_DIR, 'cache_ingest.json');
  if (usarDatosCacheados && fs.existsSync(cachePath)) {
    console.log('[1/6] Cargando datos desde caché...');
    datos = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } else {
    console.log('[1/6] Ingestando datos desde APIs públicas...');
    datos = await ingestarTodo();
    fs.writeFileSync(cachePath, JSON.stringify(datos), 'utf8');
  }

  const { noticias, indicadores, eventos } = datos;
  console.log(`      ${noticias.length} noticias | ${indicadores.length} indicadores | ${eventos.length} sismos`);

  // Reporte de calidad de datos (T01 del reto)
  const reporteCalidad = {
    total_noticias: noticias.length,
    con_url: noticias.filter(n => n.url).length,
    con_fecha: noticias.filter(n => n.fecha_publicacion).length,
    sin_titulo: noticias.filter(n => !n.titulo).length,
    fuentes: [...new Set(noticias.map(n => n.origen))],
  };
  console.log(`      Calidad: ${reporteCalidad.con_url}/${noticias.length} con URL, ${reporteCalidad.sin_titulo} sin título`);

  // ── Etapa 2: Clasificar (según modalidad) ─────────────────────
  console.log(`[2/6] Clasificando noticias (taxonomía ${modo})...`);
  let noticiasClasificadas = noticias.map(n => ({
    ...n,
    tema: clasificarBaseline(n.titulo, n.descripcion || '', modo),
    clasificacion_fuente: 'baseline',
  }));

  // En modo banca: filtrar a señales económico/financieras (descarta deportes/farándula)
  if (modo === 'banca') {
    const antes = noticiasClasificadas.length;
    noticiasClasificadas = noticiasClasificadas.filter(n => esRelevanteBanca(n.titulo, n.descripcion || ''));
    console.log(`      Filtro banca: ${noticiasClasificadas.length}/${antes} noticias con señal económica`);
  }

  const distribucionTemas = {};
  noticiasClasificadas.forEach(n => { distribucionTemas[n.tema] = (distribucionTemas[n.tema] || 0) + 1; });
  console.log('      Temas:', JSON.stringify(distribucionTemas));

  // ── Etapa 3: Agrupar duplicados ──────────────────────────────
  console.log('[3/6] Agrupando noticias duplicadas (Jaccard)...');
  const grupos = agruparDuplicados(noticiasClasificadas);
  const conDuplicados = grupos.filter(g => g.n_articulos > 1).length;
  console.log(`      ${grupos.length} grupos (${conDuplicados} con duplicados)`);

  // Enriquecer grupos con info de noticias
  const mapaNoticia = {};
  noticiasClasificadas.forEach(n => { mapaNoticia[n.id_noticia] = n; });

  const gruposEnriquecidos = grupos.map(g => {
    const rep = mapaNoticia[g.representante_id] || noticiasClasificadas[0];
    return {
      ...rep, ...g,
      id_noticia: g.representante_id,
      fuentes_independientes: g.fuentes_independientes,
    };
  });

  // ── Etapa 4: Cruzar con indicadores ─────────────────────────
  console.log('[4/6] Cruzando con indicadores del Banco Mundial...');
  const conIndicadores = cruzarConIndicadores(gruposEnriquecidos, indicadores);
  const cruzados = conIndicadores.filter(n => n.tiene_indicador_relacionado).length;
  console.log(`      ${cruzados} noticias cruzadas con indicadores económicos`);

  // ── Etapa 5: Priorizar ────────────────────────────────────────
  console.log('[5/6] Priorizando con fórmula RUINE...');
  let priorizadas = priorizar(conIndicadores, modo);

  // Memoria: marcar nuevo/actualizado/visto, detectar alertas y respetar descartes del editor
  const mem = clasificarContraMemoria(priorizadas, { umbralAlerta: 70 });
  priorizadas = mem.items.filter(n => n.estado_editor_recordado !== 'descartado'); // no re-subir lo descartado
  console.log(`      Memoria: ${mem.resumen.nuevos} nuevas, ${mem.resumen.actualizados} actualizadas, ${mem.resumen.vistos} ya vistas` +
    (mem.resumen.alertas ? ` · 🔴 ${mem.resumen.alertas} ALERTA(S) alta prioridad` : ''));

  const top5 = priorizadas.slice(0, 5).map(n => `${n.prioridad?.puntaje?.toFixed(1)} [${n.prioridad?.nivel}] ${n.titulo?.slice(0, 60)}`);
  console.log('      Top 5:');
  top5.forEach((t, i) => console.log(`        ${i+1}. ${t}`));

  // ── Etapa 6: Generar fichas y borradores (top N) ──────────────
  // Máxima paralelización: todas las fichas en una ola, luego todos los borradores
  // en otra ola. 2 olas en vez de N llamadas secuenciales → ~3x más rápido.
  const items = priorizadas.slice(0, Math.min(topN, priorizadas.length));
  console.log(`[6/6] Generando ${items.length} fichas + borradores (2 olas paralelas)...`);
  const revisiones = cargarRevisiones();

  const tGen = Date.now();
  // Ola 1: todas las fichas en paralelo
  const fichasGen = await Promise.all(items.map(item => generarFicha(item, indicadores, modo)));
  // Ola 2: todos los borradores en paralelo (cada uno usa su ficha)
  const borradoresGen = await Promise.all(items.map((item, idx) => generarBorrador(item, fichasGen[idx], modo)));
  console.log(`      ${items.length} fichas+borradores en ${((Date.now() - tGen) / 1000).toFixed(1)}s`);

  const fichas = items.map((item, idx) => {
    const posicion = idx + 1;
    const ficha = fichasGen[idx];
    const borrador = borradoresGen[idx];

    // Estado inicial human-in-the-loop
    const estadoHITL = ficha.estado_evidencia === 'insuficiente'
      ? ESTADOS.REQUIERE_EVIDENCIA
      : ESTADOS.NUEVO;
    if (!revisiones[item.id_noticia]) {
      actualizarRevision(item.id_noticia, estadoHITL, 'Generado automáticamente por VerifactIA');
    }

    const fichaCompleta = {
      id_caso: item.id_noticia || item.representante_id,
      modalidad: modo,
      posicion_ranking: posicion,
      noticia: { titulo: item.titulo, url: item.url, medio: item.medio, fecha: item.fecha_publicacion, tema: item.tema },
      prioridad: item.prioridad,
      ficha,
      borrador,
      estado_revision: revisiones[item.id_noticia]?.estado || estadoHITL,
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(FICHAS_DIR, `ficha_${(item.id_noticia || '').slice(0, 40) || posicion}.json`),
      JSON.stringify(fichaCompleta, null, 2), 'utf8'
    );
    return fichaCompleta;
  });

  // ── fichas.jsonl: contrato de datos del reto (una ficha por línea) ──
  // Campos exigidos: id_caso, modalidad, ids_fuente, afirmaciones, citas,
  // puntaje, componentes, estado_evidencia, borrador, estado_revision.
  try {
    const lineas = fichas.map((f) => JSON.stringify({
      id_caso: f.id_caso,
      modalidad: f.modalidad,
      ids_fuente: f.ficha?.fuentes_usadas || [],
      afirmaciones: f.ficha?.que_esta_respaldado || [],
      citas: f.ficha?.fuentes_usadas || [],
      puntaje: f.prioridad?.puntaje ?? null,
      componentes: f.prioridad?.componentes || null,
      estado_evidencia: f.ficha?.estado_evidencia || null,
      borrador: f.borrador || null,
      estado_revision: f.estado_revision || null,
    }));
    fs.writeFileSync(path.join(FICHAS_DIR, `fichas_${modo}.jsonl`), lineas.join('\n') + '\n', 'utf8');
  } catch (e) { console.error('[pipeline] fichas.jsonl:', e.message); }

  // ── Snapshot económico (distinto por modalidad) ──────────────
  // Tendencias+clima (TVN) / mercados (Banca) — cacheados para no pesar
  const tendencias = modo === 'tvn' ? await obtenerTendencias() : null;
  const mercados = modo === 'banca' ? await obtenerMercadosCache() : null;
  const snapshotEconomico = construirSnapshotEconomico(indicadores, eventos, modo, tendencias, mercados);

  // ── Guardar resultados consolidados ──────────────────────────
  const resultado = {
    modo,
    timestamp: new Date().toISOString(),
    duracion_seg: ((Date.now() - inicio) / 1000).toFixed(1),
    ia_habilitada: IA_HABILITADA,
    reporte_calidad: reporteCalidad,
    distribucion_temas: distribucionTemas,
    snapshot_economico: snapshotEconomico,
    total_grupos: grupos.length,
    grupos_con_duplicados: conDuplicados,
    total_priorizadas: priorizadas.length,
    bandeja_priorizada: priorizadas.slice(0, 20).map((n, i) => ({
      posicion: i + 1,
      id: n.id_noticia,
      titulo: n.titulo,
      url: n.url,
      medio: n.medio,
      fecha: n.fecha_publicacion,
      tema: n.tema,
      puntaje: n.prioridad?.puntaje,
      nivel: n.prioridad?.nivel,
      estado_evidencia: n.prioridad?.estado_evidencia,
      componentes: n.prioridad?.componentes,
      alerta: n.prioridad?.alerta,
      fuentes_independientes: n.fuentes_independientes || 1,
      estado_memoria: n._estado_memoria,            // nuevo | actualizado | visto
      alta_prioridad_nueva: !!n._alta_prioridad_nueva, // 🔴 badge de alerta
      fuente_primaria: !!n.fuente_primaria,
    })),
    fichas_generadas: fichas.length,
    fichas,
    indicadores, // para generación on-demand de fichas fuera del top-N
  };

  fs.writeFileSync(
    path.join(DATA_DIR, `resultado_${modo}_${Date.now()}.json`),
    JSON.stringify(resultado, null, 2), 'utf8'
  );

  console.log(`\n[VerifactIA] Pipeline ${modo.toUpperCase()} completado en ${resultado.duracion_seg}s`);
  console.log(`      IA: ${IA_HABILITADA ? 'HABILITADA' : 'modo baseline'} | Fichas: ${fichas.length} | Top noticias: ${priorizadas.length}`);
  return resultado;
}

/**
 * OPCIÓN B — Ingesta compartida, dos lecturas editoriales.
 * Una sola captura de la realidad (ingesta única) → genera las vistas TVN y Banca
 * desde el MISMO corpus, sin re-descargar. "La inteligencia se produce una vez
 * y se distribuye a cada modalidad."
 */
async function ejecutarAmbasModalidades(opciones = {}) {
  const topN = opciones.topN || 10;
  console.log('\n[VerifactIA] ═══ Ingesta compartida → TVN + Banca ═══');

  // 1) Ingesta ÚNICA: fuerza descarga y escribe el caché compartido
  const inicio = Date.now();
  console.log('[0] Ingesta compartida (una sola vez)...');
  const datos = await ingestarTodo();
  fs.writeFileSync(path.join(DATA_DIR, 'cache_ingest.json'), JSON.stringify(datos), 'utf8');
  console.log(`    Corpus compartido: ${datos.noticias.length} noticias | ${datos.indicadores.length} indicadores | ${datos.eventos.length} sismos`);

  // 2) Dos lecturas desde el MISMO corpus (cache:true → no re-descarga)
  const tvn   = await ejecutarPipeline({ modo: 'tvn',   topN, cache: true });
  const banca = await ejecutarPipeline({ modo: 'banca', topN, cache: true });

  console.log(`[VerifactIA] Ambas modalidades listas en ${((Date.now() - inicio) / 1000).toFixed(1)}s (1 ingesta, 2 vistas)`);
  return { tvn, banca, ingesta_unica: true };
}

module.exports = { ejecutarPipeline, ejecutarAmbasModalidades, generarFichaIndividual, actualizarRevision, obtenerEstado, ESTADOS };
