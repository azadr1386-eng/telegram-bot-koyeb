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
  const firstName = ctx.from.first_name || 'کاربر';
  const welcomeText = `👋 سلام ${firstName} به ربات مخابراتی پیشرفته!

📞 برای استفاده از سرویس تماس، ابتدا باید شماره خود را ثبت کنید:
/register [شماره]

📞 برای تماس با کاربر دیگر:
/call [شماره مقصد]

📞 برای پایان تماس جاری:
/endcall

ℹ️ برای مشاهده اطلاعات کاربری:
/profile

🔧 برای راهنمایی کامل:
/help`;

  ctx.reply(welcomeText);
});

// دستور /help
bot.help((ctx) => {
  const helpText = `📖 راهنمای ربات مخابراتی:

1️⃣ ثبت شماره:
/register [شماره] - ثبت شماره تلفن شما
مثال: /register W0212

2️⃣ تماس گرفتن:
/call [شماره] - تماس با کاربر دیگر
مثال: /call N2132

3️⃣ مدیریت تماس:
/endcall - پایان تماس جاری

4️⃣ اطلاعات کاربری:
/profile - نمایش پروفایل شما

📞 هنگام تماس، می‌توانید با ارسال پیام معمولی با طرف مقابل چت کنید.`;

  ctx.reply(helpText);
});

// ثبت شماره کاربر
bot.command('register', (ctx) => {
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

// مشاهده پروفایل
bot.command('profile', (ctx) => {
  const userId = ctx.from.id;
  const userData = users.get(userId);
  
  if (!userData || !userData.registered) {
    return ctx.reply('❌ لطفاً ابتدا با دستور /register شماره خود را ثبت کنید.');
  }
  
  const profileText = `👤 پروفایل کاربری

📞 شماره شما: ${userData.phoneNumber}
👤 نام کاربری: ${userData.username}
🔗 آیدی عددی: ${userId}
📊 وضعیت: ${userData.currentCall ? '📞 در تماس' : '✅ آماده'}
🕒 تاریخ ثبت: ${new Date().toLocaleDateString('fa-IR')}`;
  
  ctx.reply(profileText);
});

// ایجاد تماس
bot.command('call', async (ctx) => {
  const callerId = ctx.from.id;
  const callerData = users.get(callerId);
  const targetNumber = ctx.message.text.split(' ')[1];
  
  if (!callerData || !callerData.registered) {
    return ctx.reply('❌ لطفاً ابتدا با دستور /register شماره خود را ثبت کنید.');
  }
  
  if (!targetNumber) {
    return ctx.reply('❌ لطفاً شماره مقصد را وارد کنید: /call [شماره]');
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
    calleeName: calleeData.username
  };
  
  calls.set(callId, callData);
  callerData.currentCall = callId;
  calleeData.currentCall = callId;
  
  // ارسال پیام به caller
  ctx.reply(`📞 در حال اتصال به ${targetNumber}...`);
  
  // ارسال پیام شیشه‌ای به callee
  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.button.callback('📞 پاسخ دادن', `answer_${callId}`),
      Markup.button.callback('❌ رد تماس', `reject_${callId}`)
    ]
  ]);
  
  ctx.telegram.sendMessage(calleeId, 
    `📞 **تماس ورودی**\n\nاز: ${callerData.phoneNumber} (${callerData.username})\n\n⏰ زمان: ${new Date().toLocaleTimeString('fa-IR')}`, 
    { 
      ...replyMarkup,
      parse_mode: 'Markdown'
    }
  );
  
  // زمان‌بندی برای قطع تماس در صورت عدم پاسخ
  const timeout = setTimeout(() => {
    const currentCall = calls.get(callId);
    if (currentCall && currentCall.status === 'ringing') {
      currentCall.status = 'missed';
      ctx.telegram.sendMessage(callerId, `⏰ تماس با ${targetNumber} پاسخ داده نشد.`);
      ctx.telegram.sendMessage(calleeId, `⏰ تماس از ${callerData.phoneNumber} پاسخ داده نشد.`);
      
      // بازنشانی وضعیت
      callerData.currentCall = null;
      calleeData.currentCall = null;
      calls.delete(callId);
    }
  }, 60000); // 1 دقیقه

  // ذخیره timeout برای مدیریت صحیح
  callData.timeout = timeout;
});

// مدیریت پاسخ به تماس (Callback Query)
bot.action(/answer_(.+)/, async (ctx) => {
  const callId = ctx.match[1];
  const callData = calls.get(callId);
  const userId = ctx.from.id;
  
  if (callData && callData.calleeId === userId && callData.status === 'ringing') {
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
    
    // اطلاع به caller
    ctx.telegram.sendMessage(
      callData.callerId, 
      `✅ **تماس پاسخ داده شد**\n\n📞 با: ${callData.calleeNumber}\n👤 کاربر: ${callData.calleeName}\n\n💬 اکنون می‌توانید گفتگو کنید.`,
      { parse_mode: 'Markdown' }
    );
    
    // اطلاع به callee
    ctx.reply(
      `✅ **شما تماس را پاسخ دادید**\n\n📞 با: ${callData.callerNumber}\n👤 کاربر: ${callData.callerName}\n\n💬 اکنون می‌توانید گفتگو کنید.`,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  const callId = ctx.match[1];
  const callData = calls.get(callId);
  const userId = ctx.from.id;
  
  if (callData && callData.calleeId === userId) {
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
    
    // اطلاع به caller
    ctx.telegram.sendMessage(
      callData.callerId, 
      `❌ **تماس رد شد**\n\n📞 شماره: ${callData.calleeNumber}\n👤 کاربر: ${callData.calleeName}\n\n⏰ زمان: ${new Date().toLocaleTimeString('fa-IR')}`,
      { parse_mode: 'Markdown' }
    );
    
    // بازنشانی وضعیت
    const callerData = users.get(callData.callerId);
    const calleeData = users.get(callData.calleeId);
    callerData.currentCall = null;
    calleeData.currentCall = null;
    calls.delete(callId);
    activeCalls.delete(callId);
  }
});

// انتقال پیام‌های بین کاربران در تماس
bot.on('text', (ctx) => {
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
    // ارسال پیام به کاربر مقابل (هاید)
    ctx.telegram.sendMessage(
      partnerId, 
      `📞 **پیام از ${userData.phoneNumber}**\n\n${ctx.message.text}\n\n👤 ارسال کننده: ${userData.username}`,
      { parse_mode: 'Markdown' }
    );
    
    // تأیید ارسال پیام برای فرستنده
    ctx.reply('✅ پیام شما ارسال شد.').then(sentMsg => {
      // حذف پیام تأیید بعد از 2 ثانیه
      setTimeout(() => {
        ctx.deleteMessage(sentMsg.message_id).catch(() => {});
      }, 2000);
    });
    
    // حذف پیام اصلی از چت
    ctx.deleteMessage().catch(() => {});
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
      `📞 **تماس به پایان رسید**\n\n⏰ مدت تماس: ${Math.round((Date.now() - callData.startTime) / 1000)} ثانیه\n👤 با: ${userData.phoneNumber}`,
      { parse_mode: 'Markdown' }
    );
  }
  
  // بازنشانی وضعیت
  userData.currentCall = null;
  if (partnerData) partnerData.currentCall = null;
  calls.delete(userData.currentCall);
  activeCalls.delete(userData.currentCall);
  
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

// مسیر اصلی
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>ربات مخابراتی تلگرام</title>
      <meta charset="utf-8">
      <style>
        body { font-family: Tahoma, sans-serif; text-align: center; padding: 50px; }
        h1 { color: #0088cc; }
        .status { background: #f0f9ff; padding: 20px; border-radius: 10px; }
      </style>
    </head>
    <body>
      <h1>🤖 ربات مخابراتی پیشرفته</h1>
      <div class="status">
        <p>✅ سرور فعال و آماده به کار</p>
        <p>👥 کاربران ثبت‌شده: ${users.size}</p>
        <p>📞 تماس‌های فعال: ${activeCalls.size}</p>
      </div>
    </body>
    </html>
  `);
});

// راه‌اندازی سرور
app.listen(PORT, async () => {
  console.log(`🚀 سرور در حال اجرا روی پورت ${PORT}`);
  
  // تنظیم وب‌هاک
  try {
    await bot.telegram.setWebhook(`${process.env.WEBHOOK_URL || 'http://localhost:' + PORT}/telegram-webhook`);
    console.log('✅ وب‌هاک با موفقیت تنظیم شد');
    
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('📋 اطلاعات وب‌هاک:', webhookInfo.url);
  } catch (error) {
    console.error('❌ خطا در تنظیم وب‌هاک:', error);
  }
});

// مدیریت خطاها
bot.catch((err, ctx) => {
  console.error(`❌ خطا برای ${ctx.updateType}:`, err);
  if (process.env.ADMIN_ID) {
    ctx.telegram.sendMessage(process.env.ADMIN_ID, `❌ خطا در ربات: ${err.message}`).catch(() => {});
  }
});

// مدیریت خروج تمیز
process.once('SIGINT', () => {
  console.log('🛑 در حال خروج...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('🛑 در حال خروج...');
  bot.stop('SIGTERM');
  process.exit(0);
});

console.log('🤖 ربات مخابراتی پیشرفته در حال راه‌اندازی...');