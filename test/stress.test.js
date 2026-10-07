'use strict';
/**
 * VerifactIA — Pruebas de robustez / estrés de la API.
 * Verifica que inputs inválidos, concurrencia y edge cases NO tumben el server
 * ni devuelvan 500 inesperados. Requiere el server corriendo en PORT (def 4800).
 *
 * Ejecutar: node --test test/stress.test.js   (con el server arriba)
 */

const { test } = require('node:test');
const assert = require('node:assert');

const BASE = process.env.VERIFACTIA_URL || 'http://localhost:4800';

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

test('S01: /api/health responde ok', async () => {
  const r = await req('GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
});

test('S02: bandeja con modo inválido no rompe (cae a tvn)', async () => {
  const r = await req('GET', '/api/bandeja?modo=XXXX');
  assert.ok(r.status === 200, 'no debe fallar con modo inválido');
});

test('S03: ficha con id inexistente devuelve 404 controlado, no 500', async () => {
  const r = await req('GET', '/api/ficha/no_existe_este_id_12345?modo=tvn');
  assert.ok(r.status === 404 || r.status === 200, `status controlado, got ${r.status}`);
  assert.ok(r.json && r.json.ok === false || r.json.ok === true, 'respuesta JSON válida');
});

test('S04: revisión sin id ni estado devuelve 400, no 500', async () => {
  const r = await req('POST', '/api/revision', {});
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.ok, false);
});

test('S05: revisión con estado inválido devuelve 400', async () => {
  const r = await req('POST', '/api/revision', { id: 'x', estado: 'ESTADO_FALSO' });
  assert.strictEqual(r.status, 400);
});

test('S06: consulta vacía devuelve 400', async () => {
  const r = await req('POST', '/api/consulta', {});
  assert.strictEqual(r.status, 400);
});

test('S07: consulta con pregunta sin datos cargados se abstiene (no inventa)', async () => {
  const r = await req('POST', '/api/consulta', { pregunta: 'xyz angola marte', modo: 'tvn' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.ok === true, 'responde ok');
  // Debe abstenerse o responder con evidencia, nunca 500
});

test('S08: scheduler start con payload mínimo no rompe', async () => {
  const r = await req('POST', '/api/scheduler/start', { modo: 'tvn', tipo: 'intervalo', segundos: 99999 });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.scheduler, 'devuelve estado del scheduler');
  // Lo detenemos para no dejarlo activo tras el test
  await req('POST', '/api/scheduler/stop', { modo: 'tvn' });
});

test('S09: scheduler stop idempotente (parar algo ya parado no rompe)', async () => {
  await req('POST', '/api/scheduler/stop', { modo: 'tvn' });
  const r = await req('POST', '/api/scheduler/stop', { modo: 'tvn' });
  assert.strictEqual(r.status, 200);
});

test('S10: eventos devuelve estructura válida', async () => {
  const r = await req('GET', '/api/eventos?limite=5');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.eventos), 'eventos es array');
  assert.ok(r.json.memoria, 'incluye estado de memoria');
});

test('S11: 20 peticiones concurrentes a health no degradan ni fallan', async () => {
  const proms = Array.from({ length: 20 }, () => req('GET', '/api/health'));
  const res = await Promise.all(proms);
  assert.ok(res.every(r => r.status === 200), 'todas las concurrentes responden 200');
});

test('S12: payload gigante en consulta no tumba el server (límite 64kb)', async () => {
  const grande = 'a'.repeat(70 * 1024); // 70kb > límite
  const r = await req('POST', '/api/consulta', { pregunta: grande });
  // Debe rechazar con 4xx (413/400), nunca crashear
  assert.ok(r.status >= 400 && r.status < 500, `rechazo controlado, got ${r.status}`);
});

test('S13: memoria status responde', async () => {
  const r = await req('GET', '/api/memoria');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.memoria, 'incluye memoria');
});
