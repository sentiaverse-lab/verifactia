'use strict';
/**
 * VerifactIA — Panel de mercados (solo modalidad Banca).
 *
 * Datos de contexto de mercado desde fuentes públicas gratuitas (sin API key).
 *
 * ROBUSTEZ + ANTI-ALUCINACIÓN:
 *   - Cascada de proveedores: si una fuente cae, se intenta la siguiente (todas reales).
 *   - Último valor conocido: si TODAS caen, se muestra el último dato real con su
 *     antigüedad VISIBLE ("hace X min"), nunca un número inventado o de relleno.
 *   - NO es asesoría de inversión: solo precio + variación 24h + hora + fuente.
 *
 * Fuentes verificadas (todas sin key):
 *   Cripto/oro: CoinGecko → Coinbase → Binance
 *   Divisas:    Frankfurter (BCE) → er-api
 */

const https = require('https');

function fetchJSON(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'VerifactIA/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

const round = (v, d = 2) => typeof v === 'number' && isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;

// Último valor conocido por símbolo (para fallback con antigüedad visible)
const _ultimo = {}; // { BTC: { item, ts }, ... }
function recordar(sym, item) { _ultimo[sym] = { item: { ...item }, ts: Date.now() }; }
function conAntiguedad(sym) {
  const u = _ultimo[sym];
  if (!u) return null;
  const minutos = Math.round((Date.now() - u.ts) / 60000);
  return { ...u.item, cambio_24h: null, fuente: `${u.item.fuente} (último dato hace ${minutos} min, fuentes no responden ahora)`, obsoleto: true };
}

// ── Cripto / oro: cascada CoinGecko → Coinbase → Binance ──
async function precioCripto(cgId, coinbaseSym, binanceSym, nombre, simbolo) {
  // 1) CoinGecko (trae cambio 24h)
  try {
    const j = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true`);
    if (j[cgId] && typeof j[cgId].usd === 'number') {
      const item = { nombre, simbolo, valor: round(j[cgId].usd), unidad: 'USD', cambio_24h: round(j[cgId].usd_24h_change), fuente: 'CoinGecko' };
      recordar(simbolo, item); return item;
    }
  } catch (_) {}
  // 2) Coinbase (solo precio spot)
  try {
    const j = await fetchJSON(`https://api.coinbase.com/v2/prices/${coinbaseSym}/spot`);
    const v = parseFloat(j?.data?.amount);
    if (isFinite(v)) { const item = { nombre, simbolo, valor: round(v), unidad: 'USD', cambio_24h: null, fuente: 'Coinbase' }; recordar(simbolo, item); return item; }
  } catch (_) {}
  // 3) Binance (precio + cambio 24h)
  try {
    const j = await fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`);
    const v = parseFloat(j?.lastPrice);
    if (isFinite(v)) { const item = { nombre, simbolo, valor: round(v), unidad: 'USD', cambio_24h: round(parseFloat(j.priceChangePercent)), fuente: 'Binance' }; recordar(simbolo, item); return item; }
  } catch (_) {}
  // 4) Fallback: último valor conocido con antigüedad, o "no disponible" honesto
  return conAntiguedad(simbolo) || { nombre, simbolo, valor: null, unidad: 'USD', cambio_24h: null, fuente: 'sin fuente disponible' };
}

// ── Divisas: Frankfurter (BCE) → er-api ──
async function divisaUSDtoEUR() {
  try {
    const j = await fetchJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR');
    if (j?.rates?.EUR) { const item = { nombre: 'Dólar → Euro', simbolo: 'USD/EUR', valor: round(j.rates.EUR, 4), unidad: 'EUR', cambio_24h: null, fuente: 'BCE (Frankfurter)', fecha_dato: j.date }; recordar('USD/EUR', item); return item; }
  } catch (_) {}
  try {
    const j = await fetchJSON('https://open.er-api.com/v6/latest/USD');
    if (j?.rates?.EUR) { const item = { nombre: 'Dólar → Euro', simbolo: 'USD/EUR', valor: round(j.rates.EUR, 4), unidad: 'EUR', cambio_24h: null, fuente: 'er-api' }; recordar('USD/EUR', item); return item; }
  } catch (_) {}
  return conAntiguedad('USD/EUR') || { nombre: 'Dólar → Euro', simbolo: 'USD/EUR', valor: null, unidad: 'EUR', cambio_24h: null, fuente: 'sin fuente disponible' };
}

async function obtenerMercados() {
  const [btc, eth, oro, fx] = await Promise.all([
    precioCripto('bitcoin', 'BTC-USD', 'BTCUSDT', 'Bitcoin', 'BTC'),
    precioCripto('ethereum', 'ETH-USD', 'ETHUSDT', 'Ethereum', 'ETH'),
    precioCripto('pax-gold', 'PAXG-USD', 'PAXGUSDT', 'Oro (onza troy)', 'XAU'),
    divisaUSDtoEUR(),
  ]);

  const items = [btc, eth, oro, fx];
  // Balboa: paridad legal fija (hecho verificable, no precio de mercado)
  items.push({ nombre: 'Balboa', simbolo: 'PAB', valor: 1, unidad: 'USD', cambio_24h: 0, fuente: 'Paridad legal 1:1 con USD', nota: 'Anclado al dólar desde 1904.' });

  const sinDato = items.filter(i => i.valor == null).length;
  return {
    titulo: 'Mercados (contexto)',
    items,
    generado: new Date().toISOString(),
    disclaimer: 'Precios de referencia con su hora y fuente, vía múltiples proveedores con respaldo. Dato de contexto, NO asesoría de inversión. Si todas las fuentes caen, se muestra el último dato real con su antigüedad; nunca un valor inventado.',
    sin_dato: sinDato,
  };
}

module.exports = { obtenerMercados };
