// index.js
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const express = require('express');

// Vercel loads environment variables automatically from process.env

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
    console.error('❌ Missing environment variables. Check Vercel settings.');
    // In a live environment, process.exit(1) is usually avoided to let Vercel retry.
}

// Convert ADMIN_USER_ID to Number
const ADMIN_ID = Number(ADMIN_USER_ID); 
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

/* ===================== DB ===================== */

let dbReady = false;

mongoose.set('strictQuery', true);

async function initMongo() {
    try {
        if (dbReady) return;
        
        await mongoose.connect(MONGODB_URI, {
            // 🌟 বাড়ানো হলো: 30 সেকেন্ড অপেক্ষা
            serverSelectionTimeoutMS: 30000, 
            socketTimeoutMS: 45000,       
            maxPoolSize: 1,               
            // 🌟 নতুন যোগ করা হলো: 30 সেকেন্ড পর্যন্ত বাফারিং এরর এড়াতে
            bufferTimeoutMS: 30000,       
        }); 
        
        dbReady = true;
        console.log('✅ MongoDB connected (Timeout increased)');
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
    }
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
    // This finds the user or creates a new one (safe and robust)
    return User.findOneAndUpdate(
        { userId },
        { $setOnInsert: { userId } },
        { upsert: true, new: true }
    );
}

function scheduleDelete(chatId, messageId, delay = 20000) {
    setTimeout(() => {
        // Use a simple catch-all for potential Telegram errors during deletion
        bot.deleteMessage(chatId, messageId).catch(() => {});
    }, delay);
}

function hasAccess(user) {
    // Check if access is granted and the expiry time is in the future
    return user?.isAccessGranted && user.accessExpires > new Date();
}

/* ===================== INIT RUN ===================== */

// Run MongoDB initialization only. Webhook must be set manually once.
// This runs once during Vercel cold start.
(async () => {
    await initMongo();
    console.log('✅ Bot Initialization Attempt Complete.');
})();

/* ===================== BOT LOGIC ===================== */

// /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Critical check to avoid DB operations during cold start timeout
    if (!dbReady) return bot.sendMessage(chatId, "⚠️ Server is warming up, please try again in a few seconds.").catch(() => {});

    // 🌟 TEST LINE: এই লাইনটি দেখাবে যে DB রেডি হওয়ার পরে কোড চলছে
    try {
        await bot.sendMessage(chatId, "DB_STATUS_TEST: Passed. Attempting user data fetch...").catch(() => {});
    } catch (e) {
        console.error("❌ Telegram Send Failed (DB_STATUS_TEST):", e.message);
        return;
    }
    // -------------------------------------------------------------

    try {
        const user = await getOrCreateUser(userId);

        // Deep-linking logic: checks if the command has a payload (e.g., /start access_key)
        if (msg.text.split(' ').length > 1) {
            user.isAccessGranted = true;
            user.accessExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
            await user.save();
        }

        if (!hasAccess(user)) {
            return bot.sendMessage(chatId, '⚠️ **Access required**। অ্যাক্সেস পেতে নিচের বাটন ব্যবহার করুন:', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⏰ Get 24h Access', callback_data: 'get_access' }],
                        [{ text: '▶️ Tutorial', callback_data: 'tutorial_video' }],
                    ],
                },
            });
        }

        // If access is active
        bot.sendMessage(chatId, '✅ **Send your Terabox link now!**', { parse_mode: 'Markdown' });

    } catch (e) {
        console.error('❌ Error in /start handler (DB/Logic):', e.message);
        // Final fallback message
        bot.sendMessage(chatId, '❌ An internal error occurred. Please try again later.').catch(() => {});
    }
});

// Callback buttons
bot.on('callback_query', async (q) => {
    // Critical check for cold start
    if (!dbReady) return bot.answerCallbackQuery(q.id, { text: "Server not ready." });

    const chatId = q.message.chat.id;
    await bot.answerCallbackQuery(q.id);

    try {
        if (q.data === 'get_access') {
            const { data } = await axios.get(ACCESS_API_URL);
            return bot.sendMessage(chatId, data.trim(), { disable_web_page_preview: true });
        }

        if (q.data === 'tutorial_video') {
            const cfg = await Config.findOne({ key: 'tutorial_video_file_id' });
            if (!cfg) return bot.sendMessage(chatId, '❌ No tutorial video has been set by the admin yet.');
            return bot.sendVideo(chatId, cfg.value);
        }
    } catch (e) {
        console.error('❌ Error in callback handler:', e.message);
        bot.sendMessage(chatId, '❌ Failed to process the request.').catch(() => {});
    }
});

// Video link handler
bot.on('message', async (msg) => {
    // Critical check for cold start
    if (!dbReady) return bot.sendMessage(msg.chat.id, "⚠️ Server is busy, please wait.").catch(() => {});

    // Ignore commands or messages without text
    if (!msg.text || msg.text.startsWith('/')) return;
    // Check if the message contains a Terabox link
    if (!/(terabox|4funbox)\.com/.test(msg.text)) return; 

    const chatId = msg.chat.id;

    try {
        const user = await User.findOne({ userId: msg.from.id });

        if (!hasAccess(user)) {
            return bot.sendMessage(chatId, '⚠️ Access required. Please use /start to get access.', { parse_mode: 'Markdown' });
        }

        const loading = await bot.sendMessage(chatId, '⏳ Processing video... Please wait.', { parse_mode: 'Markdown' });

        try {
            const api = `${VIDEO_API_BASE_URL}${encodeURIComponent(msg.text)}`;
            const { data } = await axios.get(api);

            if (!data?.media_url) throw new Error('Invalid API response or video not found.');

            const sent = await bot.sendVideo(chatId, data.media_url, {
                caption: data.title || 'Terabox Video',
                supports_streaming: true,
            });

            scheduleDelete(chatId, sent.message_id);

        } catch (e) {
            console.error('❌ Video Fetch Failed:', e.message);
            bot.sendMessage(chatId, '❌ Failed to fetch video from the server. Link may be invalid or API down.').catch(() => {});
        } finally {
            // Ensure loading message is deleted
            bot.deleteMessage(chatId, loading.message_id).catch(() => {});
        }
    } catch (e) {
        console.error('❌ Error in message handler:', e.message);
    }
});

// /setvideo (Admin)
bot.onText(/\/setvideo/, async (msg) => {
    if (!dbReady) return bot.sendMessage(msg.chat.id, "⚠️ Server is busy, try again shortly.");
    if (!isAdmin(msg.from.id)) return;

    bot.sendMessage(msg.chat.id, 'Send the tutorial video now.');

    // Use bot.once for a single listener
    const listener = bot.once('video', async (v) => {
        if (v.from.id !== msg.from.id) return; // Ensure it's the admin

        await Config.findOneAndUpdate(
            { key: 'tutorial_video_file_id' },
            { value: v.video.file_id },
            { upsert: true }
        );
        bot.sendMessage(msg.chat.id, '✅ Tutorial saved');
        bot.removeListener('video', listener); // Ensure listener is removed
    });
});

// /usercount (Admin)
bot.onText(/\/usercount/, async (msg) => {
    if (!dbReady) return bot.sendMessage(msg.chat.id, "⚠️ Server is busy, try again shortly.");
    if (!isAdmin(msg.from.id)) return;

    try {
        const total = await User.countDocuments();
        const active = await User.countDocuments({
            isAccessGranted: true,
            accessExpires: { $gt: new Date() },
        });

        bot.sendMessage(msg.chat.id, `👥 **User Stats**\n\n* Total Users: **${total}**\n* Active Access: **${active}**`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('❌ Error in /usercount:', e.message);
        bot.sendMessage(msg.chat.id, '❌ Failed to fetch user counts.').catch(() => {});
    }
});

// --- Other Admin Commands (e.g., /broadcast, not shown for brevity) ---


/* ===================== EXPRESS ===================== */

const app = express();
app.use(express.json());

// Webhook Handler: This is the URL Telegram sends updates to
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    // 1. MUST respond with 200 OK immediately to prevent Vercel timeout
    res.sendStatus(200); 

    // 2. Process the update asynchronously
    bot.processUpdate(req.body);
});

// Health check endpoint
app.get('/', (_, res) => res.send('Terabox Video Bot running on Vercel.'));

module.exports = app;




