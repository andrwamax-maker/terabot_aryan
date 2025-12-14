// index.js
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
// Node.js এর জন্য, শুধুমাত্র Webhook মোডে কাজ করার জন্য express প্রয়োজন।
const express = require('express'); 

// .env ফাইল লোড করা
require('dotenv').config({ path: path.resolve(__dirname, './.env') });

// --- কনফিগারেশন ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_USER_ID);
const ACCESS_API_URL = process.env.ACCESS_API_URL;
const VIDEO_API_BASE_URL = process.env.VIDEO_API_BASE_URL;
const VERCEL_URL = process.env.VERCEL_URL;

if (!BOT_TOKEN || !MONGODB_URI || !ADMIN_ID || !VERCEL_URL) {
    console.error("❌ ERROR: .env ফাইলে প্রয়োজনীয় ভ্যারিয়েবল (TOKEN, MONGODB_URI, ADMIN_USER_ID, VERCEL_URL) মিসিং আছে।");
    process.exit(1);
}

// Webhook-এর জন্য 'polling: false' ব্যবহার করা হয়েছে।
const bot = new TelegramBot(BOT_TOKEN, { polling: false }); 

// MongoDB কানেকশন
const connectDB = async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ MongoDB সফলভাবে কানেক্ট হয়েছে।');
    } catch (error) {
        console.error('❌ MongoDB কানেকশন এরর:', error);
    }
};
connectDB();

// --- MongoDB স্কিমা ---
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    isAccessGranted: { type: Boolean, default: false },
    accessExpires: { type: Date, default: null }, // 24 ঘণ্টা পর অ্যাক্সেস এক্সপায়ার হবে
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: String, required: true }
});
const Config = mongoose.model('Config', configSchema);

// --- হেল্পার ফাংশন ---

async function registerUser(userId) {
    let user = await User.findOne({ userId });
    if (!user) {
        user = new User({ userId });
        await user.save();
    }
    return user;
}

function isAdmin(userId) {
    return userId === ADMIN_ID;
}

/**
 * ভিডিও সেন্ড করার পর ২০ সেকেন্ড অপেক্ষা করে মেসেজটি ডিলিট করে দেয়।
 */
function scheduleMessageDeletion(chatId, messageId) {
    const DELAY_MS = 20000; // 20 সেকেন্ড
    setTimeout(() => {
        bot.deleteMessage(chatId, messageId)
            .catch(error => console.error(`মেসেজ ডিলিট করতে এরর:`, error.message));
    }, DELAY_MS);
}

// --- টেলিগ্রাম বট লজিক ---

// 1. /start কমান্ড হ্যান্ডেল
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const user = await registerUser(userId);

    let welcomeMessage = `**👋 স্বাগতম!**\n\nআপনি একটি Terabox ভিডিও দেখার বটের মধ্যে আছেন।\n\nঅনুগ্রহ করে আপনার **Terabox ভিডিওর লিঙ্ক** দিন।`;

    // অ্যাক্সেস যোগ করার লজিক: যখন ইউজার বাইরের লিঙ্ক থেকে /start?payload... দিয়ে আসবে
    if (msg.text.includes('/start') && msg.text.length > 6) { // নিশ্চিত করতে যে এটি শুধু /start নয়
        const now = new Date();
        const expiryTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        user.isAccessGranted = true;
        user.accessExpires = expiryTime;
        await user.save();

        welcomeMessage = `✅ **অ্যাক্সেস যোগ করা হয়েছে!**\n\nআপনার **২৪ ঘন্টার অ্যাক্সেস** শুরু হয়ে গেছে। এটি **${expiryTime.toLocaleString('bn-IN', { timeZone: 'Asia/Kolkata' })}** পর্যন্ত বৈধ।\n\nএখন আপনি Terabox ভিডিওর লিঙ্ক দিতে পারেন।`;
    }
    
    const hasActiveAccess = user.isAccessGranted && user.accessExpires > new Date();

    if (!hasActiveAccess) {
        const keyboard = {
            inline_keyboard: [
                [{ text: "⏰ Get 24 Hours Access", callback_data: "get_access" }],
                [{ text: "▶️ Access Tutorial Video", callback_data: "tutorial_video" }]
            ]
        };
        welcomeMessage += `\n\n⚠️ **Insufficient Balance**। অ্যাক্সেস পেতে নিচের বাটন ব্যবহার করুন।`;

        bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    } else {
        bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    }
});

// 2. Inline Keyboard (বাটন ক্লিক) হ্যান্ডেল
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id); 

    if (data === 'get_access') {
        // "get 24 hours access"
        try {
            const response = await axios.get(ACCESS_API_URL);
            const accessLink = response.data.trim(); 
            
            await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

            const message = `🔗 **আপনার অ্যাক্সেস লিঙ্ক:**\n\nএই লিঙ্কটিতে ক্লিক করে **'START'** করুন। আপনার ২৪ ঘন্টার অ্যাক্সেস অ্যাক্টিভেট হয়ে যাবে।\n\n${accessLink}`;
            
            bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });

        } catch (error) {
            console.error("Access API কল এরর:", error.message);
            bot.sendMessage(chatId, "দুঃখিত, অ্যাক্সেস লিঙ্ক আনতে সমস্যা হচ্ছে।");
        }
    } else if (data === 'tutorial_video') {
        // "Access tutorial video"
        const config = await Config.findOne({ key: 'tutorial_video_file_id' });

        if (config && config.value) {
            bot.sendVideo(chatId, config.value, { 
                caption: "ভিডিওটি কীভাবে ব্যবহার করবেন তা এই টিউটোরিয়ালে দেখানো হয়েছে।" 
            });
        } else {
            bot.sendMessage(chatId, "😥 দুঃখিত, অ্যাডমিন এখনও টিউটোরিয়াল ভিডিও সেট করেনি।");
        }
    }
});

// 3. Terabox লিঙ্ক হ্যান্ডেল (ভিডিও ডাউনলোড)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;
    
    // কমান্ড হলে বা ভিডিও লিঙ্ক না হলে ইগনোর
    if (text.startsWith('/') || !/(terabox|4funbox)\.com/.test(text)) {
        return;
    }

    const user = await User.findOne({ userId });
    const hasActiveAccess = user && user.isAccessGranted && user.accessExpires > new Date();

    if (hasActiveAccess) {
        // --- ইউজার এর অ্যাক্সেস আছে: ভিডিও ফেচ এবং সেন্ড করা ---
        
        const loadingMsg = await bot.sendMessage(chatId, "⏳ **ভিডিও প্রসেস করা হচ্ছে...** অনুগ্রহ করে অপেক্ষা করুন।", { parse_mode: 'Markdown' });

        try {
            const apiUrl = `${VIDEO_API_BASE_URL}${encodeURIComponent(text)}`;
            const response = await axios.get(apiUrl);
            const videoData = response.data;

            if (videoData.status === 'success' && videoData.media_url) {
                
                const captionText = `**${videoData.title}**\n\n---
⚠️ **Video ko forward karke save kar lo. 20 second me delete ho jayega.**`;

                // Play এবং Download বাটন সহ ভিডিও পাঠানো
                const sentMessage = await bot.sendVideo(chatId, videoData.media_url, {
                    caption: captionText,
                    parse_mode: 'Markdown',
                    supports_streaming: true,
                    reply_markup: {
                         inline_keyboard: [
                             [{ text: "▶️ Play Now", url: videoData.media_url }],
                             [{ text: "📥 Download", url: videoData.media_url }]
                         ]
                    }
                });

                // ২০ সেকেন্ড পর ভিডিও ডিলিট করা
                scheduleMessageDeletion(chatId, sentMessage.message_id);

            } else {
                bot.sendMessage(chatId, "😥 দুঃখিত, এই লিঙ্ক থেকে ভিডিওটি ডাউনলোড করা যাচ্ছে না। API Error.");
            }

        } catch (error) {
            console.error("Video Fetch API কল এরর:", error.message);
            bot.sendMessage(chatId, "⚠️ ভিডিও সার্ভার থেকে ডেটা আনতে সমস্যা হয়েছে।");
        } finally {
            // লোডিং মেসেজ ডিলিট করা
            await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        }

    } else {
        // অ্যাক্সেস নেই, তাই আবার বাটন দেখানো
        const keyboard = {
            inline_keyboard: [
                [{ text: "⏰ Get 24 Hours Access", callback_data: "get_access" }],
                [{ text: "▶️ Access Tutorial Video", callback_data: "tutorial_video" }]
            ]
        };
        bot.sendMessage(chatId, "⚠️ **Insufficient Balance**। অনুগ্রহ করে অ্যাক্সেস নিন:", {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }
});


// --- অ্যাডমিন ফাংশন ---

// /setvideo
bot.onText(/\/setvideo/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return bot.sendMessage(chatId, "❌ আপনি অ্যাডমিন নন।");

    const prompt = await bot.sendMessage(chatId, "🔗 এখন আপনি যে ভিডিওটি পাঠাবেন, সেটি টিউটোরিয়াল ভিডিও হিসেবে সেট হয়ে যাবে।");
    
    // ভিডিও মেসেজ আসার জন্য অপেক্ষা
    const listener = bot.on('video', async (videoMsg) => {
        if (videoMsg.from.id === userId) {
            const fileId = videoMsg.video.file_id;
            
            // ডেটাবেসে file_id সেভ করা
            await Config.findOneAndUpdate(
                { key: 'tutorial_video_file_id' },
                { value: fileId },
                { upsert: true, new: true }
            );

            bot.sendMessage(chatId, `✅ টিউটোরিয়াল ভিডিও সফলভাবে সেট করা হয়েছে।`, { reply_to_message_id: videoMsg.message_id });

            // লিসেনার বন্ধ করা
            bot.removeListener('video', listener);
            bot.deleteMessage(chatId, prompt.message_id).catch(() => {});
        }
    });
});

// /usercount
bot.onText(/\/usercount/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return bot.sendMessage(chatId, "❌ আপনি অ্যাডমিন নন।");

    try {
        const totalUsers = await User.countDocuments({});
        const activeUsers = await User.countDocuments({ 
            isAccessGranted: true, 
            accessExpires: { $gt: new Date() } 
        });
        
        bot.sendMessage(chatId, `📊 **ইউজার স্ট্যাটাস:**\n\n* মোট ইউজার: **${totalUsers}** জন।\n* অ্যাক্টিভ অ্যাক্সেস: **${activeUsers}** জন।`, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, "❌ ইউজার ডেটা আনতে সমস্যা হয়েছে।");
    }
});

// /broadcast
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) return bot.sendMessage(chatId, "❌ আপনি অ্যাডমিন নন।");

    const broadcastMessage = match[1];
    
    try {
        const users = await User.find({});
        let successCount = 0;
        
        for (const user of users) {
            try {
                await bot.sendMessage(user.userId, broadcastMessage, { parse_mode: 'Markdown' });
                successCount++;
            } catch (e) {
                // ব্লক করা ইউজারকে ইগনোর করা
            }
        }
        
        bot.sendMessage(chatId, `✅ সফলভাবে **${successCount}** জন ইউজারকে মেসেজ পাঠানো হয়েছে।`);

    } catch (error) {
        bot.sendMessage(chatId, "❌ ব্রডকাস্ট করার সময় এরর হয়েছে।");
    }
});


// --- Vercel Webhook সেটআপ (Express.js ব্যবহার করে) ---

const app = express();

// Telegram বডি রিকোয়েস্ট পার্স করার জন্য মিডলওয়্যার
app.use(express.json());

// Webhook URL সেট করা
const webhookUrl = `${VERCEL_URL}/bot${BOT_TOKEN}`;
bot.setWebHook(webhookUrl);

// Webhook হ্যান্ডেলার
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// রুট রাউট (স্বাগতম মেসেজ বা শুধু সার্ভার চলছে কিনা চেক করার জন্য)
app.get('/', (req, res) => {
    res.send('Terabox Video Bot is running via Webhook.');
});

// Vercel-এ এটি স্বয়ংক্রিয়ভাবে সার্ভার লিসেন করবে, তাই এখানে explicit app.listen() প্রয়োজন নেই।
// module.exports ব্যবহার করে Vercel হ্যান্ডেল করার জন্য
module.exports = app;