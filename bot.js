// ============================================================
// Croma Stock Checker Telegram Bot
// - Admin approval system (only approved users can use)
// - Control panel: Start Track / Stop Track / My Tracking List
// - Max 30 products per user, refresh every 15s
// - Alerts on Telegram when "Buy Now" is available (in stock)
// - 30s self-ping to prevent Render free tier sleep
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN || '8663516925:AAGQGO6HgV7IxNgJdSgvpSFTTHHROFciBrU';
const ADMIN_ID  = parseInt(process.env.ADMIN_ID || '7485181331', 10);
const CHECK_INTERVAL_MS = 15 * 1000;   // 15s product refresh
const PING_INTERVAL_MS  = 30 * 1000;   // 30s self ping
const MAX_TRACK_PER_USER = 30;
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || ''; // auto-set by Render

// ---------- STATE (in-memory) ----------
const approvedUsers = new Set([ADMIN_ID]);   // approved user IDs
const pendingUsers  = new Map();              // userId -> {name, username}
const awaitingProductId = new Set();          // users currently asked to send product id
const tracking = new Map();                   // userId -> Map(productId -> {title, url, lastStatus})

function getUserTracking(uid) {
  if (!tracking.has(uid)) tracking.set(uid, new Map());
  return tracking.get(uid);
}

// ---------- TELEGRAM BOT ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Main control panel keyboard
function controlPanel() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'â–¶ï¸ Start a Track', callback_data: 'start_track' }],
        [{ text: 'ðŸ“‹ My Tracking List', callback_data: 'list_track' }],
        [{ text: 'â¹ Stop a Track', callback_data: 'stop_track' }],
      ],
    },
  };
}

// ---------- /start ----------
bot.onText(/\/start/, (msg) => {
  const uid = msg.from.id;
  const name = msg.from.first_name || 'User';
  const username = msg.from.username ? '@' + msg.from.username : '(no username)';

  if (uid === ADMIN_ID || approvedUsers.has(uid)) {
    bot.sendMessage(uid,
      `âœ… Welcome ${name}!\n\nCroma Stock Checker Bot â€” Control Panel`,
      controlPanel());
    return;
  }

  // Not approved
  if (pendingUsers.has(uid)) {
    bot.sendMessage(uid, 'â³ Access pending. Admin will approve soon.');
    return;
  }

  pendingUsers.set(uid, { name, username });
  bot.sendMessage(uid, 'ðŸš« Access Denied.\n\nYour request has been sent to the admin for approval. Please wait.');

  // Notify admin with approve / decline buttons
  bot.sendMessage(ADMIN_ID,
    `ðŸ”” *New access request*\n\nðŸ‘¤ Name: ${name}\nðŸ†” ID: \`${uid}\`\nðŸ“› Username: ${username}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'âœ… Approve', callback_data: `approve_${uid}` },
          { text: 'âŒ Decline', callback_data: `decline_${uid}` },
        ]],
      },
    });
});

// ---------- Callback handler ----------
bot.on('callback_query', async (q) => {
  const uid  = q.from.id;
  const data = q.data;
  const chatId = q.message.chat.id;

  // Admin approve/decline
  if (data.startsWith('approve_') || data.startsWith('decline_')) {
    if (uid !== ADMIN_ID) {
      return bot.answerCallbackQuery(q.id, { text: 'Only admin can do this.' });
    }
    const targetId = parseInt(data.split('_')[1], 10);
    const info = pendingUsers.get(targetId);
    pendingUsers.delete(targetId);

    if (data.startsWith('approve_')) {
      approvedUsers.add(targetId);
      bot.editMessageText(`âœ… Approved user ${info?.name || ''} (\`${targetId}\`)`,
        { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'Markdown' });
      try {
        await bot.sendMessage(targetId, 'ðŸŽ‰ Your access has been *approved* by admin!', { parse_mode: 'Markdown' });
        await bot.sendMessage(targetId, 'Control Panel:', controlPanel());
      } catch (_) {}
    } else {
      bot.editMessageText(`âŒ Declined user ${info?.name || ''} (\`${targetId}\`)`,
        { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'Markdown' });
      try { await bot.sendMessage(targetId, 'ðŸš« Your access request was *declined* by admin.', { parse_mode: 'Markdown' }); } catch (_) {}
    }
    return bot.answerCallbackQuery(q.id);
  }

  // From here on, only approved users
  if (!approvedUsers.has(uid)) {
    return bot.answerCallbackQuery(q.id, { text: 'Access denied.' });
  }

  if (data === 'start_track') {
    const list = getUserTracking(uid);
    if (list.size >= MAX_TRACK_PER_USER) {
      bot.answerCallbackQuery(q.id);
      return bot.sendMessage(uid, `âš ï¸ You already track ${list.size}/${MAX_TRACK_PER_USER} products. Stop one first.`);
    }
    awaitingProductId.add(uid);
    bot.answerCallbackQuery(q.id);
    return bot.sendMessage(uid, 'ðŸ“¦ Send product id to track (6-digit Croma product id, e.g. `304500`).', { parse_mode: 'Markdown' });
  }

  if (data === 'list_track') {
    const list = getUserTracking(uid);
    bot.answerCallbackQuery(q.id);
    if (list.size === 0) return bot.sendMessage(uid, 'You are not tracking any product yet.');
    let txt = `ðŸ“‹ *Tracking (${list.size}/${MAX_TRACK_PER_USER})*\n\n`;
    let i = 1;
    for (const [pid, p] of list) {
      txt += `${i++}. \`${pid}\` â€” ${p.title || 'Croma Product'}\n   Status: ${p.lastStatus || 'checking...'}\n`;
    }
    return bot.sendMessage(uid, txt, { parse_mode: 'Markdown' });
  }

  if (data === 'stop_track') {
    const list = getUserTracking(uid);
    bot.answerCallbackQuery(q.id);
    if (list.size === 0) return bot.sendMessage(uid, 'Nothing to stop.');
    const buttons = [];
    for (const [pid, p] of list) {
      buttons.push([{ text: `âŒ ${pid} â€” ${(p.title || '').slice(0, 30)}`, callback_data: `del_${pid}` }]);
    }
    return bot.sendMessage(uid, 'Select a product to stop tracking:', { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith('del_')) {
    const pid = data.slice(4);
    const list = getUserTracking(uid);
    if (list.delete(pid)) {
      bot.answerCallbackQuery(q.id, { text: 'Removed.' });
      bot.editMessageText(`ðŸ—‘ Removed \`${pid}\` from tracking.`,
        { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'Markdown' });
    } else {
      bot.answerCallbackQuery(q.id, { text: 'Not found.' });
    }
    return;
  }
});

// ---------- Receive product id messages ----------
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const uid = msg.from.id;
  if (!awaitingProductId.has(uid)) return;
  if (!approvedUsers.has(uid)) return;

  const pid = msg.text.trim();
  if (!/^\d{6,}$/.test(pid)) {
    return bot.sendMessage(uid, 'âŒ Invalid. Send only digits (6+).');
  }
  awaitingProductId.delete(uid);

  const list = getUserTracking(uid);
  if (list.has(pid)) return bot.sendMessage(uid, 'â„¹ï¸ Already tracking this product.');
  if (list.size >= MAX_TRACK_PER_USER) return bot.sendMessage(uid, 'âš ï¸ Limit reached.');

  await bot.sendMessage(uid, `ðŸ”Ž Searching Croma for product id \`${pid}\`...`, { parse_mode: 'Markdown' });

  const found = await findProductByPid(pid);
  if (!found) {
    return bot.sendMessage(uid, `âŒ Could not find product \`${pid}\` on Croma.`, { parse_mode: 'Markdown' });
  }

  list.set(pid, { title: found.title, url: found.url, lastStatus: 'checking...' });
  bot.sendMessage(uid,
    `âœ… Tracking started!\n\nðŸ“¦ *${found.title}*\nðŸ†” \`${pid}\`\nðŸ”— ${found.url}\n\nYou will be alerted when *Buy Now* (in-stock) appears.`,
    { parse_mode: 'Markdown', disable_web_page_preview: true });
});

// ---------- CROMA SCRAPER ----------
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-IN,en;q=0.9',
};

async function findProductByPid(pid) {
  // 1) Try direct PDP URL pattern
  const direct = `https://www.croma.com/sp/${pid}`;
  try {
    const r = await axios.get(direct, { headers: HEADERS, maxRedirects: 5, timeout: 15000, validateStatus: () => true });
    if (r.status === 200 && r.data && /buy\s*now|sold\s*out|notify\s*me/i.test(r.data)) {
      const $ = cheerio.load(r.data);
      const title = ($('h1').first().text() || $('title').text() || 'Croma Product').trim();
      return { title, url: r.request?.res?.responseUrl || direct };
    }
  } catch (_) {}

  // 2) Search bar fallback
  try {
    const sUrl = `https://www.croma.com/searchB?q=${pid}&text=${pid}`;
    const r = await axios.get(sUrl, { headers: HEADERS, timeout: 15000, validateStatus: () => true });
    if (r.status === 200) {
      const $ = cheerio.load(r.data);
      const a = $('a[href*="/p/"]').first();
      if (a && a.attr('href')) {
        let url = a.attr('href');
        if (!url.startsWith('http')) url = 'https://www.croma.com' + url;
        const title = (a.text() || $('h3').first().text() || 'Croma Product').trim().replace(/\s+/g, ' ');
        return { title, url };
      }
    }
  } catch (_) {}

  return null;
}

async function checkStock(url) {
  try {
    const r = await axios.get(url, { headers: HEADERS, timeout: 15000, validateStatus: () => true });
    if (r.status !== 200 || !r.data) return { inStock: false, label: 'unreachable' };
    const html = String(r.data).toLowerCase();

    // Out-of-stock signals
    if (/sold\s*out|notify\s*me|out\s*of\s*stock|currently\s*unavailable/.test(html)) {
      return { inStock: false, label: 'âŒ Out of stock' };
    }
    // In-stock signals
    if (/buy\s*now|add\s*to\s*cart/.test(html)) {
      return { inStock: true, label: 'ðŸŸ¢ In stock (Buy Now)' };
    }
    return { inStock: false, label: 'â“ Unknown' };
  } catch (e) {
    return { inStock: false, label: 'error' };
  }
}

// ---------- PERIODIC TRACKER ----------
async function runChecks() {
  for (const [uid, list] of tracking) {
    for (const [pid, p] of list) {
      const res = await checkStock(p.url);
      const prev = p.lastStatus || '';
      p.lastStatus = res.label;

      // Alert: transitioned to in-stock
      if (res.inStock && !/in stock/i.test(prev)) {
        try {
          await bot.sendMessage(uid,
            `ðŸš¨ *STOCK ALERT!* ðŸš¨\n\nðŸ“¦ ${p.title}\nðŸ†” \`${pid}\`\nâœ… Buy Now is now available!\n\nðŸ”— ${p.url}`,
            { parse_mode: 'Markdown', disable_web_page_preview: false });
        } catch (_) {}
      }
    }
  }
}
setInterval(() => { runChecks().catch(() => {}); }, CHECK_INTERVAL_MS);

// ---------- KEEP-ALIVE WEB SERVER (for Render) ----------
const app = express();
app.get('/', (_, res) => res.send('Croma Stock Bot is alive âœ…'));
app.get('/health', (_, res) => res.json({ ok: true, users: approvedUsers.size, tracking: [...tracking.values()].reduce((a, m) => a + m.size, 0) }));
app.listen(PORT, () => console.log('HTTP server on', PORT));

// Self-ping every 30s so Render free tier doesn't sleep (50s inactivity limit)
setInterval(async () => {
  if (!RENDER_URL) return;
  try { await axios.get(RENDER_URL, { timeout: 10000 }); } catch (_) {}
}, PING_INTERVAL_MS);

console.log('ðŸ¤– Croma Stock Checker Bot started.');
bot.sendMessage(ADMIN_ID, 'ðŸ¤– Bot started and online âœ…').catch(() => {});
