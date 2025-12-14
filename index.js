// index.js
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const express = require('express');
require('dotenv').config({ path: path.resolve(__dirname, './.env') });

/* ===================== CONFIG ===================== */

const {
    TELEGRAM_BOT_TOKEN,
    MONGODB_URI,
    ADMIN_USER_ID,
    ACCESS_API_URL,
    VIDEO_API_BASE_URL,
    VERCEL_URL,
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !MONGODB_URI || !ADMIN_USER_ID || !VERCEL_URL) {
    console.error('❌ Missing environment variables');
    process.exit(1);
}

const ADMIN_ID = Number(ADMIN_USER_ID);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

/* ===================== DB ===================== */

let dbReady = false;

mongoose.set('strictQuery', true);

async function initMongo() {
    if (dbReady) return;
    await mongoose.connect(MONGODB_URI);
    dbReady = true;
    console.log('✅ MongoDB connected');
}

/* ===================== MODELS ===================== */

const User = mongoose.model(
    'User',
    new mongoose.Schema({
        userId: { type: Number, unique: true },
        isAccessGranted: { type: Boolean, default: false },
        accessExpires: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now },
    })
);

const Config = mongoose.model(
    'Config',
    new mongoose.Schema({
        key: { type: String, unique: true },
        value: String,
    })
);

/* ===================== HELPERS ===================== */

const isAdmin = (id) => id === ADMIN_ID;

async function getOrCreateUser(userId) {
    return User.findOneAndUpdate(
        { userId },
        { $setOnInsert: { userId } },
        { upsert: true, new: true }
    );
}

function scheduleDelete(chatId, messageId, delay = 20000) {
    setTimeout(() => {
        bot.deleteMessage(chatId, messageId).catch(() => {});
    }, delay);
}

function hasAccess(user) {
    return user?.isAccessGranted && user.accessExpires > new Date();
}

/* ===================== INIT ===================== */

(async () => {
    try {
        await initMongo();
        const webhookUrl = `${VERCEL_URL}/bot${TELEGRAM_BOT_TOKEN}`;
        await bot.setWebHook(webhookUrl);
        console.log('✅ Webhook set:', webhookUrl);
    } catch (e) {
        console.error('❌ Init failed:', e.message);
    }
})();

/* ===================== BOT ===================== */

// /start
bot.onText(/\/start/, async (msg) => {
    if (!dbReady) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const user = await getOrCreateUser(userId);

    if (msg.text.split(' ').length > 1) {
        user.isAccessGranted = true;
        user.accessExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await user.save();
    }

    if (!hasAccess(user)) {
        return bot.sendMessage(chatId, '⚠️ Access required', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⏰ Get 24h Access', callback_data: 'get_access' }],
                    [{ text: '▶️ Tutorial', callback_data: 'tutorial_video' }],
                ],
            },
        });
    }

    bot.sendMessage(chatId, '✅ Send your Terabox link');
});

// Callback buttons
bot.on('callback_query', async (q) => {
    if (!dbReady) return bot.answerCallbackQuery(q.id);

    const chatId = q.message.chat.id;
    await bot.answerCallbackQuery(q.id);

    if (q.data === 'get_access') {
        const { data } = await axios.get(ACCESS_API_URL);
        return bot.sendMessage(chatId, data, { disable_web_page_preview: true });
    }

    if (q.data === 'tutorial_video') {
        const cfg = await Config.findOne({ key: 'tutorial_video_file_id' });
        if (!cfg) return bot.sendMessage(chatId, '❌ No tutorial set');
        return bot.sendVideo(chatId, cfg.value);
    }
});

// Video link handler
bot.on('message', async (msg) => {
    if (!dbReady || !msg.text) return;
    if (!/(terabox|4funbox)\.com/.test(msg.text)) return;

    const chatId = msg.chat.id;
    const user = await User.findOne({ userId: msg.from.id });

    if (!hasAccess(user)) {
        return bot.sendMessage(chatId, '⚠️ Access required');
    }

    const loading = await bot.sendMessage(chatId, '⏳ Processing...');

    try {
        const api = `${VIDEO_API_BASE_URL}${encodeURIComponent(msg.text)}`;
        const { data } = await axios.get(api);

        if (!data?.media_url) throw new Error('Invalid API response');

        const sent = await bot.sendVideo(chatId, data.media_url, {
            caption: data.title || 'Video',
            supports_streaming: true,
        });

        scheduleDelete(chatId, sent.message_id);
    } catch {
        bot.sendMessage(chatId, '❌ Failed to fetch video');
    } finally {
        bot.deleteMessage(chatId, loading.message_id).catch(() => {});
    }
});

// /setvideo
bot.onText(/\/setvideo/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    bot.sendMessage(msg.chat.id, 'Send tutorial video');

    bot.once('video', async (v) => {
        await Config.findOneAndUpdate(
            { key: 'tutorial_video_file_id' },
            { value: v.video.file_id },
            { upsert: true }
        );
        bot.sendMessage(msg.chat.id, '✅ Tutorial saved');
    });
});

// /usercount
bot.onText(/\/usercount/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const total = await User.countDocuments();
    const active = await User.countDocuments({
        isAccessGranted: true,
        accessExpires: { $gt: new Date() },
    });

    bot.sendMessage(msg.chat.id, `👥 Total: ${total}\n✅ Active: ${active}`);
});

/* ===================== EXPRESS ===================== */

const app = express();
app.use(express.json());

app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/', (_, res) => res.send('Bot running'));

module.exports = app;
