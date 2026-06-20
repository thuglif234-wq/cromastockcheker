const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- ðŸ”’ CONFIGURATION HARDLOCKED ---
const BOT_TOKEN = '8901855590:AAEHVFE4iGM2A0gzYeQzrj3hT1E8125uTEM';
const ADMIN_CHAT_ID = '7485181331';
const CHECK_INTERVAL = 15000; // STRICT 15 SECONDS
const RENDER_URL = 'https://croma-stock-final.onrender.com';
const DB_FILE = path.join(__dirname, 'database.json');
// ----------------------------------------

const bot = new Telegraf(BOT_TOKEN);
const activeUsers = {};
const userSessions = {};

let approvedUsersCache = [];

function initDatabase() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initialData = [ADMIN_CHAT_ID.toString()];
            fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
            approvedUsersCache = initialData;
            return;
        }
        const fileContent = fs.readFileSync(DB_FILE, 'utf8');
        if (!fileContent.trim()) {
            approvedUsersCache = [ADMIN_CHAT_ID.toString()];
            return;
        }
        const users = JSON.parse(fileContent);
        if (!Array.isArray(users)) {
            approvedUsersCache = [ADMIN_CHAT_ID.toString()];
            return;
        }
        if (!users.includes(ADMIN_CHAT_ID.toString())) {
            users.push(ADMIN_CHAT_ID.toString());
        }
        approvedUsersCache = users.map(String);
    } catch (e) {
        approvedUsersCache = [ADMIN_CHAT_ID.toString()];
    }
}

initDatabase();

function saveApprovedUsers(usersList) {
    try {
        const uniqueUsers = [...new Set(usersList.map(String))];
        if (!uniqueUsers.includes(ADMIN_CHAT_ID.toString())) {
            uniqueUsers.push(ADMIN_CHAT_ID.toString());
        }
        approvedUsersCache = uniqueUsers;
        fs.writeFileSync(DB_FILE, JSON.stringify(uniqueUsers, null, 2));
    } catch (e) {}
}

function isUserApproved(userId) {
    if (!userId) return false;
    return approvedUsersCache.includes(userId.toString());
}

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(bot.webhookCallback('/secret-telegram-webhook'));

app.get('/', (req, res) => res.status(200).send('Croma Stock Engine Core Online!'));

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`ðŸš€ Croma Stock Server listening on port ${PORT}`);
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.telegram.setWebhook(`${RENDER_URL}/secret-telegram-webhook`, {
            drop_pending_updates: true
        });
    } catch (err) {}
});

setInterval(() => {
    axios.get(RENDER_URL).catch(() => {});
}, 15000);

const getProKeyboard = () => {
    return Markup.keyboard([
        ['ðŸš¨ Start Stock Track'],
        ['ðŸ“‹ List Active', 'ðŸ›‘ Stop All Operations']
    ]).resize();
};

bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const clickerId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();

    if (data.startsWith('approve_')) {
        if (clickerId !== ADMIN_CHAT_ID.toString()) return ctx.answerCbQuery("Unauthorized! âŒ").catch(() => {});
        const targetUserId = data.split('_')[1].trim();

        initDatabase();
        if (!approvedUsersCache.includes(targetUserId)) {
            approvedUsersCache.push(targetUserId);
            saveApprovedUsers(approvedUsersCache);
        }

        await ctx.answerCbQuery("User Approved! âœ…").catch(() => {});
        await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\nâœ… **Status: Approved!**`).catch(() => {});
        bot.telegram.sendMessage(targetUserId, "ðŸ¥³ **Aapka access approve ho gaya hai!**\nCommands use karne ke liye ek baar `/start` dabayein.").catch(() => {});
        return;
    }

    if (data.startsWith('decline_')) {
        if (clickerId !== ADMIN_CHAT_ID.toString()) return ctx.answerCbQuery("Unauthorized! âŒ").catch(() => {});
        await ctx.answerCbQuery("User Declined! âŒ").catch(() => {});
        await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\nâŒ **Status: Declined!**`).catch(() => {});
        return;
    }

    if (data.startsWith('stoptrack_')) {
        const secretId = data.split('_')[1].trim();

        if (!activeUsers[chatId] || activeUsers[chatId].length === 0) {
            return ctx.answerCbQuery("âš ï¸ Koyi active operation nahi hai!", true).catch(() => {});
        }

        const itemIndex = activeUsers[chatId].findIndex(item => item.secretId === secretId);

        if (itemIndex === -1) {
            return ctx.answerCbQuery("âš ï¸ Pehle hi stopped ya removed hai!", true).catch(() => {});
        }

        const removedItem = activeUsers[chatId][itemIndex];
        clearInterval(removedItem.interval);
        activeUsers[chatId].splice(itemIndex, 1);

        await ctx.answerCbQuery("Stopped successfully! ðŸ›‘").catch(() => {});
        await ctx.editMessageText(`ðŸ›‘ <b>Target Radar Se Saaf!</b>\n\nðŸ“¦ <b>Stopped for:</b>\n<code>${removedItem.title}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        return;
    }
});

bot.start((ctx) => {
    const userId = ctx.from.id.toString();
    const name = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || 'No Name';

    initDatabase();
    if (isUserApproved(userId)) {
        delete userSessions[userId];
        return ctx.reply("ðŸ¤– *Welcome to Croma Stock Checker Pro!* Ready to sniff targets!", getProKeyboard());
    }

    ctx.reply(`ðŸ”’ **Access Denied!**\n\nAap abhi approved nahi hain.\nAapki Telegram ID: \`${userId}\`\n\nAdmin ko automatic request bhej di gayi hai.`);

    bot.telegram.sendMessage(ADMIN_CHAT_ID,
        `ðŸš¨ **New Croma Stock Bot Request!**\n\nðŸ‘¤ Name: ${name}\nðŸ†” ID: \`${userId}\`\n\nðŸ‘‰ Action lein:`,
        Markup.inlineKeyboard([[
            Markup.button.callback('Approve âœ…', `approve_${userId}`),
            Markup.button.callback('Decline âŒ', `decline_${userId}`)
        ]])
    ).catch(() => {});
});

bot.hears('ðŸš¨ Start Stock Track', (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isUserApproved(userId)) return;
    userSessions[userId] = 'stock';
    ctx.reply("ðŸ•µï¸â€â™‚ï¸ **Agent Croma Radar Ready!**\n\nOut of stock wale Croma product ka link bhejo bhai!");
});

bot.hears('ðŸ“‹ List Active', (ctx) => { displayActiveTracks(ctx); });
bot.hears('ðŸ›‘ Stop All Operations', (ctx) => { killAllOperations(ctx); });

bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id.toString();
    if (!isUserApproved(userId)) return;

    const textInput = ctx.message.text.trim();

    if (['ðŸš¨ start stock track', 'ðŸ“‹ list active', 'ðŸ›‘ stop all operations'].includes(textInput.toLowerCase())) return;

    if (userSessions[userId] === 'stock') {
        const args = ctx.message.text.replace(/\n/g, ' ').split(' ').filter(arg => arg.trim() !== '');
        let cromaLink = args.find(arg => arg.includes('croma.com'));

        if (!cromaLink) return ctx.reply("âŒ Valid Croma link bhejo bhai! (croma.com)", getProKeyboard());

        setupStockScraperSystem(ctx, cromaLink);
        delete userSessions[userId];
    }
});

async function setupStockScraperSystem(ctx, cromaLink) {
    const chatId = ctx.chat.id.toString();
    let pid = Buffer.from(cromaLink).toString('base64').substring(0, 10);
    let productTitle = "Croma Product";

    try {
        const res = await axios.get(cromaLink, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 12000
        });
        const $ = cheerio.load(res.data);
        let titleText = $('h1.pd-title').text().trim()
            || $('meta[property="og:title"]').attr('content')
            || $('title').text().split('|')[0].trim();
        if (titleText) productTitle = titleText.replace(/\s+/g, ' ').trim();
    } catch (e) {}

    if (!activeUsers[chatId]) activeUsers[chatId] = [];
    const intervalId = setInterval(() => { checkProductStockStatus(ctx, chatId, pid, cromaLink); }, CHECK_INTERVAL);

    const uniqueSecretId = crypto.randomBytes(3).toString('hex');

    activeUsers[chatId].push({
        id: pid, secretId: uniqueSecretId, url: cromaLink, title: productTitle, mode: 'Croma Stock Checker', interval: intervalId
    });

    ctx.reply(`ðŸ•µï¸â€â™‚ï¸ <b>Undercover Agent Radar Par Lock!</b>\n\nðŸ“¦ <b>Model:</b> <code>${productTitle}</code>\n\n15 second mein strict check locked hai boss!`, { parse_mode: 'HTML' });
    checkProductStockStatus(ctx, chatId, pid, cromaLink);
}

function displayActiveTracks(ctx) {
    const chatId = ctx.chat.id.toString();
    if (!activeUsers[chatId] || activeUsers[chatId].length === 0) return ctx.reply("ðŸ˜´ Koyi active target stock radar par nahi hai.");

    let msg = "ðŸ“‹ <b>Radar Par Active Croma Targets Matrix:</b>\n\n";
    ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});

    activeUsers[chatId].forEach((item, index) => {
        let card = `ðŸ”¢ <b>Target [${index + 1}]</b>\nðŸ“¦ <b>Name:</b> <code>${item.title}</code>\nâš™ï¸ <b>Mode:</b> <code>[${item.mode}]</code>\nðŸ”— <b>Link:</b> ${item.url}`;
        ctx.reply(card, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard([
                Markup.button.callback('ðŸ›‘ Stop Checking', `stoptrack_${item.secretId}`)
            ])
        }).catch(() => {});
    });
}

function killAllOperations(ctx) {
    const chatId = ctx.chat.id.toString();
    if (activeUsers[chatId] && activeUsers[chatId].length > 0) {
        activeUsers[chatId].forEach(item => clearInterval(item.interval));
        delete activeUsers[chatId];
        ctx.reply("ðŸ›‘ Saari stock tracking band kar di gayi.");
    } else { ctx.reply("âš ï¸ Koyi active operation chal hi nahi rahi."); }
}

async function checkProductStockStatus(ctx, chatId, pid, originalUrl) {
    if (!activeUsers[chatId]) return;

    const itemIndex = activeUsers[chatId].findIndex(item => item.id === pid);
    if (itemIndex === -1) return;

    const currentItem = activeUsers[chatId][itemIndex];

    try {
        const response = await axios.get(originalUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 12000
        });

        const htmlLower = response.data.toString().toLowerCase();

        // Croma stock indicators
        const hasBuyNowButton = htmlLower.includes('add to cart') ||
                                htmlLower.includes('buy now') ||
                                htmlLower.includes('"availability":"instock"') ||
                                htmlLower.includes('"availability": "instock"') ||
                                htmlLower.includes('schema.org/instock');

        const isOutOfStockText = htmlLower.includes('sold out') ||
                                 htmlLower.includes('out of stock') ||
                                 htmlLower.includes('notify me when available') ||
                                 htmlLower.includes('notify me') ||
                                 htmlLower.includes('"availability":"outofstock"') ||
                                 htmlLower.includes('schema.org/outofstock');

        if (hasBuyNowButton && !isOutOfStockText) {

            let alertMsg = `ðŸš¨ <b>STOCK AAGYA HAII LGA JAKE FASTTT POORA LOOT LO</b> ðŸš¨\n\n` +
                           `ðŸ“¦ <b>Product:</b> ${currentItem.title}\n\n` +
                           `ðŸ”¥ Bhai Croma pr stock wapas aa gaya hai, turant click karo aur order maro! ðŸ”¥\n\n` +
                           `ðŸ”— <b>Order Link:</b>\n${originalUrl}`;

            await bot.telegram.sendMessage(chatId, alertMsg, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    Markup.button.callback('ðŸ›‘ Stop Checking', `stoptrack_${currentItem.secretId}`)
                ])
            }).catch(() => {});
        }
    } catch (err) {}
}
