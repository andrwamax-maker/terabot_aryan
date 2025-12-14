// index.js
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const express = require('express');

// Load environment variables from .env file
require('dotenv').config({ path: path.resolve(__dirname, './.env') });

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
// Ensure ADMIN_USER_ID is set as a number (without quotes) in Vercel
const ADMIN_ID = parseInt(process.env.ADMIN_USER_ID); 
const ACCESS_API_URL = process.env.ACCESS_API_URL;
const VIDEO_API_BASE_URL = process.env.VIDEO_API_BASE_URL;
const VERCEL_URL = process.env.VERCEL_URL;

if (!BOT_TOKEN || !MONGODB_URI || !ADMIN_ID || !VERCEL_URL) {
    console.error("❌ ERROR: Required environment variables are missing.");
    process.exit(1);
}

// Use polling: false for Vercel Webhook deployment
const bot = new TelegramBot(BOT_TOKEN, { polling: false }); 

// --- MongoDB Schemas ---

const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    isAccessGranted: { type: Boolean, default: false },
    accessExpires: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: String, required: true }
});
const Config = mongoose.model('Config', configSchema);

// --- Initialization and Status ---

let dbConnected = false;

async function initialize() {
    try {
        // 1. Connect to MongoDB
        await mongoose.connect(MONGODB_URI);
        dbConnected = true; 
        console.log('✅ MongoDB connected successfully.');

    } catch (error) {
        // If initialization fails (e.g., DB connection error), log it but allow Express to start
        console.error('❌ Initialization Error (DB):', error.message);
    }
}
// Run initialization once when the function starts (cold start)
initialize();


// --- Helper Functions ---

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
 * Schedules message deletion after 20 seconds. 
 */
function scheduleMessageDeletion(chatId, messageId) {
    const DELAY_MS = 20000;
    setTimeout(() => {
        bot.deleteMessage(chatId, messageId)
            .catch(error => {
                // Handle deletion errors gracefully
                if (error.response && error.response.statusCode !== 400) { 
                    console.error(`Error deleting message ${messageId}:`, error.message);
                }
            });
    }, DELAY_MS);
}

// --- TELEGRAM BOT LOGIC ---

// Middleware to check DB status before processing any heavy request
const dbCheckMiddleware = async (msg, match, next) => {
    // Check if the DB connection is stable (readyState 1 is 'connected')
    if (!dbConnected || mongoose.connection.readyState !== 1) {
        console.warn(`DB not ready for user ${msg.from.id}. Skipping operation.`);
        // Try to send a polite message only if it's not a callback query
        if (msg.chat) {
            bot.sendMessage(msg.chat.id, "⚠️ Server is warming up. Please try the command again in a few seconds.", { parse_mode: 'Markdown' }).catch(() => {});
        }
        return; // Stop processing the command
    }
    next();
};


// 1. /start command handler
bot.onText(/\/start/, async (msg) => {
    // Wrap the handler logic in the middleware for DB check
    dbCheckMiddleware(msg, null, async () => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        try {
            const user = await registerUser(userId);

            let welcomeMessage = `**👋 স্বাগতম! Welcome!**\n\nYou are in the Terabox video bot.\n\nঅনুগ্রহ করে আপনার **Terabox ভিডিওর লিঙ্ক** দিন। (Please provide your Terabox link.)`;

            // Logic for 24-hour access via deep linking (/start payload)
            if (msg.text.includes('/start') && msg.text.length > 6) {
                const now = new Date();
                const expiryTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

                user.isAccessGranted = true;
                user.accessExpires = expiryTime;
                await user.save();

                welcomeMessage = `✅ **অ্যাক্সেস যোগ করা হয়েছে! Access Added!**\n\nYour **24 hours access** has started. It is valid until **${expiryTime.toLocaleString('bn-IN', { timeZone: 'Asia/Kolkata' })}**.\n\nNow you can send your Terabox video link.`;
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

                await bot.sendMessage(chatId, welcomeMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } else {
                await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
            }
        } catch (e) {
            console.error("Error in /start handler:", e.message);
            await bot.sendMessage(chatId, "⚠️ Internal server error occurred. Please try again.");
        }
    });
});

// 2. Inline Keyboard (Button Click) Handler
bot.on('callback_query', async (query) => {
    // Note: Callback queries don't pass through bot.onText, but we can check DB connection here.
    if (!dbConnected || mongoose.connection.readyState !== 1) {
        return bot.answerCallbackQuery(query.id, { text: "Server is initializing. Please wait." });
    }
    
    const chatId = query.message.chat.id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id); 

    try {
        if (data === 'get_access') {
            // "Get 24 Hours Access"
            const response = await axios.get(ACCESS_API_URL);
            const accessLink = response.data.trim(); 
            
            await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

            const message = `🔗 **আপনার অ্যাক্সেস লিঙ্ক (Your Access Link):**\n\nএই লিঙ্কটিতে ক্লিক করে **'START'** করুন। Your 24-hour access will be activated.\n\n${accessLink}`;
            
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });

        } else if (data === 'tutorial_video') {
            // "Access Tutorial Video"
            const config = await Config.findOne({ key: 'tutorial_video_file_id' });

            if (config && config.value) {
                await bot.sendVideo(chatId, config.value, { 
                    caption: "ভিডিওটি কীভাবে ব্যবহার করবেন তা এই টিউটোরিয়ালে দেখানো হয়েছে। (Tutorial on how to use the bot.)" 
                });
            } else {
                await bot.sendMessage(chatId, "😥 দুঃখিত, অ্যাডমিন এখনও টিউটোরিয়াল ভিডিও সেট করেনি।");
            }
        }
    } catch (e) {
        console.error("Error in callback query handler:", e.message);
    }
});

// 3. Terabox Link Handler (Video Download)
bot.on('message', async (msg) => {
    // Wrap the handler logic in the middleware for DB check
    dbCheckMiddleware(msg, null, async () => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;
        
        // Ignore commands or non-link messages
        if (text.startsWith('/') || !/(terabox|4funbox)\.com/.test(text)) {
            return;
        }

        try {
            const user = await User.findOne({ userId });
            const hasActiveAccess = user && user.isAccessGranted && user.accessExpires > new Date();

            if (hasActiveAccess) {
                // --- User HAS Access: Fetch and send video ---
                
                const loadingMsg = await bot.sendMessage(chatId, "⏳ **ভিডিও প্রসেস করা হচ্ছে...** অনুগ্রহ করে অপেক্ষা করুন।", { parse_mode: 'Markdown' });

                try {
                    const apiUrl = `${VIDEO_API_BASE_URL}${encodeURIComponent(text)}`;
                    const response = await axios.get(apiUrl);
                    const videoData = response.data;

                    if (videoData.status === 'success' && videoData.media_url) {
                        
                        const captionText = `**${videoData.title}**\n\n---
⚠️ **Video ko forward karke save kar lo. 20 second me delete ho jayega.**`;

                        // Send video with Play and Download buttons
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

                        // Schedule video deletion after 20 seconds
                        scheduleMessageDeletion(chatId, sentMessage.message_id);

                    } else {
                        await bot.sendMessage(chatId, "😥 দুঃখিত, এই লিঙ্ক থেকে ভিডিওটি ডাউনলোড করা যাচ্ছে না। API Error.");
                    }

                } catch (error) {
                    console.error("Video Fetch API Call Error:", error.message);
                    await bot.sendMessage(chatId, "⚠️ ভিডিও সার্ভার থেকে ডেটা আনতে সমস্যা হয়েছে।");
                } finally {
                    // Delete loading message
                    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
                }

            } else {
                // Access is missing
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "⏰ Get 24 Hours Access", callback_data: "get_access" }],
                        [{ text: "▶️ Access Tutorial Video", callback_data: "tutorial_video" }]
                    ]
                };
                await bot.sendMessage(chatId, "⚠️ **Insufficient Balance**. অনুগ্রহ করে অ্যাক্সেস নিন:", {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            }
        } catch (e) {
            console.error("Error in message handler:", e.message);
        }
    });
});


// --- ADMIN FUNCTIONS ---

// /setvideo
bot.onText(/\/setvideo/, async (msg) => {
    // Only proceed if DB is ready for admin operations
    if (!dbConnected || mongoose.connection.readyState !== 1) {
        return bot.sendMessage(msg.chat.id, "⚠️ Server is not fully initialized. Try again shortly.");
    }
    
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return bot.sendMessage(chatId, "❌ You are not an admin.");

    try {
        const prompt = await bot.sendMessage(chatId, "🔗 Please send the video you want to set as the tutorial video now.");
        
        // Wait for the next video message from this user
        const listener = bot.on('video', async (videoMsg) => {
            if (videoMsg.from.id === userId) {
                const fileId = videoMsg.video.file_id;
                
                // Save file_id to the database
                await Config.findOneAndUpdate(
                    { key: 'tutorial_video_file_id' },
                    { value: fileId },
                    { upsert: true, new: true }
                );

                await bot.sendMessage(chatId, `✅ Tutorial video successfully set.`, { reply_to_message_id: videoMsg.message_id });

                // Remove the listener
                bot.removeListener('video', listener);
                await bot.deleteMessage(chatId, prompt.message_id).catch(() => {});
            }
        });
    } catch (e) {
        console.error("Error in /setvideo handler:", e.message);
    }
});

// /usercount (Same DB check logic applies implicitly via find/count calls)
bot.onText(/\/usercount/, async (msg) => {
    if (!dbConnected || mongoose.connection.readyState !== 1) {
        return bot.sendMessage(msg.chat.id, "⚠️ Server is not fully initialized. Try again shortly.");
    }
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return bot.sendMessage(chatId, "❌ You are not an admin.");

    try {
        const totalUsers = await User.countDocuments({});
        const activeUsers = await User.countDocuments({ 
            isAccessGranted: true, 
            accessExpires: { $gt: new Date() } 
        });
        
        await bot.sendMessage(chatId, `📊 **User Status:**\n\n* Total Users: **${totalUsers}**\n* Active Access: **${activeUsers}**`, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error("Error fetching user count:", error.message);
        await bot.sendMessage(chatId, "❌ Error retrieving user data.");
    }
});

// /broadcast
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    if (!dbConnected || mongoose.connection.readyState !== 1) {
        return bot.sendMessage(msg.chat.id, "⚠️ Server is not fully initialized. Try again shortly.");
    }
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) return bot.sendMessage(chatId, "❌ You are not an admin.");

    const broadcastMessage = match[1];
    
    try {
        const users = await User.find({});
        let successCount = 0;
        
        for (const user of users) {
            try {
                // Sending message to each user
                await bot.sendMessage(user.userId, broadcastMessage, { parse_mode: 'Markdown' });
                successCount++;
            } catch (e) {
                // Ignore users who have blocked the bot or have privacy settings enabled
            }
        }
        
        await bot.sendMessage(chatId, `✅ Successfully sent message to **${successCount}** users.`);

    } catch (error) {
        console.error("Error in broadcast:", error.message);
        await bot.sendMessage(chatId, "❌ An error occurred during broadcasting.");
    }
});


// --- Vercel Webhook Setup (Express.js) ---

const app = express();

// Middleware to parse Telegram body requests
app.use(express.json());

// Webhook Handler
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    // Process the incoming update from Telegram
    bot.processUpdate(req.body);
    // Respond quickly to Telegram to acknowledge the update
    res.sendStatus(200);
});

// Root route (for health check)
app.get('/', (req, res) => {
    res.send('Terabox Video Bot is running via Webhook.');
});

// Export the Express app for Vercel
module.exports = app;
