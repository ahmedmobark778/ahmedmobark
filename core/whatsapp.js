'use strict';
// WhatsApp Web adapter. This uses an unofficial client library; it is not Meta's official Cloud API.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

function makeWhatsAppManager({ db, log, sessionsDir = path.join(__dirname, '..', 'sessions') }) {
  const sessions = new Map();
  const cooldowns = new Map();
  let baileysPromise;
  const getBaileys = () => baileysPromise ||= import('@whiskeysockets/baileys');

  function getStatus(id) {
    const s = sessions.get(Number(id));
    if (!s) return { status: 'disconnected', qr: null, pairingCode: null, message: 'البوت غير متصل' };
    return { status: s.status, qr: s.qr || null, pairingCode: s.pairingCode || null, message: s.message || '' };
  }
  function permitted(command, sender, isGroup, isAdmin, ownerPhone) {
    const digits = String(sender || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const ownerDigits = String(ownerPhone || '').replace(/\D/g, '');
    if (command.permission === 'all') return true;
    if (command.permission === 'owner') return !!ownerDigits && digits === ownerDigits;
    if (command.permission === 'admin') return isAdmin || (!!ownerDigits && digits === ownerDigits);
    if (command.permission === 'groupadmin') return isGroup && isAdmin;
    return false;
  }
  async function onMessages(bot, sock, messages) {
    for (const msg of messages || []) {
      if (!msg.message || msg.key?.fromMe || msg.key?.remoteJid === 'status@broadcast') continue;
      const chat = msg.key.remoteJid;
      const isGroup = chat.endsWith('@g.us');
      const sender = isGroup ? (msg.key.participant || '') : chat;
      const text = extractText(msg.message).trim();
      if (!text) continue;
      const command = db.prepare('SELECT * FROM commands WHERE bot_id=? AND enabled=1 ORDER BY length(trigger_text) DESC').all(bot.id).find(c => text === c.trigger_text || text.startsWith(c.trigger_text + ' '));
      if (!command) continue;
      let isAdmin = false;
      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(chat);
          const participant = meta.participants.find(p => p.id === sender || p.phoneNumber === sender);
          isAdmin = !!participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
        } catch { /* Group metadata may be temporarily unavailable. */ }
      }
      if (!permitted(command, sender, isGroup, isAdmin, bot.owner_phone)) continue;
      const key = `${bot.id}:${chat}:${sender}:${command.id}`;
      const now = Date.now(), until = cooldowns.get(key) || 0;
      if (until > now) continue;
      cooldowns.set(key, now + Math.max(0, Number(command.cooldown) || 0) * 1000);
      const args = text.slice(command.trigger_text.length).trim();
      const response = command.response_text.replaceAll('{user}', '@' + String(sender).split('@')[0]).replaceAll('{args}', args).replaceAll('{bot}', bot.name);
      try { await sock.sendMessage(chat, { text: response }, { quoted: msg }); }
      catch (e) { console.error('WhatsApp send error for bot', bot.id, e.message); }
    }
  }
  function extractText(m) {
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedButtonId || m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
  }
  async function connect(bot, { requestPairing = false } = {}) {
    const id = Number(bot.id);
    const current = sessions.get(id);
    if (current?.status === 'connected') return getStatus(id);
    if (current?.starting) return getStatus(id);
    if (!['qr', 'code'].includes(bot.method)) throw new Error('طريقة الربط غير صحيحة');
    if (requestPairing && !String(bot.phone || '').replace(/\D/g, '')) throw new Error('أدخل رقم واتساب بصيغة دولية في خانة رقم الربط، مثال 2010xxxxxxxx');
    const state = { status: 'connecting', qr: null, pairingCode: null, message: 'جاري الاتصال بواتساب…', starting: true, sock: null, wantPairing: requestPairing };
    sessions.set(id, state);
    fs.mkdirSync(path.join(sessionsDir, String(id)), { recursive: true, mode: 0o700 });
    try {
      const B = await getBaileys();
      const makeWASocket = B.default || B.makeWASocket;
      const { state: authState, saveCreds } = await B.useMultiFileAuthState(path.join(sessionsDir, String(id)));
      const { version } = await B.fetchLatestBaileysVersion();
      const sock = makeWASocket({ version, auth: authState, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false, browser: ['ahmedmobark', 'Chrome', '1.0.0'] });
      state.sock = sock;
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('messages.upsert', ({ messages, type }) => { if (type === 'notify') onMessages(bot, sock, messages).catch(e => console.error('Command handler error', e.message)); });
      sock.ev.on('connection.update', async update => {
        if (update.qr && !state.wantPairing) {
          state.qr = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 }).catch(() => null);
          state.status = 'qr'; state.message = 'امسح رمز QR من واتساب > الأجهزة المرتبطة';
        }
        if (update.connection === 'open') {
          state.status = 'connected'; state.qr = null; state.pairingCode = null; state.message = 'واتساب متصل والبوت يستقبل الرسائل';
          db.prepare("UPDATE bots SET status='connected' WHERE id=?").run(id);
          log({ id: bot.owner_id }, 'bot_connected', bot.name);
        }
        if (update.connection === 'close') {
          const code = update.lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === 401;
          state.status = loggedOut ? 'disconnected' : 'reconnecting'; state.qr = null;
          state.message = loggedOut ? 'تم تسجيل الخروج من واتساب؛ احذف الجلسة وأعد الربط' : 'انقطع الاتصال؛ جارٍ إعادة المحاولة';
          if (loggedOut) { db.prepare("UPDATE bots SET status='setup' WHERE id=?").run(id); sessions.delete(id); }
          else setTimeout(() => { const latest = sessions.get(id); if (latest === state && latest.status === 'reconnecting') { sessions.delete(id); connect(bot).catch(e => console.error('Reconnect error', e.message)); } }, 2500);
        }
      });
      if (requestPairing && !sock.authState?.creds?.registered && !authState.creds.registered) {
        // Allow the socket's initial handshake to settle before requesting a pairing code.
        await new Promise(resolve => setTimeout(resolve, 1200));
        const phone = String(bot.phone).replace(/\D/g, '');
        state.pairingCode = await sock.requestPairingCode(phone);
        state.status = 'code'; state.message = 'أدخل كود الاقتران في واتساب > الأجهزة المرتبطة';
      }
      state.starting = false;
      return getStatus(id);
    } catch (e) {
      sessions.delete(id); db.prepare("UPDATE bots SET status='setup' WHERE id=?").run(id);
      throw new Error('تعذر بدء موصل واتساب: ' + (e.message || 'خطأ غير معروف'));
    }
  }
  async function disconnect(bot) {
    const id = Number(bot.id), state = sessions.get(id);
    if (state?.sock) { try { state.sock.ev.removeAllListeners('connection.update'); await state.sock.logout(); } catch { try { state.sock.end(undefined); } catch {} } }
    sessions.delete(id);
    const dir = path.join(sessionsDir, String(id));
    fs.rmSync(dir, { recursive: true, force: true });
    db.prepare("UPDATE bots SET status='setup' WHERE id=?").run(id);
    log({ id: bot.owner_id }, 'bot_disconnected', bot.name);
    return getStatus(id);
  }
  function remove(bot) {
    const id = Number(bot.id), state = sessions.get(id);
    if (state?.sock) { try { state.sock.end(undefined); } catch {} }
    sessions.delete(id); fs.rmSync(path.join(sessionsDir, String(id)), { recursive: true, force: true });
  }
  async function restore() {
    const rows = db.prepare('SELECT * FROM bots').all();
    for (const bot of rows) {
      const creds = path.join(sessionsDir, String(bot.id), 'creds.json');
      if (fs.existsSync(creds)) connect(bot).catch(e => console.error('Session restore failed for bot', bot.id, e.message));
    }
  }
  return { connect, disconnect, remove, getStatus, restore };
}
module.exports = { makeWhatsAppManager };
