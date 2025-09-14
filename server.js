const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const config = require('./config.json');
const db = require('./database');

// ایجاد نمونه ربات
const bot = new TelegramBot(config.botToken);

// ایجاد اپلیکیشن Express
const app = express();
app.use(bodyParser.json());

// مسیر وب‌هاک برای تلگرام
app.post('/telegram-webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// مسیر سلامت سرویس
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// راه‌اندازی سرور (بدون HTTPS - Render خودش مدیریت می‌کنه)
const port = process.env.PORT || config.webhookPort || 3000;
app.listen(port, () => {
  console.log(`سرور روی پورت ${port} اجرا شد`);
  
  // تنظیم وب‌هاک
  const webhookUrl = process.env.WEBHOOK_URL || config.webhookUrl;
  bot.setWebHook(`${webhookUrl}/telegram-webhook`)
    .then(() => console.log('Webhook با موفقیت تنظیم شد'))
    .catch(error => console.error('خطا در تنظیم Webhook:', error));
});

// ========== دستورات ربات ========== //

// ثبت کاربر
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  await db.addUser({
    userId,
    phoneNumber: null,
    currentCall: null,
    contactNumber: null,
    registered: false
  });
  
  const welcomeText = `👋 به ربات مخابراتی خوش آمدید!

📞 برای استفاده از سرویس تماس، ابتدا باید شماره خود را ثبت کنید:
/register [شماره]

📞 برای تماس با کاربر دیگر:
/call [شماره مقصد]

📞 برای پایان تماس جاری:
/endcall

ℹ️ برای مشاهده اطلاعات کاربری:
/profile`;
  
  bot.sendMessage(chatId, welcomeText);
});

// ثبت شماره کاربر
bot.onText(/\/register (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const phoneNumber = match[1];
  
  await db.updateUser(userId, {
    phoneNumber,
    registered: true
  });
  
  bot.sendMessage(chatId, `✅ شماره ${phoneNumber} با موفقیت ثبت شد!`);
});

// مشاهده پروفایل
bot.onText(/\/profile/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const user = await db.getUser(userId);
  
  if (!user || !user.registered) {
    bot.sendMessage(chatId, '❌ لطفاً ابتدا با دستور /register شماره خود را ثبت کنید.');
    return;
  }
  
  const profileText = `👤 پروفایل کاربری

📞 شماره شما: ${user.phoneNumber}
🔗 آیدی کاربری: ${userId}
📊 وضعیت: ${user.currentCall ? 'در تماس' : 'آماده'}`;
  
  bot.sendMessage(chatId, profileText);
});

// ایجاد تماس
bot.onText(/\/call (.+)/, async (msg, match) => {
  const callerId = msg.from.id;
  const chatId = msg.chat.id;
  const caller = await db.getUser(callerId);
  
  if (!caller || !caller.registered) {
    bot.sendMessage(chatId, '❌ لطفاً ابتدا با دستور /register شماره خود را ثبت کنید.');
    return;
  }
  
  if (caller.currentCall) {
    bot.sendMessage(chatId, '❌ شما در حال حاضر در تماس هستید. لطفاً ابتدا تماس قبلی را پایان دهید.');
    return;
  }
  
  const targetNumber = match[1];
  
  // جستجوی کاربر مقصد
  const allUsers = (await db.db.read()).data.users;
  const callee = allUsers.find(u => u.phoneNumber === targetNumber && u.registered);
  
  if (!callee) {
    bot.sendMessage(chatId, '❌ شماره مورد نظر یافت نشد یا کاربر ثبت نام نکرده است.');
    return;
  }
  
  if (callee.userId === callerId) {
    bot.sendMessage(chatId, '❌ نمی‌توانید با خودتان تماس بگیرید!');
    return;
  }
  
  if (callee.currentCall) {
    bot.sendMessage(chatId, '❌ کاربر مقصد در حال حاضر در تماس است.');
    return;
  }
  
  // ایجاد تماس جدید
  const callId = uuidv4();
  const callData = {
    callId,
    callerId,
    calleeId: callee.userId,
    status: 'ringing',
    startTime: Date.now(),
    callerNumber: caller.phoneNumber,
    calleeNumber: callee.phoneNumber
  };
  
  await db.addCall(callData);
  await db.updateUser(callerId, { currentCall: callId });
  await db.updateUser(callee.userId, { currentCall: callId });
  
  // ارسال پیام به caller
  bot.sendMessage(chatId, `📞 در حال اتصال به ${targetNumber}...`);
  
  // ارسال پیام شیشه‌ای به callee
  const replyMarkup = {
    inline_keyboard: [[
      { text: '📞 پاسخ', callback_data: `answer_${callId}` },
      { text: '❌ رد تماس', callback_data: `reject_${callId}` }
    ]]
  };
  
  bot.sendMessage(callee.userId, `📞 تماس ورودی از ${caller.phoneNumber}...`, { reply_markup: replyMarkup });
  
  // زمان‌بندی برای قطع تماس در صورت عدم پاسخ
  setTimeout(async () => {
    const currentCall = await db.getCall(callId);
    if (currentCall && currentCall.status === 'ringing') {
      await db.updateCall(callId, { status: 'missed' });
      await db.updateUser(callerId, { currentCall: null });
      await db.updateUser(callee.userId, { currentCall: null });
      
      bot.sendMessage(callerId, `⏰ تماس با ${targetNumber} پاسخ داده نشد.`);
      bot.sendMessage(callee.userId, `⏰ تماس از ${caller.phoneNumber} پاسخ داده نشد.`);
    }
  }, config.callTimeout);
});

// مدیریت پاسخ به تماس
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;
  
  if (data.startsWith('answer_')) {
    const callId = data.split('_')[1];
    const call = await db.getCall(callId);
    
    if (call && call.calleeId === userId && call.status === 'ringing') {
      await db.updateCall(callId, { status: 'active' });
      bot.answerCallbackQuery(callbackQuery.id, { text: 'تماس پاسخ داده شد' });
      
      // حذف پیام شیشه‌ای
      bot.deleteMessage(userId, messageId).catch(() => {});
      
      // اطلاع به caller
      bot.sendMessage(call.callerId, `✅ تماس با ${call.calleeNumber} پاسخ داده شد. اکنون می‌توانید گفتگو کنید.`);
      
      // اطلاع به callee
      bot.sendMessage(userId, `✅ شما به تماس ${call.callerNumber} پاسخ دادید. اکنون می‌توانید گفتگو کنید.`);
    }
  } else if (data.startsWith('reject_')) {
    const callId = data.split('_')[1];
    const call = await db.getCall(callId);
    
    if (call && call.calleeId === userId) {
      await db.updateCall(callId, { status: 'rejected' });
      bot.answerCallbackQuery(callbackQuery.id, { text: 'تماس رد شد' });
      
      // حذف پیام شیشه‌ای
      bot.deleteMessage(userId, messageId).catch(() => {});
      
      // اطلاع به caller
      bot.sendMessage(call.callerId, `❌ تماس شما با ${call.calleeNumber} رد شد.`);
      
      // بازنشانی وضعیت
      await db.updateUser(call.callerId, { currentCall: null });
      await db.updateUser(userId, { currentCall: null });
      await db.deleteCall(callId);
    }
  }
});

// انتقال پیام‌های بین کاربران در تماس
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  
  const userId = msg.from.id;
  const user = await db.getUser(userId);
  
  if (!user || !user.currentCall) return;
  
  const call = await db.getCall(user.currentCall);
  if (!call || call.status !== 'active') return;
  
  // پیدا کردن کاربر مقابل
  const partnerId = call.callerId === userId ? call.calleeId : call.callerId;
  const partner = await db.getUser(partnerId);
  
  if (partner) {
    // ارسال پیام به کاربر مقابل
    const messageText = `📞 ${user.phoneNumber}: ${msg.text}`;
    bot.sendMessage(partnerId, messageText);
  }
});

// پایان تماس
bot.onText(/\/endcall/, async (msg) => {
  const userId = msg.from.id;
  const user = await db.getUser(userId);
  
  if (!user || !user.currentCall) {
    bot.sendMessage(msg.chat.id, '❌ شما در حال حاضر در تماس نیستید.');
    return;
  }
  
  const call = await db.getCall(user.currentCall);
  if (!call) return;
  
  // پیدا کردن کاربر مقابل
  const partnerId = call.callerId === userId ? call.calleeId : call.callerId;
  
  // اطلاع به کاربر مقابل
  bot.sendMessage(partnerId, '📞 تماس به پایان رسید.');
  
  // بازنشانی وضعیت
  await db.updateUser(userId, { currentCall: null });
  await db.updateUser(partnerId, { currentCall: null });
  await db.deleteCall(user.currentCall);
  
  bot.sendMessage(msg.chat.id, '✅ تماس پایان یافت.');
});

// مدیریت خطاهای ربات
bot.on('error', (error) => {
  console.error('Bot error:', error);
});

console.log('🤖 ربات مخابراتی با وب‌هاک آماده است...');