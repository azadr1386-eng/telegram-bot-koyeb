const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// بررسی وجود توکن
if (!process.env.BOT_TOKEN) {
  console.error('❌ خطا: توکن ربات تنظیم نشده است');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// دیتابیس ساده در حافظه
const users = new Map();
const calls = new Map();
const activeCalls = new Map();
const messageCallMap = new Map(); // نگاشت message_id به call_id

// middleware برای تشخیص کاربر
bot.use((ctx, next) => {
  if (ctx.from) {
    const userId = ctx.from.id;
    if (!users.has(userId)) {
      users.set(userId, {
        phoneNumber: null,
        currentCall: null,
        contactNumber: null,
        registered: false,
        username: ctx.from.username || ctx.from.first_name || 'کاربر'
      });
    }
  }
  return next();
});

// ================== دستورات ربات ================== //

// دستور /start
bot.start((ctx) => {
  // فقط در چت خصوصی پاسخ دهد
  if (ctx.chat.type !== 'private') {
    return ctx.reply('🤖 لطفاً با من در چت خصوصی گفتگو کنید تا شماره شما را ثبت کنم.');
  }
  
  const firstName = ctx.from.first_name || 'کاربر';
  const welcomeText = `👋 سلام ${firstName} به ربات مخابراتی پیشرفته!

📞 برای استفاده از سرویس تماس، ابتدا باید شماره خود را ثبت کنید:
/register [شماره]

📞 برای تماس با کاربر دیگر در گروه:
در گروه بنویسید: @${ctx.botInfo.username} [شماره مقصد]

📞 برای پایان تماس جاری:
/endcall

ℹ️ برای مشاهده اطلاعات کاربری:
/profile`;

  ctx.reply(welcomeText);
});

// ثبت شماره کاربر - فقط در چت خصوصی
bot.command('register', (ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.reply('🤖 لطفاً این دستور را در چت خصوصی با من استفاده کنید.');
  }
  
  const userId = ctx.from.id;
  const phoneNumber = ctx.message.text.split(' ')[1];
  
  if (!phoneNumber) {
    return ctx.reply('❌ لطفاً شماره را وارد کنید: /register [شماره]');
  }
  
  const userData = users.get(userId);
  userData.phoneNumber = phoneNumber;
  userData.registered = true;
  
  ctx.reply(`✅ شماره ${phoneNumber} با موفقیت ثبت شد!`);
});

// مشاهده پروفایل - فقط در چت خصوصی
bot.command('profile', (ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.reply('🤖 لطفاً این دستور را در چت خصوصی با من استفاده کنید.');
  }
  
  const userId = ctx.from.id;
  const userData = users.get(userId);
  
  if (!userData || !userData.registered) {
    return ctx.reply('❌ لطفاً ابتدا با دستور /register شماره خود را ثبت کنید.');
  }
  
  const profileText = `👤 پروفایل کاربری

📞 شماره شما: ${userData.phoneNumber}
👤 نام کاربری: ${userData.username}
🔗 آیدی عددی: ${userId}
📊 وضعیت: ${userData.currentCall ? '📞 در تماس' : '✅ آماده'}`;
  
  ctx.reply(profileText);
});

// پاسخ به mention در گروه - برای تماس گرفتن
bot.on('message', async (ctx) => {
  // فقط در گروه پردازش شود
  if (ctx.chat.type === 'private') return;
  
  const messageText = ctx.message.text || '';
  const botUsername = ctx.botInfo.username;
  
  // بررسی آیا ربات mention شده است
  if (messageText.includes(`@${botUsername}`)) {
    const parts = messageText.split(' ');
    const targetNumber = parts[1]; // شماره بعد از mention
    
    if (!targetNumber) {
      return ctx.reply('❌ لطفاً شماره مقصد را وارد کنید: @${botUsername} [شماره]');
    }
    
    const callerId = ctx.from.id;
    const callerData = users.get(callerId);
    
    if (!callerData || !callerData.registered) {
      return ctx.reply('❌ شما ثبت نام نکرده‌اید. لطفاً اول در چت خصوصی با من ثبت نام کنید.');
    }
    
    if (callerData.currentCall) {
      return ctx.reply('❌ شما در حال حاضر در تماس هستید. لطفاً ابتدا تماس قبلی را پایان دهید.');
    }
    
    // پیدا کردن کاربر مقصد
    let calleeId = null;
    let calleeData = null;
    
    for (const [userId, userData] of users.entries()) {
      if (userData.phoneNumber === targetNumber && userData.registered) {
        calleeId = userId;
        calleeData = userData;
        break;
      }
    }
    
    if (!calleeId) {
      return ctx.reply('❌ شماره مورد نظر یافت نشد یا کاربر ثبت نام نکرده است.');
    }
    
    if (calleeId === callerId) {
      return ctx.reply('❌ نمی‌توانید با خودتان تماس بگیرید!');
    }
    
    if (calleeData.currentCall) {
      return ctx.reply('❌ کاربر مقصد در حال حاضر در تماس است.');
    }
    
    // ایجاد تماس جدید
    const callId = uuidv4();
    const callData = {
      callId,
      callerId,
      calleeId,
      status: 'ringing',
      startTime: Date.now(),
      callerNumber: callerData.phoneNumber,
      calleeNumber: calleeData.phoneNumber,
      callerName: callerData.username,
      calleeName: calleeData.username,
      groupId: ctx.chat.id, // ذخیره آیدی گروه
      messageId: ctx.message.message_id // ذخیره آیدی پیام
    };
    
    calls.set(callId, callData);
    callerData.currentCall = callId;
    calleeData.currentCall = callId;
    
    // ارسال پیام شیشه‌ای در گروه به کاربر مقصد
    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.button.callback('📞 پاسخ دادن', `answer_${callId}`),
        Markup.button.callback('❌ رد تماس', `reject_${callId}`)
      ]
    ]);
    
    try {
      // ارسال پیام در گروه با ریپلای به پیام caller
      const sentMessage = await ctx.replyWithMarkdown(
        `📞 **تماس برای ${calleeData.username}**\n\nاز: ${callerData.phoneNumber} (${callerData.username})\n\n⏰ زمان: ${new Date().toLocaleTimeString('fa-IR')}`,
        {
          ...replyMarkup,
          reply_to_message_id: ctx.message.message_id
        }
      );
      
      // ذخیره ارتباط message_id با call_id
      messageCallMap.set(sentMessage.message_id, callId);
      
    } catch (error) {
      console.error('خطا در ارسال پیام:', error);
      ctx.reply('❌ خطا در برقراری تماس. ممکن است ربات دسترسی لازم را نداشته باشد.');
      callerData.currentCall = null;
      calleeData.currentCall = null;
      calls.delete(callId);
    }
    
    // زمان‌بندی برای قطع تماس در صورت عدم پاسخ
    callData.timeout = setTimeout(() => {
      const currentCall = calls.get(callId);
      if (currentCall && currentCall.status === 'ringing') {
        currentCall.status = 'missed';
        ctx.telegram.sendMessage(callerId, `⏰ تماس با ${targetNumber} پاسخ داده نشد.`);
        ctx.telegram.sendMessage(calleeId, `⏰ تماس از ${callerData.phoneNumber} پاسخ داده نشد.`);
        
        // حذف پیام تماس از گروه
        try {
          ctx.deleteMessage(currentCall.messageId);
        } catch (error) {
          console.log('خطا در حذف پیام:', error);
        }
        
        // بازنشانی وضعیت
        callerData.currentCall = null;
        calleeData.currentCall = null;
        calls.delete(callId);
        messageCallMap.delete(currentCall.messageId);
      }
    }, 60000);
  }
});

// مدیریت پاسخ به تماس (Callback Query)
bot.action(/answer_(.+)/, async (ctx) => {
  const callId = ctx.match[1];
  const callData = calls.get(callId);
  
  if (callData && callData.status === 'ringing') {
    callData.status = 'active';
    activeCalls.set(callId, callData);
    
    // لغو timeout
    if (callData.timeout) {
      clearTimeout(callData.timeout);
    }
    
    // حذف پیام شیشه‌ای
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.log('خطا در حذف پیام:', error);
    }
    
    // اطلاع به caller در گروه
    await ctx.telegram.sendMessage(
      callData.groupId,
      `✅ ${callData.calleeName} تماس را پاسخ داد. اکنون می‌توانید گفتگو کنید.`,
      { reply_to_message_id: callData.messageId }
    );
    
    // اطلاع به caller در خصوصی
    ctx.telegram.sendMessage(
      callData.callerId, 
      `✅ **تماس پاسخ داده شد**\n\n📞 با: ${callData.calleeNumber}\n👤 کاربر: ${callData.calleeName}`
    );
    
    // اطلاع به callee در خصوصی
    ctx.telegram.sendMessage(
      callData.calleeId,
      `✅ **شما تماس را پاسخ دادید**\n\n📞 با: ${callData.callerNumber}\n👤 کاربر: ${callData.callerName}`
    );
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  const callId = ctx.match[1];
  const callData = calls.get(callId);
  
  if (callData) {
    callData.status = 'rejected';
    
    // لغو timeout
    if (callData.timeout) {
      clearTimeout(callData.timeout);
    }
    
    // حذف پیام شیشه‌ای
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.log('خطا در حذف پیام:', error);
    }
    
    // اطلاع به caller در گروه
    await ctx.telegram.sendMessage(
      callData.groupId,
      `❌ ${callData.calleeName} تماس را رد کرد.`,
      { reply_to_message_id: callData.messageId }
    );
    
    // اطلاع به caller در خصوصی
    ctx.telegram.sendMessage(
      callData.callerId, 
      `❌ **تماس رد شد**\n\n📞 شماره: ${callData.calleeNumber}\n👤 کاربر: ${callData.calleeName}`
    );
    
    // بازنشانی وضعیت
    const callerData = users.get(callData.callerId);
    const calleeData = users.get(callData.calleeId);
    callerData.currentCall = null;
    calleeData.currentCall = null;
    calls.delete(callId);
    activeCalls.delete(callId);
    messageCallMap.delete(callData.messageId);
  }
});

// انتقال پیام‌های بین کاربران در تماس
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  
  const userId = ctx.from.id;
  const userData = users.get(userId);
  
  if (!userData || !userData.currentCall) return;
  
  const callData = calls.get(userData.currentCall);
  if (!callData || callData.status !== 'active') return;
  
  // پیدا کردن کاربر مقابل
  const partnerId = callData.callerId === userId ? callData.calleeId : callData.callerId;
  const partnerData = users.get(partnerId);
  
  if (partnerData) {
    // ارسال پیام به کاربر مقابل
    try {
      await ctx.telegram.sendMessage(
        partnerId, 
        `📞 **پیام از ${userData.phoneNumber}**\n\n${ctx.message.text}\n\n👤 ارسال کننده: ${userData.username}`
      );
    } catch (error) {
      console.error('خطا در ارسال پیام:', error);
    }
  }
});

// پایان تماس
bot.command('endcall', (ctx) => {
  const userId = ctx.from.id;
  const userData = users.get(userId);
  
  if (!userData || !userData.currentCall) {
    return ctx.reply('❌ شما در حال حاضر در تماس نیستید.');
  }
  
  const callData = calls.get(userData.currentCall);
  if (!callData) return;
  
  // پیدا کردن کاربر مقابل
  const partnerId = callData.callerId === userId ? callData.calleeId : callData.callerId;
  const partnerData = users.get(partnerId);
  
  if (partnerData) {
    // اطلاع به کاربر مقابل
    ctx.telegram.sendMessage(
      partnerId, 
      `📞 **تماس به پایان رسید**\n\n⏰ مدت تماس: ${Math.round((Date.now() - callData.startTime) / 1000)} ثانیه`
    );
  }
  
  // اگر تماس در گروه بود، اطلاع در گروه
  if (callData.groupId) {
    ctx.telegram.sendMessage(
      callData.groupId,
      `📞 تماس بین ${callData.callerName} و ${callData.calleeName} به پایان رسید.`,
      { reply_to_message_id: callData.messageId }
    ).catch(() => {}); // اگر خطا داد ignor کن
  }
  
  // بازنشانی وضعیت
  userData.currentCall = null;
  if (partnerData) partnerData.currentCall = null;
  calls.delete(userData.currentCall);
  activeCalls.delete(userData.currentCall);
  messageCallMap.delete(callData.messageId);
  
  ctx.reply('✅ تماس پایان یافت.');
});

// ================== راه‌اندازی سرور ================== //

// middleware برای پردازش JSON
app.use(express.json());

// وب‌هاک برای تلگرام
app.use(bot.webhookCallback('/telegram-webhook'));

// مسیر سلامت
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    users: users.size,
    activeCalls: activeCalls.size,
    totalCalls: calls.size
  });
});

// راه‌اندازی سرور
app.listen(PORT, async () => {
  console.log(`🚀 سرور در حال اجرا روی پورت ${PORT}`);
  
  // تنظیم وب‌هاک
  const webhookUrl = process.env.WEBHOOK_URL || `https://your-app-name.onrender.com`;
  
  try {
    await bot.telegram.setWebhook(`${webhookUrl}/telegram-webhook`);
    console.log('✅ وب‌هاک با موفقیت تنظیم شد');
  } catch (error) {
    console.error('❌ خطا در تنظیم وب‌هاک:', error.message);
  }
});

// مدیریت خطاها
bot.catch((err, ctx) => {
  console.error(`❌ خطا برای ${ctx.updateType}:`, err);
});

console.log('🤖 ربات مخابراتی پیشرفته در حال راه‌اندازی...');