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
const APP_URL    = (process.env.APP_PUBLIC_URL || 'http://localhost:4800').replace(/\/$/, '');

// nodemailer es opcional: si no está instalado o no hay SMTP, usamos modo log.
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* modo log */ }

const SMTP_LISTO = !!(nodemailer && SMTP_HOST && EMAIL_TO);

function transporter() {
  if (!SMTP_LISTO) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
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

  // Canal 1: Email (si SMTP configurado)
  if (SMTP_LISTO) {
    try {
      await transporter().sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER || 'verifactia@localhost',
        to: EMAIL_TO,
        subject: asunto,
        text: cuerpo,
      });
      registrarEvento('email', `📧 Alerta enviada por email a ${EMAIL_TO} (${alertas.length} noticia/s)`, { modo });
      return { enviado: true, canal: 'email', destino: EMAIL_TO };
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
  return {
    email_configurado: SMTP_LISTO,
    destino: EMAIL_TO || null,
    modo: SMTP_LISTO ? 'email' : 'log',
    whatsapp: 'integrable_no_activo',
  };
}

module.exports = { notificarAlertas, notificarWhatsApp, estadoAlertas };
