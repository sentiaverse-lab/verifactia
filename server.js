'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { ejecutarPipeline, ejecutarAmbasModalidades, actualizarRevision, ESTADOS } = require('./lib/pipeline');
const scheduler = require('./lib/scheduler');
const { estadoAlertas, notificarAlertas } = require('./lib/alerts');
const { estadoMemoria, obtenerEventos, recordarDecisionEditor, reiniciarMemoria } = require('./lib/memory');

const app = express();
const PORT = process.env.PORT || 4800;

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cache del último resultado para el frontend
let cacheResultado = { tvn: null, banca: null };
let corriendo = { tvn: false, banca: false };

// El scheduler ejecuta el pipeline y refresca la caché del frontend
scheduler.configurarEjecutor(async (opts) => {
  const r = await ejecutarPipeline(opts);
  cacheResultado[opts.modo] = r;
  return r;
});

// ── Salud ────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const { IA_HABILITADA } = require('./lib/generator');
  res.json({ ok: true, ia: IA_HABILITADA, ts: Date.now() });
});

// ── Ejecutar pipeline ────────────────────────────────────────────
app.post('/api/pipeline/run', async (req, res) => {
  const modo = req.body.modo === 'banca' ? 'banca' : 'tvn';
  const topN = Math.min(parseInt(req.body.topN) || 10, 20);
  if (corriendo[modo]) return res.json({ ok: false, msg: `Pipeline ${modo} ya está corriendo` });
  corriendo[modo] = true;
  res.json({ ok: true, msg: `Pipeline ${modo} iniciado (topN=${topN})` });
  try {
    const r = await ejecutarPipeline({ modo, topN, cache: req.body.cache !== false });
    cacheResultado[modo] = r;
  } catch (e) { console.error('[server] pipeline error:', e.message); }
  finally { corriendo[modo] = false; }
});

// ── Ejecutar AMBAS modalidades con ingesta compartida (Opción B) ──
app.post('/api/pipeline/run-all', async (req, res) => {
  const topN = Math.min(parseInt(req.body.topN) || 10, 20);
  if (corriendo.tvn || corriendo.banca) return res.json({ ok: false, msg: 'Pipeline ya está corriendo' });
  corriendo.tvn = true; corriendo.banca = true;
  res.json({ ok: true, msg: `Ingesta compartida → TVN + Banca (topN=${topN})` });
  try {
    const r = await ejecutarAmbasModalidades({ topN });
    cacheResultado.tvn = r.tvn;
    cacheResultado.banca = r.banca;
  } catch (e) { console.error('[server] run-all error:', e.message); }
  finally { corriendo.tvn = false; corriendo.banca = false; }
});

// ── Estado del pipeline ──────────────────────────────────────────
app.get('/api/pipeline/status', (_req, res) => {
  res.json({
    tvn: { corriendo: corriendo.tvn, tieneResultado: !!cacheResultado.tvn, fichas: cacheResultado.tvn?.fichas_generadas || 0, duracion: cacheResultado.tvn?.duracion_seg },
    banca: { corriendo: corriendo.banca, tieneResultado: !!cacheResultado.banca, fichas: cacheResultado.banca?.fichas_generadas || 0, duracion: cacheResultado.banca?.duracion_seg },
  });
});

// ── Bandeja priorizada ───────────────────────────────────────────
app.get('/api/bandeja', (req, res) => {
  const modo = req.query.modo === 'banca' ? 'banca' : 'tvn';
  const r = cacheResultado[modo];
  if (!r) return res.json({ ok: false, msg: 'Sin datos. Ejecuta el pipeline primero.' });
  res.json({
    ok: true, modo, timestamp: r.timestamp, ia: r.ia_habilitada,
    duracion_seg: r.duracion_seg,
    total: r.total_priorizadas,
    distribucion_temas: r.distribucion_temas,
    snapshot_economico: r.snapshot_economico,
    grupos_con_duplicados: r.grupos_con_duplicados,
    bandeja: r.bandeja_priorizada,
  });
});

// ── Ficha individual (genera on-demand si no está en el top-N) ───
app.get('/api/ficha/:id', async (req, res) => {
  const modo = req.query.modo === 'banca' ? 'banca' : 'tvn';
  const r = cacheResultado[modo];
  if (!r) return res.status(404).json({ ok: false, msg: 'Sin datos. Ejecuta el pipeline primero.' });

  // 1) ¿Ya existe la ficha generada?
  let ficha = r.fichas?.find(f => f.id_caso === req.params.id || f.noticia?.titulo?.includes(req.params.id));
  if (ficha) return res.json({ ok: true, ficha });

  // 2) ¿Está en la bandeja pero sin ficha? → generarla al vuelo
  const item = r.bandeja_priorizada?.find(n => n.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, msg: 'Noticia no encontrada en la bandeja.' });

  try {
    const { generarFichaIndividual } = require('./lib/pipeline');
    ficha = await generarFichaIndividual(item, r.indicadores || [], modo);
    // Cachear para próximas visitas
    if (r.fichas) r.fichas.push(ficha);
    return res.json({ ok: true, ficha, generada_on_demand: true });
  } catch (e) {
    console.error('[server] ficha on-demand error:', e.message);
    return res.status(500).json({ ok: false, msg: 'No se pudo generar la ficha: ' + e.message });
  }
});

// ── Human-in-the-loop: actualizar estado ────────────────────────
app.post('/api/revision', (req, res) => {
  const { id, estado, nota, revisor } = req.body || {};
  if (!id || !estado) return res.status(400).json({ ok: false, msg: 'Falta id o estado.' });
  if (!Object.values(ESTADOS).includes(estado)) return res.status(400).json({ ok: false, msg: `Estado inválido. Usa: ${Object.values(ESTADOS).join(', ')}` });
  const rev = actualizarRevision(id, estado, nota || '', revisor || 'editor');
  recordarDecisionEditor(id, estado, revisor || 'editor'); // memoria + histórico
  // Actualizar en caché
  ['tvn', 'banca'].forEach(m => {
    if (cacheResultado[m]?.fichas) {
      const f = cacheResultado[m].fichas.find(f => f.id_caso === id);
      if (f) f.estado_revision = estado;
    }
  });
  res.json({ ok: true, revision: rev });
});

// ── Consulta libre (anti-alucinación: si no hay respuesta → abstenerse) ──
app.post('/api/consulta', async (req, res) => {
  const { pregunta, modo } = req.body || {};
  if (!pregunta) return res.status(400).json({ ok: false, msg: 'Falta pregunta.' });
  const m = modo === 'banca' ? 'banca' : 'tvn';
  const r = cacheResultado[m];
  if (!r) return res.json({ ok: true, respuesta: 'No hay datos cargados aún. Ejecuta el pipeline primero.', abstension: true });

  const { normalizar, terminoEnTexto, conceptoEnTexto } = require('./lib/fuzzy');
  const bandeja = r.bandeja_priorizada || [];
  const snap = r.snapshot_economico || {};
  const q = normalizar(pregunta); // sin acentos, minúsculas

  // ── Caso 0: pregunta CONCEPTUAL sobre el contexto del propio sistema ──
  // (ciclo histórico, tendencias, clima, RUINE) → se responde con datos reales + definición factual.
  const cCiclo = conceptoEnTexto(['ciclo', 'historico', 'kondratiev', 'dalio', 'otono', 'otoño', 'primavera', 'verano', 'invierno', 'fase'], q);
  const cRuine = conceptoEnTexto(['ruine', 'formula', 'puntaje', 'priorizacion', 'como se calcula', 'indice'], q);
  const cTendencia = conceptoEnTexto(['tendencia', 'sismica', 'sismos', 'solar', 'temperatura', 'clima', 'lluvia'], q);

  if (cCiclo && snap.ciclo_historico) {
    const c = snap.ciclo_historico, k = c.kondratiev || {}, mac = c.macro || {};
    const defEstacion = {
      'Primavera': 'expansión tras el reset del ciclo; la innovación tecnológica se difunde y la economía se recupera',
      'Verano': 'crecimiento con presión inflacionaria',
      'Otoño': 'auge y especulación, con desinflación; etapa tardía del ciclo antes del enfriamiento',
      'Invierno': 'desapalancamiento y depuración (el "reset" del ciclo)',
    };
    const est = k.estacion || '';
    const respuesta = `El ciclo histórico es un marco de contexto económico (no una predicción). Según la onda de Kondratiev, el ciclo vigente comenzó alrededor de ${k.inicio_ciclo} y hoy estamos en la estación "${est}" (año ${k.anio_ciclo} del ciclo, ${k.posicion_pct}% recorrido). "${est}" significa: ${defEstacion[est] || k.descripcion || 'etapa del ciclo económico'}. La lectura macro actual con datos del Banco Mundial es "${mac.configuracion}". ${c.disclaimer} Fuente: ${(c.marcos_referencia || []).join('; ')}.`;
    return res.json({ ok: true, respuesta, abstension: false, tipo: 'conceptual', evidencia: [] });
  }
  if (cRuine) {
    const respuesta = `El Índice RUINE prioriza cada noticia con la fórmula P = 30·R + 25·I + 20·U + 15·N + 10·E (escala 0 a 100), donde R=Relevancia, I=Impacto, U=Urgencia, N=Novedad, E=Evidencia. Niveles: alto (70-100), medio (40-69), bajo (0-39). Cada noticia expone sus 5 componentes para total transparencia. Un puntaje alto NO publica automáticamente: abre un estado de revisión para el editor humano.`;
    return res.json({ ok: true, respuesta, abstension: false, tipo: 'conceptual', evidencia: [] });
  }
  if (cTendencia && snap.tendencias) {
    const t = snap.tendencias; const partes = [];
    if (t.sismica) partes.push(`Sismicidad cerca de Panamá: ${t.sismica.actual} sismos en los últimos ${t.sismica.ventana_dias} días vs ${t.sismica.promedio_historico} de promedio histórico (${t.sismica.tendencia.etiqueta}).`);
    if (t.solar && !t.solar.error) partes.push(`Actividad solar: ${t.solar.ssn_actual} manchas vs ${t.solar.ssn_hace_12m} hace un año (${t.solar.tendencia.etiqueta}).`);
    if (t.temperatura && t.temperatura.media_actual != null) partes.push(`Temperatura en Ciudad de Panamá: ${t.temperatura.media_actual}°C vs ${t.temperatura.media_historica}°C histórico (${t.temperatura.tendencia.etiqueta}).`);
    partes.push('Son datos de contexto independientes, con fuente citada; no son predicción.');
    return res.json({ ok: true, respuesta: partes.join(' '), abstension: false, tipo: 'conceptual', evidencia: [] });
  }

  // ── Caso 1: pregunta ANALÍTICA/AGREGADA (tolerante a erratas) ──
  // Cada concepto se compara de forma difusa, así "temaz", "activs", "prioridd" cuentan.
  const cTema     = conceptoEnTexto(['tema', 'temas', 'categoria', 'activos', 'distribucion', 'panorama', 'resumen'], q);
  const cPrioridad = conceptoEnTexto(['prioridad', 'urgente', 'importante', 'destacado', 'alta', 'critico', 'relevante'], q);
  const cCuales   = conceptoEnTexto(['cuales', 'cuantos', 'cuantas', 'top', 'principales', 'mejores'], q);
  if (cTema || cPrioridad || cCuales) {
    const temas = r.distribucion_temas || {};
    const temasOrden = Object.entries(temas).sort((a, b) => b[1] - a[1]);
    const alto = bandeja.filter(n => n.nivel === 'alto');
    const alertas = bandeja.filter(n => n.alta_prioridad_nueva);
    const top3 = bandeja.slice(0, 3);

    let partes = [];
    if ((cTema || cCuales) && temasOrden.length) {
      const top = temasOrden.slice(0, 5).map(([t, n]) => `${t.replace(/_/g, ' ')} (${n})`).join(', ');
      partes.push(`Temas más activos: ${top}.`);
    }
    if (cPrioridad) {
      partes.push(`Hay ${alto.length} noticia(s) de prioridad alta` + (alertas.length ? ` y ${alertas.length} alerta(s) nueva(s) de alta prioridad.` : '.'));
    }
    if (top3.length) {
      partes.push(`Top por Índice RUINE: ` + top3.map((n, i) => `${i + 1}) ${n.titulo} (${Math.round(n.puntaje)}/${n.nivel})`).join('; ') + '.');
    }
    const respuesta = partes.join(' ') || 'No hay suficientes datos agregados para responder.';
    return res.json({
      ok: true, respuesta, abstension: false, tipo: 'analitica',
      evidencia: top3.map(n => ({ id: n.id, titulo: n.titulo, puntaje: n.puntaje })),
    });
  }

  // ── Caso 2: pregunta sobre un HECHO (matching difuso tolerante a erratas) ──
  const stop = new Set(['para','porque','sobre','donde','cuando','como','cual','cuales','entre','desde','hasta','pero','mas','los','las','una','unos','unas','que','del','con','por','the','and','paso','pasa','hubo','sucede','ultimo','ultimas','noticia','noticias']);
  const terminos = q.split(' ').filter(t => t.length > 3 && !stop.has(t));
  const relacionadas = bandeja.filter(n => {
    const texto = `${n.titulo || ''} ${(n.tema || '').replace(/_/g, ' ')}`;
    return terminos.some(t => terminoEnTexto(t, texto)); // difuso: tolera plural/acentos/erratas
  }).slice(0, 6);

  if (!relacionadas.length) {
    return res.json({ ok: true, respuesta: `ABSTENCIÓN: No se encontraron noticias en el corpus que respondan a "${pregunta}". No se puede generar una respuesta sin evidencia. Prueba reformular o preguntar por un tema (economía, canal, seguridad...).`, abstension: true, evidencia: [] });
  }

  // Responder con evidencia e IA
  const { llamarIA } = require('./lib/generator');
  const contexto = relacionadas.map(n => `[${n.id}] ${n.titulo} (${n.medio}, ${n.fecha?.slice(0,10)}, tema: ${n.tema}, puntaje: ${n.puntaje})`).join('\n');
  const prompt = `Responde la pregunta SOLO con base en las noticias del corpus. Cita los títulos relevantes. Si de verdad no hay respuesta, di "ABSTENCIÓN: [motivo]".
Pregunta: ${pregunta}
Corpus relevante:\n${contexto}`;

  const resp = await llamarIA([
    { role: 'system', content: 'Eres VerifactIA. NUNCA inventas datos. Respondes con base en el corpus dado. Si no hay evidencia, te abstienes.' },
    { role: 'user', content: prompt },
  ], 600);

  const esAbstencion = !resp || resp.includes('ABSTENCIÓN') || resp.includes('ABSTENCION');
  res.json({ ok: true, respuesta: resp || 'ABSTENCIÓN: No se pudo generar respuesta.', abstension: esAbstencion, evidencia: relacionadas.map(n => ({ id: n.id, titulo: n.titulo, puntaje: n.puntaje })) });
});

// ── Exportación general de la bandeja (JSON / CSV) para integración ──
app.get('/api/export', (req, res) => {
  const modo = req.query.modo === 'banca' ? 'banca' : 'tvn';
  const formato = (req.query.formato || 'json').toLowerCase();
  const r = cacheResultado[modo];
  if (!r) return res.status(404).json({ ok: false, msg: 'Sin datos. Ejecuta el pipeline primero.' });

  const filas = (r.bandeja_priorizada || []).map(n => ({
    id: n.id,
    titulo: n.titulo,
    prioridad_ruine: n.puntaje,
    nivel: n.nivel,
    tema: n.tema,
    estado_evidencia: n.estado_evidencia,
    fuentes_independientes: n.fuentes_independientes,
    fuente_url: n.url || '',
    fecha_publicacion: n.fecha || '',
    medio: n.medio || '',
  }));

  if (formato === 'csv') {
    const campos = Object.keys(filas[0] || { id: '', titulo: '' });
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [campos.join(','), ...filas.map(f => campos.map(c => esc(f[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifactia_${modo}_${Date.now()}.csv"`);
    return res.send('\ufeff' + csv); // BOM para que Excel lea acentos
  }

  // JSON estandarizado (lo que un middleware SAP/ETL/panel consumiría)
  res.json({
    fuente: 'VerifactIA',
    modalidad: modo,
    generado: r.timestamp,
    total: filas.length,
    boletines: filas,
  });
});

// ── Exportar un guion/ficha individual en formato editable (TXT) ──
app.get('/api/export/ficha/:id', (req, res) => {
  const modo = req.query.modo === 'banca' ? 'banca' : 'tvn';
  const r = cacheResultado[modo];
  if (!r) return res.status(404).json({ ok: false, msg: 'Sin datos.' });
  const f = (r.fichas || []).find(x => x.id_caso === req.params.id);
  if (!f) return res.status(404).json({ ok: false, msg: 'Ficha no encontrada (ábrela primero para generarla).' });

  const b = f.borrador || {};
  const guion = b.guion_45_60s || b.resumen || b.brief?.resumen || '';
  const L = []; // documento editorial en texto plano, editable en Word/Docs
  L.push('════════════════════════════════════════════');
  L.push(`VERIFACTIA — ${modo === 'banca' ? 'BOLETÍN ECONÓMICO' : 'GUION PARA TV'} (BORRADOR, requiere revisión)`);
  L.push('════════════════════════════════════════════');
  L.push('');
  L.push(`TÍTULO: ${f.noticia?.titulo || ''}`);
  L.push(`FUENTE: ${f.noticia?.medio || ''}  ${f.noticia?.url || ''}`);
  L.push(`PUBLICADA: ${f.noticia?.fecha || 's/f'}`);
  L.push(`PRIORIDAD RUINE: ${f.prioridad?.puntaje} (${f.prioridad?.nivel})`);
  L.push(`ESTADO DE REVISIÓN: ${f.estado_revision || 'nuevo'}`);
  L.push('');
  L.push('── QUÉ SE REPORTA ──');
  L.push(f.ficha?.que_se_reporta || '');
  L.push('');
  if (f.ficha?.que_esta_respaldado?.length) {
    L.push('── RESPALDADO POR EVIDENCIA ──');
    f.ficha.que_esta_respaldado.forEach(x => L.push('  • ' + x));
    L.push('');
  }
  if (f.ficha?.que_falta_comprobar?.length) {
    L.push('── FALTA VERIFICAR (antes de publicar) ──');
    f.ficha.que_falta_comprobar.forEach(x => L.push('  ⚠ ' + x));
    L.push('');
  }
  L.push(modo === 'banca' ? '── BOLETÍN ──' : '── GUION 45-60s (para el oído) ──');
  L.push(guion);
  L.push('');
  if (b.copy_digital) { L.push('── COPY DIGITAL ──'); L.push(b.copy_digital); L.push(''); }
  L.push('────────────────────────────────────────────');
  L.push(`Generado por VerifactIA · ${f.ficha?.timestamp || f.timestamp || ''}`);
  L.push('ESTE ES UN BORRADOR. La decisión editorial final es humana.');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="guion_${(req.params.id || 'ficha').slice(0, 30)}.txt"`);
  res.send(L.join('\r\n'));
});

// ── Scheduler (vigilancia programada) ────────────────────────────
app.post('/api/scheduler/start', (req, res) => {
  const modo = req.body.modo === 'banca' ? 'banca' : 'tvn';
  const tipo = req.body.tipo === 'horas' ? 'horas' : 'intervalo';
  const config = {
    modo, tipo,
    segundos: parseInt(req.body.segundos, 10) || 1800,
    horas: Array.isArray(req.body.horas) ? req.body.horas : [],
    topN: parseInt(req.body.topN, 10) || 0, // 0 = ligero (solo detectar/priorizar)
  };
  const est = scheduler.iniciar(config);
  res.json({ ok: true, scheduler: est });
});

app.post('/api/scheduler/stop', (req, res) => {
  const modo = req.body.modo === 'banca' ? 'banca' : 'tvn';
  res.json({ ok: true, scheduler: scheduler.detener(modo) });
});

// Prueba de alerta: envía un email de muestra al editor (para demo / verificar SMTP)
app.post('/api/alerta/prueba', async (req, res) => {
  const modo = req.body.modo === 'banca' ? 'banca' : 'tvn';
  const r = cacheResultado[modo];
  const ejemplo = r?.bandeja_priorizada?.[0];
  const alerta = ejemplo
    ? [{ id: ejemplo.id, titulo: ejemplo.titulo, puntaje: ejemplo.puntaje, nivel: ejemplo.nivel, medio: ejemplo.medio, fecha: ejemplo.fecha, componentes: ejemplo.componentes }]
    : [{ id: 'demo', titulo: 'Noticia de prueba de alerta VerifactIA', puntaje: 80, nivel: 'alto', medio: 'VerifactIA', fecha: new Date().toISOString(), componentes: { R: 1, I: 0.8, U: 1, N: 0.7, E: 0.6 } }];
  const resultado = await notificarAlertas(alerta, modo);
  res.json({ ok: true, resultado, estado: estadoAlertas() });
});

app.get('/api/scheduler/status', (_req, res) => {
  res.json({ ok: true, scheduler: scheduler.estadoScheduler(), alertas: estadoAlertas() });
});

// ── Histórico / feed de eventos (bitácora de auditoría) ──────────
app.get('/api/eventos', (req, res) => {
  const limite = Math.min(parseInt(req.query.limite, 10) || 100, 500);
  const modo = req.query.modo === 'tvn' || req.query.modo === 'banca' ? req.query.modo : null;
  res.json({ ok: true, eventos: obtenerEventos(limite, modo), memoria: estadoMemoria() });
});

// ── Estado de memoria ────────────────────────────────────────────
app.get('/api/memoria', (_req, res) => res.json({ ok: true, memoria: estadoMemoria() }));
app.post('/api/memoria/reset', (_req, res) => { reiniciarMemoria(); res.json({ ok: true, msg: 'Memoria reiniciada.' }); });

// ── Fallback SPA ─────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`VerifactIA corriendo en http://localhost:${PORT}`);
  const { IA_HABILITADA } = require('./lib/generator');
  console.log(`IA ${IA_HABILITADA ? 'HABILITADA' : 'modo baseline'}`);
});
