'use strict';
/**
 * VerifactIA — Coincidencia difusa tolerante a erratas.
 *
 * Permite que la consulta libre entienda preguntas con faltas ortográficas,
 * sin acentos o con errores de dedo (ej. "sismoz" → "sismo", "economa" → "economía",
 * "activs" → "activos", "prioridd" → "prioridad").
 *
 * Técnica: normalización (minúsculas + sin acentos) + distancia de Levenshtein
 * con umbral tolerante según el largo de la palabra.
 */

// Quita acentos/diacríticos y pasa a minúsculas
function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // elimina tildes
    .replace(/[¿?¡!.,;:()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distancia de edición (Levenshtein) con early-exit por maxDist
function levenshtein(a, b, maxDist = 3) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  if (!la) return lb; if (!lb) return la;
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    let best = Infinity;
    const cur = [i];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > maxDist) return maxDist + 1; // no vale la pena seguir
    prev = cur;
  }
  return prev[lb];
}

// Umbral de tolerancia según largo (palabras cortas aceptan menos error)
function umbralPorLargo(len) {
  if (len <= 4) return 1;
  if (len <= 7) return 2;
  return 3;
}

/**
 * ¿La palabra `termino` (posiblemente mal escrita) aparece en `texto`?
 * Compara contra cada palabra del texto con tolerancia a erratas.
 */
function terminoEnTexto(termino, texto) {
  const t = normalizar(termino);
  if (t.length < 3) return false;
  const palabras = normalizar(texto).split(' ');
  const umbral = umbralPorLargo(t.length);
  for (const p of palabras) {
    if (p.length < 3) continue;
    if (p.includes(t) || t.includes(p)) return true;         // subcadena directa
    if (p.startsWith(t.slice(0, Math.max(4, t.length - 2)))) return true; // raíz (plural/género)
    if (levenshtein(t, p, umbral) <= umbral) return true;    // errata tolerada
  }
  return false;
}

/**
 * ¿Alguno de los conceptos (lista de sinónimos/variantes) aparece en el texto,
 * tolerando erratas? Útil para detectar intención (ej. "analítica").
 */
function conceptoEnTexto(conceptos, texto) {
  return conceptos.some(c => terminoEnTexto(c, texto));
}

module.exports = { normalizar, levenshtein, terminoEnTexto, conceptoEnTexto };
