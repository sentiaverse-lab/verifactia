'use strict';
/**
 * VerifactIA — Capa de alertas al encargado.
 *
 * Cuando el scheduler detecta noticias NUEVAS de alta prioridad, notifica al
 * editor por email (y, opcionalmente, deja listo el canal WhatsApp).
 *
 * Diseño anti-spam:
 *   - Solo noticias nuevas que superan el umbral RUINE.
 *   - Una sola notificación por ciclo (agrupa todas las alertas).
 *   - Si no hay SMTP configurado → MODO LOG (registra la alerta, no rompe la demo).
 *
 * Config por .env (opcional):
 *   ALERT_EMAIL_TO       destinatario (editor)
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *   APP_PUBLIC_URL       base para los links a las fichas (ej. https://verifactia.onrender.com)
 */

const { registrarEvento } = require('./memory');

const EMAIL_TO   = process.env.ALERT_EMAIL_TO || '';
const SMTP_HOST  = process.env.SMTP_HOST || '';
const SMTP_PASS  = process.env.SMTP_PASS || '';
const SMTP_FROM  = process.env.SMTP_FROM || process.env.SMTP_USER || 'onboarding@resend.dev';
const APP_URL    = (process.env.APP_PUBLIC_URL || 'http://localhost:4800').replace(/\/$/, '');

// Preferir la API HTTP de Resend (puerto 443, no se bloquea en la nube) si la
// clave es de Resend (re_...). SMTP (587) se bloquea en muchos hosts (Render free).
const RESEND_KEY = (process.env.RESEND_API_KEY || (SMTP_PASS.startsWith('re_') ? SMTP_PASS : '')) || '';
const RESEND_LISTO = !!(RESEND_KEY && EMAIL_TO);

// nodemailer es opcional (fallback SMTP si no hay Resend).
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* modo log */ }
const SMTP_LISTO = !!(nodemailer && SMTP_HOST && EMAIL_TO && !RESEND_LISTO);

function transporter() {
  if (!SMTP_LISTO) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

// Envío vía API HTTP de Resend (robusto desde la nube)
async function enviarResend(asunto, cuerpo) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: SMTP_FROM, to: [EMAIL_TO], subject: asunto, text: cuerpo }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Resend HTTP ${resp.status}: ${txt.slice(0, 120)}`);
  }
  return resp.json().catch(() => ({}));
}

function construirCuerpo(alertas, modo) {
  const lineas = alertas.map((n, i) => {
    const c = n.componentes || {};
    const comp = c.R !== undefined ? `R${Math.round(c.R*100)} I${Math.round(c.I*100)} U${Math.round(c.U*100)} N${Math.round(c.N*100)} E${Math.round(c.E*100)}` : '';
    const link = `${APP_URL}/?modo=${modo}#${encodeURIComponent(n.id || '')}`;
    return `${i + 1}. [${Math.round(n.puntaje)}/${n.nivel}] ${n.titulo}
     Fuente: ${n.medio || 's/d'} · ${n.fecha ? n.fecha.slice(0,10) : 's/f'}
     RUINE: ${comp}
     Ficha: ${link}`;
  }).join('\n\n');

  return `VerifactIA detectó ${alertas.length} noticia(s) NUEVA(S) de alta prioridad (modalidad ${modo.toUpperCase()}):

${lineas}

— Estas son señales priorizadas automáticamente. La decisión editorial (aprobar / pedir evidencia / descartar) es humana.
VerifactIA · copiloto de inteligencia informativa`;
}

/**
 * Notifica un lote de alertas de un ciclo. Devuelve el canal usado.
 */
async function notificarAlertas(alertas, modo = 'tvn') {
  if (!alertas || !alertas.length) return { enviado: false, motivo: 'sin_alertas' };

  const asunto = `🔴 VerifactIA (${modo.toUpperCase()}): ${alertas.length} noticia(s) de alta prioridad`;
  const cuerpo = construirCuerpo(alertas, modo);

  // Canal 1 (preferido): API HTTP de Resend — robusta desde la nube (puerto 443)
  if (RESEND_LISTO) {
    try {
      await enviarResend(asunto, cuerpo);
      registrarEvento('email', `📧 Alerta enviada por email a ${EMAIL_TO} (${alertas.length} noticia/s)`, { modo });
      return { enviado: true, canal: 'resend', destino: EMAIL_TO };
    } catch (e) {
      registrarEvento('email_error', `⚠ Falló envío (Resend): ${e.message}`, { modo });
      // cae a SMTP o modo log
    }
  }

  // Canal 2: SMTP (si está configurado y no hubo Resend)
  if (SMTP_LISTO) {
    try {
      await transporter().sendMail({ from: SMTP_FROM, to: EMAIL_TO, subject: asunto, text: cuerpo });
      registrarEvento('email', `📧 Alerta enviada por email a ${EMAIL_TO} (${alertas.length} noticia/s)`, { modo });
      return { enviado: true, canal: 'smtp', destino: EMAIL_TO };
    } catch (e) {
      registrarEvento('email_error', `⚠ Falló envío de email: ${e.message}`, { modo });
      // cae a modo log
    }
  }

  // Canal 2 (fallback): MODO LOG — registra la alerta para el panel/histórico
  const destino = EMAIL_TO || 'editor (no configurado)';
  registrarEvento('email_log', `📧 [MODO LOG] Alerta para ${destino}: ${asunto}`, { modo, cuerpo });
  return { enviado: false, canal: 'log', destino, asunto };
}

/**
 * WhatsApp: documentado como integrable. Para el reto NO se conecta al bot real
 * (evita exponer la infraestructura del motor). Se deja el punto de extensión.
 */
async function notificarWhatsApp(/* alertas, modo */) {
  registrarEvento('whatsapp_log', '💬 [INTEGRABLE] Canal WhatsApp disponible para conectar (no activo en demo)');
  return { enviado: false, canal: 'whatsapp', motivo: 'integrable_no_activo' };
}

function estadoAlertas() {
  const listo = RESEND_LISTO || SMTP_LISTO;
  return {
    email_configurado: listo,
    destino: EMAIL_TO || null,
    canal: RESEND_LISTO ? 'resend-http' : SMTP_LISTO ? 'smtp' : 'log',
    modo: listo ? 'email' : 'log',
    whatsapp: 'integrable_no_activo',
  };
}

module.exports = { notificarAlertas, notificarWhatsApp, estadoAlertas };
