require('dotenv').config();
const express     = require('express');
const axios       = require('axios');
const cheerio     = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const https       = require('https');
const http        = require('http');

// --- 🔒 CONFIGURATION HARDLOCKED ---
const BOT_TOKEN     = process.env.BOT_TOKEN     || '8663516925:AAGQGO6HgV7IxNgJdSgvpSFTTHHROFciBrU';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '7485181331';
const PORT          = process.env.PORT          || 10000; 
const RENDER_URL    = process.env.RENDER_URL    || 'https://fk-stock-final.onrender.com'; // Apni naya croma render URL change kar sakte ho env me
const CHECK_MS      = 15000; // Har 15 second mein automatic refresh check
const MAX_PRODUCTS  = 30;    // Maximum 30 products allowed per user

// ─── DATA MATRIX ─────────────────────────────────────────────────────────────
const DATA_FILE = './croma_data.json';
function loadDB() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  return { products: [], approvedUsers: [], pendingUsers: [], isChecking: true };
}
function saveDB() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) {} }
let db = loadDB();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- STATE MANAGEMENT CONTROL ---
const userStates = new Map(); // chatId -> 'WAITING_FOR_PRODUCT_ID'

// ─── TELEGRAM ENGINE ──────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

async function tg(chatId, text, extra = {}) {
  try { return await bot.sendMessage(String(chatId), text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  catch (e) { console.error('[TG Error]', e.message); }
}

function isApproved(id) { return String(id) === String(ADMIN_CHAT_ID) || db.approvedUsers.includes(String(id)); }

// Keyboard Builder Helper
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '➕ Start a Track' }],
        [{ text: '📋 List Active Tracks' }, { text: '🛑 Stop a Track' }],
        [{ text: '📊 Check Bot Status' }]
      ],
      resize_keyboard: true
    }
  };
}

// ─── BOT ROUTING COMMANDS ─────────────────────────────────────────────────────
bot.onText(/\/start/, async msg => {
  const cid = String(msg.chat.id), name = msg.from.first_name || 'User';
  
  if (isApproved(cid)) {
    return bot.sendMessage(cid, 
      `⚡ <b>Croma Real-Time Stock Checker</b>\n\nWelcome back <b>${name}</b>! Niche diye gaye menu buttons se control karein.`, 
      mainMenuKeyboard()
    );
  }

  if (!db.pendingUsers.includes(cid)) {
    db.pendingUsers.push(cid); saveDB();
    
    // Admin ko Approve/Decline Inline Buttons ke sath message bhejein
    const inlineMarkup = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve User', callback_data: `approve_${cid}` },
            { text: '❌ Decline', callback_data: `deny_${cid}` }
          ]
        ]
      }
    };
    tg(ADMIN_CHAT_ID, `🔔 <b>New Croma Access Request</b>\n👤 Name: <b>${name}</b>\n🆔 ID: <code>${cid}</code>`, inlineMarkup);
  }
  
  tg(cid, `⛔ <b>Access Denied!</b>\n⏳ Aapki request Admin ke paas bhej di gayi hai. Kirpya approval ka intezar karein.\nYour ID: <code>${cid}</code>`);
});

// ─── REYPLY BUTTONS HANDLER ───────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const cid = String(msg.chat.id);
  const text = (msg.text || '').trim();

  if (!isApproved(cid) || text.startsWith('/')) return;

  // Handle Button Clicks
  if (text === '➕ Start a Track') {
    userStates.set(cid, 'WAITING_FOR_PRODUCT_ID');
    return tg(cid, '📥 <b>Send product ID to track:</b>\nKirpya sirf 6-digit ka Croma Product ID bhejein (Example: <code>272145</code>).');
  }

  if (text === '📋 List Active Tracks') {
    const userProducts = db.products.filter(p => String(p.addedBy) === cid);
    if (!userProducts.length) return tg(cid, '📭 Aapki list mein koi product nahi hai. ➕ Start a Track par click karein.');
    
    let txt = `📋 <b>Your Active Tracks (${userProducts.length}/${MAX_PRODUCTS})</b>\n\n`;
    userProducts.forEach((p, i) => {
      txt += `${i+1}. <b>${p.name.slice(0, 45)}</b>\n   🆔 ID: <code>${p.pid}</code> | Status: ${p.inStock ? '🟢 IN STOCK' : '🔴 Out of Stock'}\n   ❌ Stop Track: /stop_${p.pid}\n\n`;
    });
    return tg(cid, txt);
  }

  if (text === '🛑 Stop a Track') {
    const userProducts = db.products.filter(p => String(p.addedBy) === cid);
    if (!userProducts.length) return tg(cid, '📭 Stop karne ke liye koi active track nahi mila.');
    
    let txt = `🛑 <b>Select product to stop tracking:</b>\nClick on the command link below:\n\n`;
    userProducts.forEach((p) => {
      txt += `• ${p.name.slice(0, 40)} (ID: <code>${p.pid}</code>) ➡️ /stop_${p.pid}\n`;
    });
    return tg(cid, txt);
  }

  if (text === '📊 Check Bot Status') {
    const userProducts = db.products.filter(p => String(p.addedBy) === cid);
    return tg(cid, 
      `📊 <b>Bot Active Status</b>\n\n🔄 Loop Engine: ${db.isChecking ? '🟢 24/7 Active' : '🔴 Stopped'}\n` +
      `📦 Your Monitored Items: ${userProducts.length}/${MAX_PRODUCTS}\n⏱ Refresh Speed: 15 seconds\n⏰ Time: ${new Date().toLocaleString('en-IN')}`
    );
  }

  // Handle User Input for 6-Digit Product ID
  if (userStates.get(cid) === 'WAITING_FOR_PRODUCT_ID') {
    userStates.delete(cid); // State clear karein
    
    if (!/^\d{6}$/.test(text)) {
      return tg(cid, '❌ <b>Invalid ID!</b> Kirpya dubara button daba kar sirf 6-digit ka numerical product ID bhejein.');
    }

    const userProducts = db.products.filter(p => String(p.addedBy) === cid);
    if (userProducts.length >= MAX_PRODUCTS) return tg(cid, `❌ Limit Full! Aap maximum ${MAX_PRODUCTS} products hi track kar sakte hain.`);
    if (db.products.find(p => p.pid === text && String(p.addedBy) === cid)) return tg(cid, '⚠️ Yeh product ID aapki list mein pehle se chal rahi hai.');

    await tg(cid, `⏳ Connecting Croma Server... ID [${text}] ko live fetch kiya jaa raha hai...`);
    const info = await scrapeCroma(text);
    
    if (!info) return tg(cid, '❌ <b>Croma Fetch Failed!</b> Ya toh yeh Product ID galat hai ya Croma ne hit block kiya hai. Kuch der baad dubara try karein.');

    const productObj = {
      id: Date.now(),
      pid: text,
      url: `https://www.croma.com/p/${text}`,
      name: info.name,
      inStock: info.inStock,
      lastChecked: new Date().toISOString(),
      addedBy: cid
    };

    db.products.push(productObj); saveDB();
    return tg(cid, `✅ <b>Product Tracking Added!</b>\n\n📦 <b>${info.name}</b>\n🆔 ID: <code>${text}</code>\n⚡ Current Status: ${info.inStock ? '🟢 <b>BUY NOW ACTIVE!</b>' : '🔴 Out of Stock'}\n\n🤖 Loop locked! Har 15s me monitoring chalu hai.`);
  }
});

// Slash Command Shortcuts for Removal Layout Link Mapping Matrix
bot.onText(/\/stop_(.+)/, async (msg, m) => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return;

  const targetPid = m[1].trim();
  const idx = db.products.findIndex(p => p.pid === targetPid && String(p.addedBy) === cid);
  
  if (idx === -1) return tg(cid, '❌ Product aapki tracking list mein nahi mila.');
  const [removed] = db.products.splice(idx, 1); saveDB();
  tg(cid, `🗑 Tracking stopped for:\n<b>${removed.name.slice(0, 50)}</b> (ID: ${targetPid})`);
});

// Admin Remove command fallback routing handler 
bot.onText(/\/removeuser (.+)/, async (msg, m) => {
  if (!String(msg.chat.id) === String(ADMIN_CHAT_ID)) return;
  const uid = String(m[1].trim());
  db.approvedUsers = db.approvedUsers.filter(u => u !== uid); saveDB();
  tg(ADMIN_CHAT_ID, `🗑 User <code>${uid}</code> removed from bot permission schema.`);
});

// ─── INTERACTIVE INLINE BUTTONS CALLBACKS ─────────────────────────────────────
bot.on('callback_query', async query => {
  const data = query.data || '';
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (String(query.from.id) !== String(ADMIN_CHAT_ID)) return;

  if (data.startsWith('approve_')) {
    const targetUid = data.split('_')[1];
    if (!db.approvedUsers.includes(targetUid)) {
      db.approvedUsers.push(targetUid);
      db.pendingUsers = db.pendingUsers.filter(u => u !== targetUid);
      saveDB();
      
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_CHAT_ID, message_id: query.message.message_id }).catch(() => {});
      tg(ADMIN_CHAT_ID, `✅ User <code>${targetUid}</code> successfully approved!`);
      tg(targetUid, `🎉 <b>Access Granted!</b> Aapko Admin ne approve kar diya hai. Bot use karne ke liye /start bhejein.`);
    }
  }

  if (data.startsWith('deny_')) {
    const targetUid = data.split('_')[1];
    db.pendingUsers = db.pendingUsers.filter(u => u !== targetUid); saveDB();
    
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_CHAT_ID, message_id: query.message.message_id }).catch(() => {});
    tg(ADMIN_CHAT_ID, `❌ User <code>${targetUid}</code> request declined.`);
    tg(targetUid, `❌ Aapki access request reject kar di gayi hai.`);
  }
});

// ─── CROMA CORE SCAPER ENGINE ─────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];
let uaIdx = 0;

async function scrapeCroma(pid) {
  const url = `https://www.croma.com/p/${pid}`;
  const currentUA = USER_AGENTS[uaIdx % USER_AGENTS.length];
  uaIdx++;

  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': currentUA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive'
      },
      timeout: 12000
    });

    const html = resp.data.toString();
    const $ = cheerio.load(html);

    // Fetch Product Name Layout
    let name = $('h1.pd-title').first().text().trim() 
            || $('h1').first().text().trim() 
            || 'Croma Product ' + pid;
    
    if (name.includes('Attention Required')) return null; // Captcha safety filter trigger

    // Strict Stock Check Matrix Algorithm: Search for "Buy Now" presence inside the static HTML 
    const isBuyNowPresent = /buy\s*now/i.test(html) || /add\s*to\s*cart/i.test(html);
    const isOutOfStockText = /out\s*of\s*stock/i.test(html) || /temporary\s*unavailable/i.test(html);

    let inStock = isBuyNowPresent && !isOutOfStockText;

    return { name: name.slice(0, 75), inStock };
  } catch (e) {
    console.error(`[Scraper Error] ID: ${pid} | Msg: ${e.message}`);
    return null;
  }
}

// ─── AUTOMATIC 15-SECOND MONITORING LOOP ──────────────────────────────────────
let loopTimer = null;
let loopRunning = false;

async function runCromaCheck() {
  if (loopRunning || !db.products.length) return;
  loopRunning = true;

  console.log(`[${new Date().toLocaleTimeString('en-IN')}] Checking ${db.products.length} product entries on Croma...`);

  for (const p of db.products) {
    try {
      const info = await scrapeCroma(p.pid);
      if (!info) {
        console.log(`[Loop Link Skip] Data stream missing for ID: ${p.pid}`);
        continue;
      }

      // Check if stock status switched from false to true (Stock Came Back!)
      if (info.inStock && !p.inStock) {
        p.inStock = true; p.lastChecked = new Date().toISOString(); saveDB();

        let alertMsg = `🎉 <b>CROMA STOCK JATKA ALERT!</b>\n\n📦 <b>${info.name}</b>\n🆔 Product ID: <code>${p.pid}</code>\n🟢 Status: <b>IN STOCK NOW! (BUY NOW GREEN)</b>\n\n🔗 <a href="${p.url}">Croma Pe Turant Buy Karo</a>\n⏰ Alert Time: ${new Date().toLocaleString('en-IN')}`;
        
        // Target specifically the exact mapped user slot owner
        await tg(p.addedBy, alertMsg);

        // Notify Admin copy if admin didn't add it 
        if (String(p.addedBy) !== String(ADMIN_CHAT_ID)) {
          await tg(ADMIN_CHAT_ID, `💡 [User Alert Copy]\n${alertMsg}`);
        }
        console.log(`[⚠️ STOCK LIVE] Alert sent to user ${p.addedBy} for ID: ${p.pid}`);
      } else {
        // Status remains same or flipped to out of stock quietly
        p.inStock = info.inStock;
        p.lastChecked = new Date().toISOString();
        saveDB();
        console.log(`[Check Status] ID: ${p.pid} | Live InStock: ${info.inStock} | No Change Trigger.`);
      }
    } catch (err) { console.error('[Loop Error Matrix]', err.message); }
    await new Promise(r => setTimeout(r, 2000)); // Sleep 2s between items inside the active batch loop to prevent instant IP rate blocks
  }

  loopRunning = false;
}

function startEngine() {
  if (checkTimer) return;
  db.isChecking = true; saveDB();
  checkTimer = setInterval(runCromaCheck, CHECK_MS);
  setTimeout(runCromaCheck, 3000);
}

let checkTimer = setInterval(runCromaCheck, CHECK_MS);
setTimeout(runCromaCheck, 3000);

// ─── 25-SECOND JHATKE WALA SELF-PING KEEP ALIVE LOOP ──────────────────────────
setInterval(() => {
  const pingUrl = `${RENDER_URL}/ping`;
  console.log('[Keeper] Triggering 25s Anti-Freeze Self Ping...');
  try {
    const protocolModule = pingUrl.startsWith('https') ? https : http;
    const request = protocolModule.get(pingUrl, () => {});
    request.on('error', () => {}); 
    request.setTimeout(4000, () => request.destroy());
  } catch (e) {}
}, 25000); // 25s loop ensures Render 50s sleep timer never activates!

// ─── HTTP API ROUTER MATRIX ───────────────────────────────────────────────────
app.get('/ping', (_, res) => res.json({ ok: true, msg: 'Stay awake framework verified', timestamp: Date.now() }));
app.get('/', (_, res) => res.send('<h3>Croma Realtime Anti-Ban 24/7 Engine Status: ACTIVE</h3>'));

app.listen(PORT, () => {
  console.log(`\n🚀 Web Server running successfully on port: ${PORT}`);
  console.log(`🤖 Telegram Bot Polling Engine: RUNNING | Admin Registered: ${ADMIN_CHAT_ID}\n`);
});
