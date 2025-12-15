// index.js

const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');

// --- কনফিগারেশন এবং এনভায়রনমেন্ট ভ্যারিয়েবল ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID); 

// API এবং লিঙ্ক
const TERABOX_API_BASE = "https://wadownloader.amitdas.site/api/TeraBox/main/?url=";
const ACCESS_LINK_API = "https://vplink.in/api?api=bbdcdbe30fa584eb68269dd61da632c591b2ee80&url=https://t.me/TERABOX_0_BOT&alias=terabot&format=text";

// MongoDB URI
const MONGO_URI = process.env.MONGO_URI; 

// --- MongoDB মডেল ---
const userSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    isAccessGranted: { type: Boolean, default: false },
    accessExpiresAt: { type: Date, default: null },
    isAdmin: { type: Boolean, default: false } 
});
const User = mongoose.model('User', userSchema);

let tutorialVideoFileId = null; 

// --- MongoDB কানেকশন ---
if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(() => console.log('✅ MongoDB Connected successfully!'))
        .catch(err => console.error('❌ MongoDB connection error:', err.message));
} else {
    console.error('❌ MONGO_URI is not set.');
}

// --- বট এবং Express অ্যাপ সেটআপ ---
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// --- ইউটিলিটি ফাংশন ---

function grantAccess(user) {
    const expiration = new Date();
    expiration.setHours(expiration.getHours() + 24);
    user.isAccessGranted = true;
    user.accessExpiresAt = expiration;
    return expiration;
}

async function sendInsufficientBalance(ctx) {
    const keyboard = Telegraf.Extra.markup((m) =>
        m.inlineKeyboard([
            [m.callbackButton('🔑 ২৪ ঘণ্টার অ্যাক্সেস নিন', 'GET_ACCESS')],
            [m.callbackButton('▶️ অ্যাক্সেস টিউটোরিয়াল ভিডিও', 'TUTORIAL_VIDEO')]
        ])
    );
    const message = "❌ **Unsufficient Balance!**\n\nভিডিও দেখার জন্য আপনাকে ২৪ ঘণ্টার অ্যাক্সেস নিতে হবে। নিচের বাটনটি ক্লিক করুন।";
    ctx.replyWithMarkdown(message, keyboard);
}


// --- অ্যাডমিন কমান্ড হ্যান্ডলার ---
async function handleAdminCommands(ctx, command) {
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply("❌ আপনি অ্যাডমিন নন।");
    }

    if (cmd === '/setvideo') {
        if (ctx.message.reply_to_message && ctx.message.reply_to_message.video) {
            tutorialVideoFileId = ctx.message.reply_to_message.video.file_id;
            ctx.reply(`✅ টিউটোরিয়াল ভিডিও সেট করা হয়েছে:\nFile ID: \`${tutorialVideoFileId}\``, { parse_mode: 'Markdown' });
        } else {
            ctx.reply("অনুগ্রহ করে যে ভিডিওটি সেট করতে চান সেটির উপর রিপ্লাই করে `/setvideo` কমান্ডটি দিন।");
        }
    } else if (cmd === '/usercount') {
        const count = await User.countDocuments();
        ctx.reply(`📊 মোট ইউজার সংখ্যা: **${count}** জন।`, { parse_mode: 'Markdown' });
    } else if (cmd === '/brodcast') {
        const messageToBroadcast = command.substring('/brodcast'.length).trim();
        if (messageToBroadcast.length > 0) {
            const users = await User.find({});
            let successCount = 0;
            for (const user of users) {
                try {
                    await ctx.telegram.sendMessage(user.telegramId, `📢 **অ্যাডমিনের বার্তা:**\n\n${messageToBroadcast}`, { parse_mode: 'Markdown' });
                    successCount++;
                } catch (e) {
                    // User blocked the bot
                }
            }
            ctx.reply(`✅ সফলভাবে **${successCount}** জন ইউজারকে ব্রডকাস্ট করা হয়েছে।`);
        } else {
            ctx.reply("অনুগ্রহ করে `/brodcast [আপনার মেসেজ]` এই ফরম্যাটে মেসেজ দিন।");
        }
    }
}


// --- টেলিগ্রাম বট লজিক ---

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    let user = await User.findOne({ telegramId: userId });
    let isNewUser = false;

    if (!user) {
        user = new User({ telegramId: userId, isAdmin: userId === ADMIN_ID });
        isNewUser = true;
    }
    
    const now = new Date();
    let hasAccess = user.accessExpiresAt && user.accessExpiresAt > now;
    
    if (!hasAccess && !isNewUser && user.accessExpiresAt) {
        // যদি ইউজার অ্যাক্সেস নেওয়ার জন্য ফিরে আসে
        grantAccess(user);
        hasAccess = true;
        await user.save();
        
        ctx.reply(`🎉 **অভিনন্দন, আপনার ২৪ ঘণ্টার অ্যাক্সেস যুক্ত করা হয়েছে!**\nএখন আপনি Terabox লিঙ্ক দিতে পারেন।`);
        return;
    }

    await user.save(); 

    let welcomeText = `👋 **স্বাগতম, ${ctx.from.first_name}**! এটি Terabox ভিডিও দেখার বট।\n\n`;

    if (hasAccess) {
        welcomeText += "✅ আপনার **২৪ ঘণ্টার অ্যাক্সেস চালু আছে**!\nঅনুগ্রহ করে আপনার Terabox ভিডিওর লিঙ্কটি দিন।";
        ctx.replyWithMarkdown(welcomeText);
    } else {
        welcomeText += "🛑 আপনার অ্যাকাউন্টে বর্তমানে **অ্যাক্সেস নেই**।\nভিডিও দেখার জন্য Terabox লিঙ্ক দিন।";
        sendInsufficientBalance(ctx);
    }
});

bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery(); 

    if (data === 'GET_ACCESS') {
        try {
            const response = await axios.get(ACCESS_LINK_API);
            const redirectLink = response.data.trim(); 
            
            const accessMessage = "🔑 **অ্যাক্সেস নিন**\n\nলিঙ্কে ক্লিক করে **বটটি আবার /start করুন**। তাহলেই আপনার **২৪ ঘণ্টার অ্যাক্সেস** যোগ হয়ে যাবে।";
            const linkKeyboard = Telegraf.Extra.markup((m) =>
                m.inlineKeyboard([
                    [m.urlButton('🔗 অ্যাক্সেসের জন্য ক্লিক করুন', redirectLink)]
                ])
            );

            ctx.replyWithMarkdown(accessMessage, linkKeyboard);
        } catch (error) {
            ctx.reply("অ্যাক্সেস লিঙ্ক তৈরি করতে সমস্যা হচ্ছে। অনুগ্রহ করে পরে চেষ্টা করুন।");
        }
    } else if (data === 'TUTORIAL_VIDEO') {
        if (tutorialVideoFileId) {
            ctx.replyWithVideo(tutorialVideoFileId, {
                caption: "**টিউটোরিয়াল ভিডিও**\nকিভাবে ২৪ ঘণ্টার অ্যাক্সেস নিতে হবে তা এখানে দেখানো হলো।"
            });
        } else {
            ctx.reply("❌ দুঃখিত, অ্যাডমিন এখনো কোনো টিউটোরিয়াল ভিডিও সেট করেননি।");
        }
    }
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userMessage = ctx.message.text.trim();
    let user = await User.findOne({ telegramId: userId });

    if (!user) {
        user = new User({ telegramId: userId, isAdmin: userId === ADMIN_ID });
        await user.save();
    }

    if (user.isAdmin && userMessage.startsWith('/')) {
        return handleAdminCommands(ctx, userMessage);
    }
    
    const now = new Date();
    const hasAccess = user.accessExpiresAt && user.accessExpiresAt > now;

    if (!hasAccess) {
        return sendInsufficientBalance(ctx);
    }

    if (userMessage.includes('terabox.com') || userMessage.includes('4funbox.com')) {
        const processingMsg = await ctx.reply('🔍 লিঙ্কটি প্রসেস করা হচ্ছে, কিছুক্ষণ অপেক্ষা করুন...');
        
        try {
            const apiResponse = await axios.get(`${TERABOX_API_BASE}${encodeURIComponent(userMessage)}`);
            const data = apiResponse.data;

            if (data.status === 'success' && data.media_url) {
                const videoURL = data.media_url;
                const videoTitle = data.title;

                const caption = `**🎬 ${videoTitle}**\n\n**⚠️ গুরুত্বপূর্ণ:** ভিডিওটি **ফরওয়ার্ড করে সেভ করে নিন**, কারণ এটি **২০ সেকেন্ড পর** স্বয়ংক্রিয়ভাবে ডিলিট হয়ে যাবে।`;
                
                const videoMessage = await ctx.replyWithVideo(videoURL, {
                    caption: caption,
                    parse_mode: 'Markdown',
                    thumb: data.thumbnail, 
                });

                // ২০ সেকেন্ড পর ডিলিট
                setTimeout(async () => {
                    try {
                        await ctx.telegram.deleteMessage(userId, videoMessage.message_id);
                        await ctx.telegram.deleteMessage(userId, processingMsg.message_id);
                    } catch (err) {}
                }, 20000); 

            } else {
                ctx.reply('❌ ভিডিওটি খুঁজে পাওয়া যায়নি বা API-এ কোনো সমস্যা হয়েছে।');
            }

        } catch (error) {
            ctx.reply('❌ ভিডিও প্রসেসিং-এ একটি ত্রুটি ঘটেছে। লিঙ্কটি সঠিক কিনা চেক করুন।');
        } finally {
             // প্রসেসিং মেসেজটি ডিলিট করা
            try {
                await ctx.telegram.deleteMessage(userId, processingMsg.message_id);
            } catch (err) {}
        }
    } else {
        ctx.reply("অনুগ্রহ করে একটি **বৈধ Terabox ভিডিও লিঙ্ক** দিন।");
    }
});


// --- Railway/Long Polling সেটআপ ---
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Terabox Bot Running');
});


if (BOT_TOKEN && MONGO_URI && ADMIN_ID) {
    // 1. Express সার্ভার চালু করা (Railway এর PORT ভ্যারিয়েবল ব্যবহার করে)
    app.listen(port, () => {
        console.log(`Express Server running on port ${port}`);
    });

    // 2. টেলিগ্রাম বটের জন্য Long Polling শুরু করা
    bot.telegram.deleteWebhook().then(() => {
        console.log('Previous webhook deleted.');
        
        bot.launch()
            .then(() => console.log('✅ Telegram Bot (Long Polling) Started!'))
            .catch(err => console.error('❌ Bot launch failed:', err.message));
    });

} else {
    console.error("❌ Configuration Error: BOT_TOKEN, MONGO_URI, or ADMIN_ID is missing.");
}
