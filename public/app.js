'use strict';
// VerifactIA — Frontend
// La IA no solo responde: modifica la interfaz en tiempo real (igual que NextBit pero para noticias).

const BASE = '';
let MODO = 'tvn';
let datosBandeja = null;
let temaActivo = null;

// Tema visual por modalidad: TVN = rojo señal, Banca = azul institucional
const TEMA_MODO = {
  tvn:   { accent: '#e94560', rgb: '233, 69, 96',  label: 'TVN MEDIA', icono: '📺',
           grad: 'radial-gradient(1200px 600px at 15% -10%, #2a1430 0%, transparent 55%), radial-gradient(1000px 500px at 110% 10%, #2a0f1a 0%, transparent 50%), linear-gradient(160deg, #0b0b16 0%, #15121f 55%, #1a0d14 100%)',
           sub: 'Modalidad editorial · noticias públicas verificables para TV' },
  banca: { accent: '#2f81f7', rgb: '47, 129, 247', label: 'BANCA', icono: '🏦',
           grad: 'radial-gradient(1200px 600px at 15% -10%, #10233f 0%, transparent 55%), radial-gradient(1000px 500px at 110% 10%, #0d2b3a 0%, transparent 50%), linear-gradient(160deg, #0a0e16 0%, #0f1726 55%, #0b1e2b 100%)',
           sub: 'Boletín económico · entorno macro-financiero regional (Banco Mundial)' },
};

function aplicarTema(modo) {
  const t = TEMA_MODO[modo] || TEMA_MODO.tvn;
  const root = document.documentElement.style;
  root.setProperty('--accent', t.accent);
  root.setProperty('--accent-rgb', t.rgb);
  root.setProperty('--accent-soft', `rgba(${t.rgb}, 0.14)`);
  root.setProperty('--bg-grad', t.grad);
}

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  await checkHealth();
  setModo('tvn'); // aplica tema + carga bandeja TVN (si ya hay datos frescos)
  cargarEventos();
  cargarEstadoSched();
  // Auto-ejecución al abrir la web: si no hay datos (o están viejos), dispara el
  // pipeline solo. Si ya están frescos, no hace nada (no re-ejecuta en cada visita).
  autoEnsurePipeline();
}

// Fases que se muestran mientras corre el pipeline (feedback para que NO parezca congelado)
const FASES_PIPELINE = [
  { t: 0,  icon: '📥', msg: 'Ingiriendo noticias de fuentes públicas…' },
  { t: 6,  icon: '🏷️', msg: 'Clasificando por tema, región y tipo…' },
  { t: 12, icon: '📊', msg: 'Calculando el Índice RUINE (prioridad)…' },
  { t: 20, icon: '✍️', msg: 'Generando fichas de evidencia y borradores…' },
  { t: 30, icon: '🧩', msg: 'Casi listo: ordenando la bandeja priorizada…' },
];

function faseParaSegundos(seg) {
  let f = FASES_PIPELINE[0];
  for (const x of FASES_PIPELINE) { if (seg >= x.t) f = x; }
  return f;
}

function pintarProgreso(seg) {
  const f = faseParaSegundos(seg);
  // progreso estimado (asintótico, nunca llega a 100 hasta que termina de verdad)
  const pct = Math.min(95, Math.round((seg / 35) * 100));
  const statusEl = document.querySelector('#pipelineStatus');
  if (statusEl) {
    statusEl.innerHTML =
      `<div class="flex items-center gap-2 mb-1 pulsing"><span>${f.icon}</span>` +
      `<span class="font-medium">${f.msg}</span><span class="text-slate-500 ml-auto tabular-nums">${seg}s</span></div>` +
      `<div class="h-1.5 rounded-full bg-white/10 overflow-hidden"><div class="h-full accent-bg transition-all duration-500" style="width:${pct}%"></div></div>`;
  }
  const bandejaEl = document.querySelector('#bandeja');
  if (bandejaEl && !bandejaEl.dataset.skelPintado) {
    const skel = Array.from({ length: 5 }).map(() => `
      <div class="glass rounded-xl p-4">
        <div class="flex items-start gap-3">
          <div class="skeleton w-9 h-9 rounded-lg shrink-0"></div>
          <div class="flex-1 space-y-2">
            <div class="skeleton h-3 rounded w-11/12"></div>
            <div class="skeleton h-3 rounded w-2/3"></div>
            <div class="skeleton h-2 rounded w-1/3 mt-1"></div>
          </div>
        </div>
      </div>`).join('');
    bandejaEl.innerHTML =
      `<div class="text-xs accent mb-2 px-1 pulsing">🤖 Preparando bandeja — TVN y Banca se actualizan juntos con la misma ingesta…</div>` + skel;
    bandejaEl.dataset.skelPintado = '1';
  }
}

// Polling con feedback visual (cronómetro + fases + barra). Se usa en la auto-carga.
async function pollingConProgreso() {
  const inicio = Date.now();
  for (let i = 0; i < 90; i++) {
    const seg = Math.round((Date.now() - inicio) / 1000);
    pintarProgreso(seg);
    await new Promise(r => setTimeout(r, 1000));
    // consultar estado cada ~4s para no saturar
    if (i % 4 === 0) {
      try {
        const s = await fetch(`${BASE}/api/pipeline/status`).then(x => x.json());
        const listo = !s.tvn.corriendo && !s.banca.corriendo && s.tvn.tieneResultado && s.banca.tieneResultado;
        if (listo) {
          const bandejaEl = document.querySelector('#bandeja');
          if (bandejaEl) delete bandejaEl.dataset.skelPintado;
          const statusEl = document.querySelector('#pipelineStatus');
          if (statusEl) statusEl.innerHTML = `✅ Bandeja lista (${seg}s)`;
          await cargarBandeja();
          cargarEventos();
          return;
        }
      } catch (_) {}
    }
  }
  // timeout de seguridad: intentar cargar lo que haya
  const bandejaEl = document.querySelector('#bandeja');
  if (bandejaEl) delete bandejaEl.dataset.skelPintado;
  await cargarBandeja();
}

async function autoEnsurePipeline() {
  try {
    const r = await fetch(`${BASE}/api/pipeline/ensure?maxAgeMin=30&topN=6`).then(x => x.json());
    if (r && r.corriendo) {
      // El servidor arrancó el pipeline en background: feedback vivo + esperar.
      await pollingConProgreso();
    } else if (r && r.listo) {
      // Datos ya listos en el servidor (del autostart o caché reciente):
      // setModo corrió antes de que hubiera datos → forzar recarga ahora.
      await cargarBandeja();
      cargarEventos();
    }
  } catch (_) { /* silencioso: no romper la carga si el endpoint no responde */ }
}

async function checkHealth() {
  try {
    const r = await fetch(`${BASE}/api/health`).then(x => x.json());
    const el = document.querySelector('#iaStatus');
    if (el) {
      el.innerHTML = r.ia
        ? `<span class="live-dot"></span><span>IA habilitada</span>`
        : `<span class="w-2 h-2 rounded-full bg-yellow-400"></span><span>Modo baseline</span>`;
      el.className = `flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${r.ia ? 'bg-green-900/30 border-green-400/30 text-green-300' : 'bg-yellow-900/30 border-yellow-400/30 text-yellow-300'}`;
    }
  } catch (_) {}
}

function setModo(modo) {
  MODO = modo;
  temaActivo = null;
  aplicarTema(modo);
  const t = TEMA_MODO[modo];
  const btnTVN = document.querySelector('#btnTVN');
  const btnBanca = document.querySelector('#btnBanca');
  const label = document.querySelector('#modoLabel');
  const sub = document.querySelector('#bandejaSub');
  const base = 'px-4 py-1.5 rounded-lg text-sm font-bold transition flex items-center gap-1.5';
  if (btnTVN) btnTVN.className = `${base} ${modo === 'tvn' ? 'accent-bg text-white shadow' : 'text-slate-400 hover:text-slate-200'}`;
  if (btnBanca) btnBanca.className = `${base} ${modo === 'banca' ? 'accent-bg text-white shadow' : 'text-slate-400 hover:text-slate-200'}`;
  if (label) label.textContent = t.label;
  if (sub) sub.textContent = t.sub;
  cargarBandeja();
  if (typeof cargarEstadoSched === 'function') cargarEstadoSched();
}

// ── Pipeline ─────────────────────────────────────────────────────
async function runPipeline() {
  const btn = document.querySelector('#btnRun');
  const topN = parseInt(document.querySelector('#topNInput')?.value) || 10;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Procesando...'; btn.classList.add('pulsing'); }
  document.querySelector('#pipelineStatus').textContent = `🔄 Ingesta compartida → procesando TVN + Banca (top ${topN})...`;
  const skel = Array.from({ length: 5 }).map(() => `
    <div class="glass rounded-xl p-4">
      <div class="flex items-start gap-3">
        <div class="skeleton w-9 h-9 rounded-lg shrink-0"></div>
        <div class="flex-1 space-y-2">
          <div class="skeleton h-3 rounded w-11/12"></div>
          <div class="skeleton h-3 rounded w-2/3"></div>
          <div class="skeleton h-2 rounded w-1/3 mt-1"></div>
        </div>
      </div>
    </div>`).join('');
  document.querySelector('#bandeja').innerHTML =
    `<div class="text-xs accent mb-1 px-1 pulsing">🤖 Procesando ${topN} noticias con el motor RUINE…</div>` + skel;

  try {
    // Opción B: una sola ingesta alimenta AMBAS modalidades (TVN + Banca)
    await fetch(`${BASE}/api/pipeline/run-all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topN }),
    });
    await polling();
  } catch (e) {
    document.querySelector('#pipelineStatus').textContent = `❌ Error: ${e.message}`;
  }
  if (btn) { btn.disabled = false; btn.textContent = '▶ Ejecutar pipeline'; btn.classList.remove('pulsing'); }
}

async function polling() {
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const s = await fetch(`${BASE}/api/pipeline/status`).then(x => x.json());
    // Espera a que AMBAS modalidades terminen (Opción B)
    const listo = !s.tvn.corriendo && !s.banca.corriendo && s.tvn.tieneResultado && s.banca.tieneResultado;
    if (listo) { await cargarBandeja(); return; }
    const corriendo = s.tvn.corriendo || s.banca.corriendo;
    document.querySelector('#pipelineStatus').textContent = corriendo
      ? `🔄 Procesando TVN + Banca... (${i * 4}s)`
      : '✅ Listo';
  }
}

// ── Bandeja priorizada ────────────────────────────────────────────
async function cargarBandeja() {
  try {
    const r = await fetch(`${BASE}/api/bandeja?modo=${MODO}`).then(x => x.json());
    if (!r.ok) {
      // Sin datos: verificar si el pipeline está corriendo (ambas modalidades usan
      // la misma ingesta — si corre para una, ya viene la otra también).
      const s = await fetch(`${BASE}/api/pipeline/status`).then(x => x.json()).catch(() => null);
      if (s && (s.tvn.corriendo || s.banca.corriendo)) {
        // Ya hay un pipeline en marcha → mostrar progreso en vez de error
        const bandejaEl = document.querySelector('#bandeja');
        if (bandejaEl) delete bandejaEl.dataset.skelPintado;
        await pollingConProgreso();
      } else {
        document.querySelector('#bandeja').innerHTML =
          `<div class="glass rounded-2xl p-6 text-center text-slate-500 text-sm">${r.msg}</div>`;
      }
      return;
    }
    datosBandeja = r;
    renderBandeja(r.bandeja);
    renderStats(r);
    renderFiltros(r.distribucion_temas);
    renderKPIs(r);
    document.querySelector('#pipelineStatus').textContent = `✅ ${r.total} noticias · ${r.grupos_con_duplicados} grupos con duplicados · ${r.duracion_seg}s`;
  } catch (_) {}
}

function renderBandeja(noticias, filtroTema = null) {
  const cont = document.querySelector('#bandeja');
  if (!noticias?.length) { cont.innerHTML = '<div class="glass rounded-2xl p-6 text-center text-slate-500 text-sm">Sin datos</div>'; return; }
  const filtradas = filtroTema ? noticias.filter(n => n.tema === filtroTema) : noticias;
  cont.innerHTML = filtradas.map((n, i) => cardNoticia(n, i)).join('');
  if (_cardSelId) marcarCardSeleccionada(_cardSelId); // conservar selección tras re-render
}

function cardNoticia(n, i) {
  const nivelCls = n.nivel === 'alto' ? 'nivel-alto' : n.nivel === 'medio' ? 'nivel-medio' : 'nivel-bajo';
  const nivelTxt = n.nivel === 'alto' ? 'text-red-400' : n.nivel === 'medio' ? 'text-amber-400' : 'text-slate-400';
  const evCls = n.estado_evidencia === 'suficiente_para_borrador' ? 'ev-suficiente' : n.estado_evidencia === 'parcial' ? 'ev-parcial' : 'ev-insuficiente';
  const evLabel = n.estado_evidencia === 'suficiente_para_borrador' ? '✓ Evidencia suficiente' : n.estado_evidencia === 'parcial' ? '⚠ Evidencia parcial' : '✗ Evidencia insuficiente';
  const alerta = n.alerta ? `<div class="mt-1.5 text-[10px] text-red-300 bg-red-500/10 rounded-md px-2 py-1 wrap-safe">⚠ ${escHtml(n.alerta)}</div>` : '';
  const fuentes = (n.fuentes_independientes || 1) > 1 ? `<span class="text-[10px] text-slate-500">· ${n.fuentes_independientes} fuentes</span>` : '';
  // Badges de memoria/novedad
  const badgeNueva = n.alta_prioridad_nueva
    ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-300 font-bold animate-pulse">🔴 NUEVA · ALTA</span>'
    : n.estado_memoria === 'nuevo' ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300">🆕 nueva</span>'
    : n.estado_memoria === 'actualizado' ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300">🔄 actualizada</span>' : '';
  const badgeFuente = n.fuente_primaria ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">✓ fuente oficial</span>' : '';
  // Mini-barras RUINE
  const comps = n.componentes || {};
  const barras = ['R','I','U','N','E'].map(k => {
    const v = Math.round((comps[k] || 0) * 100);
    return `<div class="flex flex-col items-center gap-0.5" title="${k}: ${v}%">
      <div class="w-1.5 h-6 rounded-full bg-slate-700/60 overflow-hidden flex flex-col justify-end">
        <div class="w-full accent-bg" style="height:${v}%"></div>
      </div><span class="text-[8px] text-slate-500">${k}</span></div>`;
  }).join('');

  return `
    <div class="glass glass-hover rounded-xl p-4 cursor-pointer transition fade-in relative ${nivelCls}"
         data-noticia-id="${escHtml(n.id || '')}"
         onclick="verFicha('${escHtml(n.id || '')}')" style="animation-delay:${Math.min(i*0.04,0.4)}s">
      <div class="flex items-start gap-3">
        <div class="flex flex-col items-center shrink-0 w-11">
          <span class="text-2xl font-black leading-none ${nivelTxt}">${n.puntaje?.toFixed(0)}</span>
          <span class="text-[9px] uppercase tracking-wider mt-0.5 ${nivelTxt}">${n.nivel}</span>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-slate-100 leading-snug clamp-2">${escHtml(n.titulo || '')}</p>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2">
            ${badgeNueva}
            ${badgeFuente}
            <span class="text-[10px] text-slate-400 truncate max-w-[120px]">${escHtml(n.medio || '')}</span>
            ${n.fecha ? `<span class="text-[10px] text-slate-500">🗓 ${fmtSoloFecha(n.fecha)}</span>` : ''}
            ${fuentes}
            <span class="text-[10px] px-1.5 py-0.5 rounded-full accent-soft-bg accent font-medium">${escHtml((n.tema || '').replace(/_/g,' '))}</span>
            <span class="text-[10px] ${evCls}">${evLabel}</span>
          </div>
          ${alerta}
        </div>
        <div class="hidden sm:flex items-end gap-1 shrink-0 pl-1">${barras}</div>
      </div>
    </div>`;
}

// Formatea fecha/hora en zona de Panamá (es-PA). Devuelve '' si no hay fecha válida.
function fmtFechaHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('es-PA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}
function fmtSoloFecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('es-PA', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Marca con glow la card de la noticia seleccionada (quita la marca de las demás)
let _cardSelId = null;
function marcarCardSeleccionada(id) {
  _cardSelId = id;
  document.querySelectorAll('[data-noticia-id]').forEach(el => {
    const sel = el.getAttribute('data-noticia-id') === id;
    el.classList.toggle('card-sel', sel);
    const tagPrev = el.querySelector('.sel-tag');
    if (sel && !tagPrev) {
      const tag = document.createElement('span');
      tag.className = 'sel-tag';
      tag.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:#fff;display:inline-block"></span> SELECCIONADA';
      el.appendChild(tag);
    } else if (!sel && tagPrev) {
      tagPrev.remove();
    }
  });
}
function cardSeleccionadaEl() {
  return _cardSelId ? document.querySelector(`[data-noticia-id="${CSS.escape(_cardSelId)}"]`) : null;
}

// Medidor RUINE circular animado (SVG). Color según nivel.
function gaugeRUINE(puntaje, nivel) {
  const p = Math.max(0, Math.min(100, puntaje || 0));
  const R = 30, circ = 2 * Math.PI * R;
  const off = circ * (1 - p / 100);
  const color = nivel === 'alto' ? '#f0616f' : nivel === 'medio' ? '#e0a43b' : '#5b6373';
  return `
    <div class="ruine-gauge shrink-0" style="width:76px;height:76px">
      <svg width="76" height="76" viewBox="0 0 76 76">
        <circle class="track" cx="38" cy="38" r="${R}" fill="none" stroke-width="7"></circle>
        <circle class="fill" cx="38" cy="38" r="${R}" fill="none" stroke="${color}" stroke-width="7"
          style="--circ:${circ.toFixed(1)};--off:${off.toFixed(1)};stroke-dasharray:${circ.toFixed(1)};filter:drop-shadow(0 0 6px ${color}88)"></circle>
        <text x="38" y="35" text-anchor="middle" dominant-baseline="middle" fill="${color}" font-size="19" font-weight="800" font-family="Plus Jakarta Sans,Inter">${p.toFixed(0)}</text>
        <text x="38" y="49" text-anchor="middle" fill="#9aa3b2" font-size="8" font-weight="700" letter-spacing="1">RUINE</text>
      </svg>
    </div>`;
}

// ── Ficha de evidencia ────────────────────────────────────────────
async function verFicha(id) {
  if (!id) return;
  if (typeof detenerAudio === 'function') detenerAudio(); // corta audio de la ficha anterior
  marcarCardSeleccionada(id); // glow en la noticia clicada
  const panel = document.querySelector('#fichaContent');
  panel.innerHTML = '<div class="text-slate-500 pulsing">Cargando ficha...</div>';
  try {
    const r = await fetch(`${BASE}/api/ficha/${encodeURIComponent(id)}?modo=${MODO}`).then(x => x.json());
    if (!r.ok) { panel.innerHTML = `<div class="text-red-400">${r.msg}</div>`; return; }
    const f = r.ficha;
    const est = estadoHITL(f.estado_revision);
    panel.innerHTML = `
      <div class="space-y-3 rise">
        <div class="flex items-start gap-3">
          ${gaugeRUINE(f.prioridad?.puntaje, f.prioridad?.nivel)}
          <div class="min-w-0 flex-1">
          <p class="font-semibold text-slate-200 text-xs leading-tight wrap-safe">${escHtml(f.noticia?.titulo || '')}</p>
          <p class="text-[10px] text-slate-500 mt-0.5">Nivel: <span class="font-semibold ${f.prioridad?.nivel==='alto'?'text-red-400':f.prioridad?.nivel==='medio'?'text-amber-400':'text-slate-400'}">${f.prioridad?.nivel || ''}</span></p>
          <!-- Metadatos de la evidencia (audit trail) -->
          <div class="mt-2 space-y-1 text-[10px]">
            <div class="flex items-start gap-1.5">
              <span class="text-slate-500 shrink-0">📰 Fuente:</span>
              ${f.noticia?.url
                ? `<a href="${escHtml(f.noticia.url)}" target="_blank" rel="noopener" class="accent hover:underline wrap-safe">${escHtml(f.noticia?.medio || 'ver fuente')} ↗</a>`
                : `<span class="text-slate-400 wrap-safe">${escHtml(f.noticia?.medio || 's/d')}</span>`}
            </div>
            <div class="flex items-start gap-1.5">
              <span class="text-slate-500 shrink-0">🗓 Publicada:</span>
              <span class="text-slate-300 wrap-safe">${fmtFechaHora(f.noticia?.fecha) || 'sin fecha'}</span>
            </div>
            <div class="flex items-start gap-1.5">
              <span class="text-slate-500 shrink-0">✓ Verificada:</span>
              <span class="text-slate-400 wrap-safe">${fmtFechaHora(f.ficha?.timestamp || f.timestamp) || 's/d'} (hora Panamá)</span>
            </div>
          </div>
          </div>
        </div>

        <div class="pt-2 border-t border-white/10">
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Qué se reporta</p>
          <p class="text-xs text-slate-300">${escHtml(f.ficha?.que_se_reporta || '')}</p>
        </div>

        ${f.ficha?.que_esta_respaldado?.length ? `
        <div>
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Respaldado ✓</p>
          <ul class="space-y-0.5">${(f.ficha.que_esta_respaldado).map(x => `<li class="text-xs text-green-400">• ${escHtml(x)}</li>`).join('')}</ul>
        </div>` : ''}

        ${f.ficha?.que_falta_comprobar?.length ? `
        <div>
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Falta verificar ⚠</p>
          <ul class="space-y-0.5">${(f.ficha.que_falta_comprobar).map(x => `<li class="text-xs text-amber-400">• ${escHtml(x)}</li>`).join('')}</ul>
        </div>` : ''}

        ${(() => {
          const b = f.borrador || {};
          // Buscar texto del guion en TODOS los campos posibles (TVN, banca, o fallbacks)
          let guion = b.guion_45_60s || b.resumen || b.brief?.resumen || b.brief?.titulo_propuesto || '';
          // Si el borrador quedó vacío, construir uno mínimo desde la ficha (nunca quedar sin nada)
          if (!guion && f.ficha?.que_se_reporta) {
            guion = f.ficha.que_se_reporta;
          }
          if (!guion) return `<div class="text-[11px] text-amber-400/80 bg-amber-500/10 rounded-lg p-2 wrap-safe">⚠ Sin borrador: evidencia insuficiente para redactar. ${escHtml((f.borrador?.mensaje) || 'Requiere más fuentes antes de generar el guion.')}</div>`;
          window._guionActual = guion; // texto para el reproductor TTS
          return `
        <div>
          <div class="flex items-center justify-between mb-1">
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">${MODO === 'banca' ? 'Boletín' : 'Guion 45-60s'}</p>
            <div class="flex flex-wrap gap-1">
              <button onclick="leerGuion()" id="btnAudio" class="text-[10px] px-2 py-1 rounded-lg accent-soft-bg accent hover:brightness-125 transition flex items-center gap-1" title="Escuchar en voz alta">🔊 Escuchar</button>
              <button onclick="detenerAudio()" id="btnAudioStop" class="text-[10px] px-2 py-1 rounded-lg bg-slate-800/70 text-slate-400 hover:text-slate-200 transition hidden" title="Detener">⏹</button>
              <button onclick="copiarGuion()" class="text-[10px] px-2 py-1 rounded-lg bg-slate-800/70 text-slate-300 hover:text-slate-100 transition" title="Copiar al portapapeles">📋 Copiar</button>
              <button onclick="descargarGuion('${escHtml(f.id_caso)}')" class="text-[10px] px-2 py-1 rounded-lg bg-slate-800/70 text-slate-300 hover:text-slate-100 transition" title="Descargar como texto editable">📄 .txt</button>
            </div>
          </div>
          <div class="text-xs text-slate-300 bg-slate-800/60 rounded-lg p-2 leading-relaxed wrap-safe">${escHtml(guion)}</div>
          <p class="text-[9px] text-slate-600 mt-1">Guion escrito "para el oído". Voz del navegador (integrable con TTS profesional).</p>
        </div>`;
        })()}

        <!-- Human-in-the-loop -->
        <div class="pt-2 border-t border-white/10">
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Revisión humana</p>
          <div class="text-xs mb-2">${est.badge}</div>
          <div class="flex flex-wrap gap-1.5">
            ${['en_revision','aprobado_como_borrador','requiere_evidencia','descartado'].map(e => `
              <button onclick="cambiarEstado('${escHtml(f.id_caso)}','${e}')"
                class="text-[10px] px-2 py-1 rounded-lg border border-white/10 hover:border-red-400/40 bg-slate-800/60 hover:bg-slate-700/60 transition">
                ${estadoHITL(e).label}
              </button>`).join('')}
          </div>
        </div>
      </div>`;
  } catch (e) { panel.innerHTML = `<div class="text-red-400 text-xs">${e.message}</div>`; }
}

function estadoHITL(estado) {
  const m = {
    nuevo: { label: '🆕 Nuevo', badge: '<span class="bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full text-[10px]">🆕 Nuevo</span>' },
    en_revision: { label: '👁 En revisión', badge: '<span class="bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded-full text-[10px]">👁 En revisión</span>' },
    requiere_evidencia: { label: '⚠ Necesita evidencia', badge: '<span class="bg-amber-900/40 text-amber-300 px-2 py-0.5 rounded-full text-[10px]">⚠ Requiere evidencia</span>' },
    aprobado_como_borrador: { label: '✅ Aprobado', badge: '<span class="bg-green-900/40 text-green-300 px-2 py-0.5 rounded-full text-[10px]">✅ Aprobado borrador</span>' },
    descartado: { label: '🗑 Descartado', badge: '<span class="bg-red-900/40 text-red-300 px-2 py-0.5 rounded-full text-[10px]">🗑 Descartado</span>' },
  };
  return m[estado] || m.nuevo;
}

async function cambiarEstado(id, estado) {
  await fetch(`${BASE}/api/revision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, estado, revisor: 'editor' }),
  });
  verFicha(id);
}

// ── KPIs en vivo (barra superior del dashboard) ───────────────────
function renderKPIs(r) {
  const bandeja = r.bandeja || [];
  const total = r.total ?? bandeja.length;
  const alto = bandeja.filter(n => n.nivel === 'alto').length;
  const medio = bandeja.filter(n => n.nivel === 'medio').length;
  const bajo = bandeja.filter(n => n.nivel === 'bajo').length;
  const alertas = bandeja.filter(n => n.alta_prioridad_nueva).length;
  const fuentes = bandeja.reduce((acc, n) => acc + (n.fuentes_independientes || 1), 0);

  const set = (id, val) => {
    const el = document.querySelector(id);
    if (el) { el.textContent = val; el.classList.remove('kpi-val'); void el.offsetWidth; el.classList.add('kpi-val'); }
  };
  set('#kpiTotal', total);
  set('#kpiAlertas', alertas);
  set('#kpiFuentes', fuentes);
  set('#kpiActualizado', fmtFechaHora(r.timestamp) || '—');

  // Barra de distribución RUINE (animada)
  const totNivel = Math.max(1, alto + medio + bajo);
  const setW = (id, n) => { const el = document.querySelector(id); if (el) el.style.width = (n / totNivel * 100).toFixed(1) + '%'; };
  setW('#distAlto', alto); setW('#distMedio', medio); setW('#distBajo', bajo);
  const setN = (id, n) => { const el = document.querySelector(id); if (el) el.textContent = n; };
  setN('#distAltoN', alto); setN('#distMedioN', medio); setN('#distBajoN', bajo);
}

// ── Estadísticas ──────────────────────────────────────────────────
function renderStats(r) {
  const cont = document.querySelector('#statsContent');
  const panel = document.querySelector('#statsPanel');
  if (!cont || !panel) return;
  panel.classList.remove('hidden');

  const fichasListas = r.fichas_generadas ?? 0;
  const fichasTxt = (fichasListas && r.total && fichasListas < r.total)
    ? `${fichasListas} de ${r.total}` : `${fichasListas || r.total}`;
  const base = `
    <div class="flex justify-between"><span class="text-slate-400">${MODO === 'banca' ? 'Noticias económicas' : 'Noticias priorizadas'}</span><span class="font-bold text-white">${r.total}</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Fichas listas</span><span class="font-bold text-white">${fichasTxt}</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Grupos duplicados</span><span class="font-bold text-amber-400">${r.grupos_con_duplicados}</span></div>
    <div class="flex justify-between"><span class="text-slate-400">IA</span><span class="font-bold ${r.ia ? 'text-green-400' : 'text-yellow-400'}">${r.ia ? 'Habilitada' : 'Baseline'}</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Duración</span><span class="font-bold text-white">${r.duracion_seg}s</span></div>
    ${(fichasListas && r.total && fichasListas < r.total) ? `<div class="text-[10px] text-slate-500 mt-1 wrap-safe">Las demás noticias generan su ficha al hacer clic en la bandeja.</div>` : ''}`;

  // Snapshot económico (distinto por modalidad)
  const snap = r.snapshot_economico;
  let snapHtml = '';
  if (snap) {
    const kpis = (snap.indicadores_clave || []).filter(k => k && k.valor !== undefined && k.valor !== null).map(k => {
      const u = k.unidad === '%' || /%|PIB|Inflación|Desempleo|Exportaciones/i.test(k.nombre) ? '%' : '';
      const val = typeof k.valor === 'number' ? k.valor : k.valor;
      return `<div class="rounded-lg accent-soft-bg px-2.5 py-2">
        <div class="text-base font-black accent leading-none">${val}${k.unidad === 'sismos' ? '' : u}</div>
        <div class="text-[9px] text-slate-400 mt-1 leading-tight wrap-safe">${escHtml(k.nombre)}${k.anio ? ` · ${k.anio}` : ''}</div>
      </div>`;
    }).join('');
    // Ciclo histórico (solo banca)
    let ciclo = '';
    if (snap.ciclo_historico) {
      const c = snap.ciclo_historico;
      const k = c.kondratiev || {};
      const m = c.macro || {};
      ciclo = `<div class="pt-3 mt-1 border-t border-white/10">
        <p class="text-[10px] font-bold accent uppercase tracking-wider mb-2 wrap-safe">🌐 ${escHtml(c.titulo)}</p>
        <div class="rounded-lg accent-soft-bg px-3 py-2 mb-2">
          <div class="text-sm font-black accent leading-tight wrap-safe">${escHtml(c.fase_label || '')}</div>
          <div class="text-[9px] text-slate-400 mt-1 wrap-safe">${escHtml(k.marco || '')} · año ${k.anio_ciclo} del ciclo (${k.posicion_pct}%)</div>
          <div class="mt-1.5 h-1.5 rounded-full bg-slate-700/50 overflow-hidden"><div class="h-full accent-bg" style="width:${k.posicion_pct || 0}%"></div></div>
          <div class="text-[9px] text-slate-500 mt-1 wrap-safe">${escHtml(k.descripcion || '')}</div>
        </div>
        ${(m.señales || []).length ? `<div class="flex flex-wrap gap-1 mb-2">${m.señales.map(s => `<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-700/60 text-slate-300">${escHtml(s)}</span>`).join('')}</div>` : ''}
        <div class="text-[9px] text-amber-400/90 bg-amber-500/10 rounded-md px-2 py-1 wrap-safe">⚠ ${escHtml(c.disclaimer)}</div>
      </div>`;
    }

    let regional = '';
    if (snap.comparativo_regional?.datos?.length) {
      const d = snap.comparativo_regional.datos.slice(0, 6);
      const max = Math.max(...d.map(x => Math.abs(x.valor)), 1);
      regional = `<div class="pt-2 mt-1 border-t border-white/10">
        <p class="text-[10px] text-slate-400 mb-1.5 wrap-safe">${escHtml(snap.comparativo_regional.indicador)}</p>
        ${d.map(x => `<div class="flex items-center gap-2 mb-1">
          <span class="text-[10px] text-slate-300 w-8 shrink-0">${x.pais}</span>
          <div class="flex-1 h-2 rounded-full bg-slate-700/50 overflow-hidden"><div class="h-full accent-bg" style="width:${Math.min(100,Math.abs(x.valor)/max*100)}%"></div></div>
          <span class="text-[10px] text-slate-400 w-10 text-right shrink-0">${x.valor}%</span>
        </div>`).join('')}
      </div>`;
    }
    // Mercados (solo Banca) — datos crudos de la fuente, nunca inventados
    let mercados = '';
    if (snap.mercados?.items?.length) {
      const filas = snap.mercados.items.map(it => {
        const ch = it.cambio_24h;
        const chCol = ch == null ? 'text-slate-500' : ch > 0 ? 'text-emerald-400' : ch < 0 ? 'text-red-400' : 'text-slate-400';
        const chTxt = ch == null ? '' : `${ch > 0 ? '▲' : ch < 0 ? '▼' : ''} ${Math.abs(ch)}%`;
        const val = it.valor != null
          ? (it.unidad === 'EUR' ? `€${it.valor}` : `$${it.valor.toLocaleString('en-US')}`)
          : 'no disponible';
        return `<div class="flex items-center justify-between gap-2 py-1 border-b border-white/5 last:border-0">
          <span class="text-[11px] text-slate-200 truncate">${escHtml(it.nombre)} <span class="text-slate-500">${escHtml(it.simbolo || '')}</span></span>
          <span class="flex items-center gap-2 shrink-0 text-[10px]">
            <span class="text-slate-100 font-semibold">${val}</span>
            <span class="${chCol} w-14 text-right">${chTxt}</span>
          </span>
        </div>`;
      }).join('');
      mercados = `<div class="pt-3 mt-1 border-t border-white/10">
        <p class="text-[10px] font-bold accent uppercase tracking-wider mb-2 wrap-safe">💹 ${escHtml(snap.mercados.titulo || 'Mercados')}</p>
        <div>${filas}</div>
        <p class="text-[9px] text-slate-500 mt-1.5 wrap-safe">${escHtml(snap.mercados.disclaimer || '')}</p>
      </div>`;
    }
    // Tendencias independientes (sismos / solar / temperatura) — solo TVN
    let tendencias = '';
    if (snap.tendencias) {
      const t = snap.tendencias;
      const fila = (obj, extra) => {
        if (!obj || obj.error) return '';
        const td = obj.tendencia || {};
        const col = td.flecha === '↑' ? 'text-red-300' : td.flecha === '↓' ? 'text-sky-300' : 'text-slate-300';
        return `<div class="flex items-start justify-between gap-2 mb-1.5">
          <div class="min-w-0">
            <div class="text-[10px] text-slate-300 wrap-safe">${escHtml(obj.indicador)}</div>
            <div class="text-[9px] text-slate-500 wrap-safe">${extra}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-sm font-black ${col}">${td.flecha || '→'}</div>
            <div class="text-[9px] ${col} wrap-safe">${escHtml(td.etiqueta || '')}</div>
          </div>
        </div>`;
      };
      const sis = t.sismica ? fila(t.sismica, `${t.sismica.actual} vs ${t.sismica.promedio_historico} prom. (${t.sismica.anios_comparados} años) · ${t.sismica.tendencia.pct > 0 ? '+' : ''}${t.sismica.tendencia.pct ?? '?'}%`) : '';
      const sol = t.solar && !t.solar.error ? fila(t.solar, `SSN ${t.solar.ssn_actual} vs ${t.solar.ssn_hace_12m} hace 12m`) : '';
      const tmp = t.temperatura && t.temperatura.media_actual != null ? fila(t.temperatura, `${t.temperatura.media_actual}°C vs ${t.temperatura.media_historica}°C hist. (Δ ${t.temperatura.tendencia.delta}°C)`) : '';
      if (sis || sol || tmp) {
        tendencias = `<div class="pt-3 mt-1 border-t border-white/10">
          <p class="text-[10px] font-bold accent uppercase tracking-wider mb-2 wrap-safe">📈 Tendencias de contexto <span class="font-normal text-slate-600 normal-case">(datos independientes)</span></p>
          ${sis}${sol}${tmp}
          <p class="text-[9px] text-slate-500 mt-1 wrap-safe">Fenómenos separados, sin relación causal. No son predicción.</p>
        </div>`;
      }
    }

    // Bloque de clima multi-ciudad (estilo noticiero) — solo TVN
    let clima = '';
    if (snap.clima?.ciudades?.length) {
      const filas = snap.clima.ciudades.map(c => {
        const lluviaCol = (c.prob_lluvia ?? 0) >= 70 ? 'text-sky-300' : (c.prob_lluvia ?? 0) >= 40 ? 'text-amber-300' : 'text-slate-400';
        return `<div class="flex items-center justify-between gap-2 py-1 border-b border-white/5 last:border-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <span>${c.icono || '🌡️'}</span>
            <span class="text-[11px] text-slate-200 truncate">${escHtml(c.ciudad)}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0 text-[10px]">
            <span class="text-slate-100 font-semibold">${c.temp_actual != null ? Math.round(c.temp_actual) + '°' : '—'}</span>
            <span class="text-slate-500">${c.max != null ? Math.round(c.max) + '/' + Math.round(c.min) + '°' : ''}</span>
            <span class="${lluviaCol} w-9 text-right">💧${c.prob_lluvia ?? 0}%</span>
          </div>
        </div>`;
      }).join('');
      clima = `<div class="pt-3 mt-1 border-t border-white/10">
        <p class="text-[10px] font-bold accent uppercase tracking-wider mb-2 wrap-safe">🌦️ ${escHtml(snap.clima.titulo || 'El tiempo')}</p>
        <div>${filas}</div>
        <p class="text-[9px] text-slate-500 mt-1.5 wrap-safe">Fuente: ${escHtml(snap.clima.fuente || 'Open-Meteo')} · 💧 = probabilidad de lluvia</p>
      </div>`;
    }

    snapHtml = `
      <div class="pt-3 mt-1 border-t border-white/10">
        <p class="text-[10px] font-bold accent uppercase tracking-wider mb-2 wrap-safe">${escHtml(snap.titulo)}</p>
        <div class="grid grid-cols-2 gap-2">${kpis}</div>
        ${regional}
        ${mercados}
        ${ciclo}
        ${tendencias}
        ${clima}
        <p class="text-[9px] text-slate-500 mt-2 wrap-safe">${escHtml(snap.nota || '')}</p>
      </div>`;
  }

  cont.innerHTML = base + snapHtml;
}

// ── Filtros por tema ──────────────────────────────────────────────
function renderFiltros(temas) {
  const cont = document.querySelector('#filtroTemas');
  if (!cont || !temas) return;
  const colores = {
    // TVN
    economia:'bg-blue-900/50 text-blue-300', logistica_canal:'bg-cyan-900/50 text-cyan-300', turismo:'bg-purple-900/50 text-purple-300', regulacion:'bg-orange-900/50 text-orange-300', eventos_naturales:'bg-green-900/50 text-green-300', seguridad:'bg-rose-900/50 text-rose-300', servicios_publicos:'bg-yellow-900/50 text-yellow-300',
    // Banca
    liquidez:'bg-emerald-900/50 text-emerald-300', credito:'bg-sky-900/50 text-sky-300', comercio_exterior:'bg-cyan-900/50 text-cyan-300', inversion:'bg-indigo-900/50 text-indigo-300', inflacion_regional:'bg-amber-900/50 text-amber-300', regulacion_financiera:'bg-teal-900/50 text-teal-300',
    general:'bg-slate-700/50 text-slate-300'
  };
  const todosActivo = temaActivo === null ? 'accent-bg text-white' : 'bg-slate-700/80 text-slate-200';
  cont.innerHTML = `<button onclick="filtrarTema(null)" class="px-2 py-1 rounded-lg ${todosActivo} hover:opacity-80 transition">Todos</button>` +
    Object.entries(temas).sort((a,b) => b[1]-a[1]).map(([t,n]) => {
      const activo = temaActivo === t ? 'accent-ring' : '';
      return `<button onclick="filtrarTema('${t}')" class="px-2 py-1 rounded-lg ${colores[t] || 'bg-slate-700/50 text-slate-400'} ${activo} hover:opacity-80 transition">
        ${t.replace(/_/g,' ')} <span class="opacity-70">${n}</span>
      </button>`;
    }).join('');
}

function filtrarTema(tema) {
  temaActivo = tema;
  if (datosBandeja) {
    renderBandeja(datosBandeja.bandeja, tema);
    renderFiltros(datosBandeja.distribucion_temas);
  }
}

// ── Consulta libre: IA modifica la interfaz en tiempo real ────────
async function consultar() {
  const q = document.querySelector('#consultaInput')?.value?.trim();
  if (!q) return;
  const resp = document.querySelector('#consultaResp');
  if (resp) { resp.classList.remove('hidden'); resp.textContent = '⏳ Consultando...'; }

  try {
    const r = await fetch(`${BASE}/api/consulta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pregunta: q, modo: MODO }),
    }).then(x => x.json());

    if (resp) {
      resp.innerHTML = r.abstension
        ? `<div class="text-amber-400 font-semibold">🚫 ABSTENCIÓN</div><div class="text-slate-300 mt-1">${escHtml(r.respuesta || '')}</div>`
        : `<div class="text-green-400 font-semibold mb-1">✓ Respuesta</div><div class="text-slate-200">${escHtml(r.respuesta || '')}</div>`;
    }

    // 🔥 La IA modifica la interfaz: si hay evidencias, las resalta en la bandeja
    if (r.evidencia?.length && datosBandeja) {
      const idsResaltados = new Set(r.evidencia.map(e => e.id));
      // Mostrar solo las noticias relacionadas con la consulta (filtra automáticamente)
      const relacionadas = datosBandeja.bandeja.filter(n => idsResaltados.has(n.id));
      const otras = datosBandeja.bandeja.filter(n => !idsResaltados.has(n.id));
      const bandejaMod = [...relacionadas, ...otras];

      document.querySelector('#bandeja').innerHTML =
        `<div class="text-xs text-blue-400 mb-2 px-1">🤖 Mostrando resultados relacionados con tu consulta</div>` +
        bandejaMod.slice(0, 15).map((n, i) => cardNoticia(n, i)).join('');

      // Botón para volver a la bandeja completa
      const btnVolver = document.createElement('button');
      btnVolver.className = 'mt-2 text-xs text-slate-400 hover:text-white transition px-3 py-1.5 rounded-lg bg-slate-800/60 border border-white/10';
      btnVolver.textContent = '← Ver todas las noticias';
      btnVolver.onclick = () => { renderBandeja(datosBandeja.bandeja); btnVolver.remove(); };
      document.querySelector('#bandeja').prepend(btnVolver);
    }
  } catch (e) {
    if (resp) resp.textContent = `❌ Error: ${e.message}`;
  }
}

// ── Scheduler (vigilancia automática) ─────────────────────────────
let schedActivo = null; // segundos activos o 'horas'
let schedPoll = null;

async function setScheduler(valor) {
  marcarBtnSched(valor);
  if (valor === 'off') {
    await fetch(`${BASE}/api/scheduler/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modo: MODO }) });
    schedActivo = null;
    actualizarEstadoSched(false);
    if (schedPoll) { clearInterval(schedPoll); schedPoll = null; }
    return;
  }
  await fetch(`${BASE}/api/scheduler/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modo: MODO, tipo: 'intervalo', segundos: valor, topN: 0 }),
  });
  schedActivo = valor;
  actualizarEstadoSched(true, valor);
  arrancarPollSched();
}

async function setSchedulerHoras() {
  const txt = prompt('Horas fijas de revisión (formato 24h, separadas por coma):', '06:00, 12:00, 18:00');
  if (!txt) return;
  const horas = txt.split(',').map(h => h.trim()).filter(Boolean);
  marcarBtnSched('horas');
  await fetch(`${BASE}/api/scheduler/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modo: MODO, tipo: 'horas', horas, topN: 0 }),
  });
  schedActivo = 'horas';
  actualizarEstadoSched(true, 'horas', horas);
  arrancarPollSched();
}

function marcarBtnSched(valor) {
  document.querySelectorAll('.sched-btn').forEach(b => {
    const activo = String(b.dataset.s) === String(valor);
    b.className = `sched-btn text-[11px] px-2 py-1 rounded-lg transition ${activo ? 'accent-bg text-white' : 'bg-slate-800/70 text-slate-300 hover:bg-slate-700/70'}`;
  });
}

function actualizarEstadoSched(on, valor, horas) {
  const badge = document.querySelector('#schedState');
  const info = document.querySelector('#schedInfo');
  if (badge) {
    badge.textContent = on ? 'Activo' : 'Off';
    badge.className = `text-[10px] px-2 py-0.5 rounded-full ${on ? 'bg-green-900/40 text-green-300 border border-green-400/30' : 'bg-slate-700/60 text-slate-400'}`;
  }
  if (info) {
    if (!on) info.textContent = 'La bandeja se actualiza solo cuando ejecutas el pipeline.';
    else if (valor === 'horas') info.textContent = `Revisando a horas fijas: ${(horas || []).join(', ')}. El humano decide al abrir cada ficha.`;
    else info.textContent = `Revisando cada ${valor < 60 ? valor + 's' : (valor/60) + 'm'}. Las noticias de alta prioridad disparan alerta al editor.`;
  }
}

function arrancarPollSched() {
  if (schedPoll) clearInterval(schedPoll);
  // Refresca bandeja + feed periódicamente mientras el scheduler corre
  schedPoll = setInterval(() => { cargarBandeja(); cargarEventos(); }, 15000);
}

// ── Histórico / feed de eventos ───────────────────────────────────
async function cargarEventos() {
  try {
    const r = await fetch(`${BASE}/api/eventos?limite=40`).then(x => x.json());
    const cont = document.querySelector('#feedEventos');
    if (!cont) return;
    if (!r.eventos?.length) { cont.innerHTML = '<div class="text-slate-600">Sin actividad todavía.</div>'; return; }
    const icono = { alerta:'🔴', nueva:'🆕', decision:'✍️', ciclo:'🔄', ciclo_fin:'✅', ciclo_error:'⚠️', scheduler:'⏱', email:'📧', email_log:'📧', email_error:'⚠️', whatsapp_log:'💬' };
    // Quita cualquier emoji/símbolo inicial del mensaje para no duplicar el ícono por tipo
    const limpiarEmoji = (s) => String(s || '').replace(/^[\s\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{23F0}-\u{23FF}\u2B00-\u2BFF\uFE0F]+/u, '').trim();
    cont.innerHTML = r.eventos.map(e => {
      const t = new Date(e.ts);
      const hora = t.toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' });
      // Mostrar la fecha corta (dd/mm) solo si el evento NO es de hoy, para no saturar.
      const hoy = new Date();
      const esHoy = t.toDateString() === hoy.toDateString();
      const fecha = esHoy ? '' : t.toLocaleDateString('es-PA', { day: '2-digit', month: '2-digit' }) + ' ';
      const sello = `${fecha}${hora}`;
      const destacado = e.tipo === 'alerta' ? 'text-red-300' : e.tipo === 'ciclo_fin' ? 'text-green-300/90' : 'text-slate-400';
      return `<div class="flex gap-2 ${destacado}">
        <span class="text-slate-300 font-mono tabular-nums shrink-0" title="${escHtml(t.toLocaleString('es-PA'))}">${sello}</span>
        <span class="wrap-safe">${icono[e.tipo] || '•'} ${escHtml(limpiarEmoji(e.mensaje))}</span>
      </div>`;
    }).join('');
    if (r.memoria) {
      cont.innerHTML += `<div class="mt-2 pt-2 border-t border-white/10 text-[10px] text-slate-500 wrap-safe">
        🧠 Memoria: ${r.memoria.total_recordadas} noticias recordadas · ${r.memoria.ciclos} ciclos · ${r.memoria.descartadas} descartadas</div>`;
    }
  } catch (_) {}
}

async function cargarEstadoSched() {
  try {
    const r = await fetch(`${BASE}/api/scheduler/status`).then(x => x.json());
    const est = r.scheduler?.[MODO];
    if (est?.activo) {
      const cfg = est.config || {};
      if (cfg.tipo === 'horas') { schedActivo = 'horas'; marcarBtnSched('horas'); actualizarEstadoSched(true, 'horas', cfg.horas); }
      else { schedActivo = cfg.segundos; marcarBtnSched(cfg.segundos); actualizarEstadoSched(true, cfg.segundos); }
      arrancarPollSched();
    } else {
      marcarBtnSched('off'); actualizarEstadoSched(false);
    }
  } catch (_) {}
}

// ── Audio: leer el guion en voz alta (Web Speech API, gratis, sin servidor) ──
function vozEspanol() {
  const voces = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  if (!voces.length) return null;
  // Preferir Panamá > español latino > cualquier español
  return voces.find(v => /es-PA/i.test(v.lang))
    || voces.find(v => /es-(MX|419|CO|US)/i.test(v.lang))
    || voces.find(v => /^es/i.test(v.lang))
    || null;
}

// Limpia el guion para que la voz suene NATURAL (sin leer citas, IDs ni símbolos)
function textoParaVoz(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ')            // quita citas y marcadores [tvn_...], [ID], [BORRADOR]
    .replace(/https?:\/\/\S+/g, ' ')        // quita URLs
    .replace(/_/g, ' ')                     // guiones bajos → espacio (no se leen "guión bajo")
    .replace(/\s*[|•·]\s*/g, '. ')          // separadores visuales → pausa
    .replace(/\bRUINE\b/gi, 'ruine')        // evita deletreo raro
    .replace(/\s{2,}/g, ' ')                // espacios múltiples
    .replace(/\s+([.,;:])/g, '$1')          // espacios antes de puntuación
    .trim();
}

function leerGuion() {
  const texto = textoParaVoz(window._guionActual);
  if (!texto) return;
  if (!('speechSynthesis' in window)) {
    alert('Tu navegador no soporta lectura en voz alta.');
    return;
  }
  speechSynthesis.cancel(); // detener cualquier lectura previa
  const u = new SpeechSynthesisUtterance(texto);
  const v = vozEspanol();
  if (v) u.voice = v;
  u.lang = v?.lang || 'es-ES';
  u.rate = 0.98;   // ritmo de locución
  u.pitch = 1.0;
  const btn = document.querySelector('#btnAudio');
  const stop = document.querySelector('#btnAudioStop');
  u.onstart = () => {
    if (btn) { btn.innerHTML = '🔊 Reproduciendo…'; btn.classList.add('pulsing'); }
    if (stop) stop.classList.remove('hidden');
    const card = cardSeleccionadaEl();
    if (card) {
      card.classList.add('audio-on');
      const tag = card.querySelector('.sel-tag');
      if (tag) tag.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:#fff;display:inline-block"></span> 🔊 LEYENDO';
    }
  };
  u.onend = () => resetBtnAudio();
  u.onerror = () => resetBtnAudio();
  speechSynthesis.speak(u);
}

function detenerAudio() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  resetBtnAudio();
}

// Copiar el guion al portapapeles (para pegar en Word/Docs/CMS)
async function copiarGuion() {
  const texto = window._guionActual;
  if (!texto) return;
  try {
    await navigator.clipboard.writeText(texto);
    toast('✓ Guion copiado al portapapeles');
  } catch (_) {
    // Fallback si clipboard no está disponible (http sin permisos)
    const ta = document.createElement('textarea');
    ta.value = texto; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('✓ Guion copiado'); } catch (e) { toast('No se pudo copiar'); }
    ta.remove();
  }
}

// Descargar el guion/ficha como documento de texto editable (.txt → abre en Word/Docs)
function descargarGuion(id) {
  if (!id) return;
  window.open(`${BASE}/api/export/ficha/${encodeURIComponent(id)}?modo=${MODO}`, '_blank');
}

// Exportar la bandeja completa (JSON o CSV) para integración/Excel
function exportarBandeja(formato) {
  window.open(`${BASE}/api/export?modo=${MODO}&formato=${formato}`, '_blank');
}

// Mini-notificación efímera
function toast(msg) {
  let el = document.querySelector('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-slate-800 border border-white/15 text-sm text-slate-100 shadow-lg';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

function resetBtnAudio() {
  const btn = document.querySelector('#btnAudio');
  const stop = document.querySelector('#btnAudioStop');
  if (btn) { btn.innerHTML = '🔊 Escuchar'; btn.classList.remove('pulsing'); }
  if (stop) stop.classList.add('hidden');
  const card = cardSeleccionadaEl();
  if (card) {
    card.classList.remove('audio-on');
    const tag = card.querySelector('.sel-tag');
    if (tag) tag.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:#fff;display:inline-block"></span> SELECCIONADA';
  }
}

// Precargar voces (algunos navegadores las cargan async) y detener audio al cambiar de ficha
if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => {};
}

// ── Audio ambiente: olas del mar sintetizadas (Web Audio API, sin archivos) ──
let _ambiente = { ctx: null, on: false, nodes: null };

function toggleAmbiente() {
  if (_ambiente.on) { detenerAmbiente(); return; }
  iniciarAmbiente();
}

function iniciarAmbiente() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { toast('Tu navegador no soporta audio ambiente'); return; }
    const ctx = new Ctx();

    // 1) Ruido marrón (brown noise): base grave y suave, parecido al mar/viento
    const bufSize = 2 * ctx.sampleRate;
    const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufSize; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer; noise.loop = true;

    // 2) Filtro paso-bajo para suavizar (quita agudos ásperos)
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 650;

    // 3) Ganancia general (volumen cómodo)
    const gain = ctx.createGain();
    gain.gain.value = 0.0;

    // 4) LFO que modula el volumen lentamente → simula el vaivén de las olas
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12; // ~un ciclo cada 8s (ritmo de ola)
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.09;
    lfo.connect(lfoGain); lfoGain.connect(gain.gain);

    noise.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
    noise.start(); lfo.start();

    // Fade-in suave
    gain.gain.setValueAtTime(0.0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.14, ctx.currentTime + 1.5);

    _ambiente = { ctx, on: true, nodes: { noise, lfo, gain } };
    const btn = document.querySelector('#btnAmbiente');
    if (btn) { btn.innerHTML = '🌊 Ambiente'; btn.classList.add('accent-ring', 'accent'); }
    toast('🌊 Ambiente de mar activado');
  } catch (e) { toast('No se pudo iniciar el audio'); }
}

function detenerAmbiente() {
  const a = _ambiente;
  if (!a.on || !a.ctx) return;
  try {
    // Fade-out y cierre
    a.nodes.gain.gain.linearRampToValueAtTime(0.0001, a.ctx.currentTime + 0.6);
    setTimeout(() => { try { a.nodes.noise.stop(); a.nodes.lfo.stop(); a.ctx.close(); } catch (_) {} }, 700);
  } catch (_) {}
  _ambiente = { ctx: null, on: false, nodes: null };
  const btn = document.querySelector('#btnAmbiente');
  if (btn) { btn.innerHTML = '🔊 Ambiente'; btn.classList.remove('accent-ring', 'accent'); }
}

// ── Utils ─────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Enter en consulta
document.addEventListener('DOMContentLoaded', () => {
  init();
  document.querySelector('#consultaInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); consultar(); }
  });
});
