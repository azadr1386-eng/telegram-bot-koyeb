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
const users = new Map(); // user_id -> { phoneNumber, username, registered }
const calls = new Map(); // call_id -> callData
const userStates = new Map(); // user_id -> { currentCall, isInCall }

// مدیریت خطای دسترسی
bot.catch((err, ctx) => {
  if (err.message.includes('not enough rights')) {
    console.log('⚠️  ربات دسترسی لازم را در گروه ندارد');
    if (ctx.chat.type !== 'private') {
      ctx.reply('🤖 لطفاً مرا به عنوان ادمین گروه تنظیم کنید تا بتوانم کار کنم.').catch(() => {});
    }
  } else {
    console.error('❌ خطای ربات:', err);
  }
});

// ================== دستورات ربات ================== //

// دستور /start - فقط در گروه
bot.start((ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('🤖 لطفاً من را به گروه اضافه کنید و در آنجا با من کار کنید.');
  }
  
  const welcomeText = `👋 به ربات مخابراتی خوش آمدید!

📞 برای ثبت شماره خود:
/register [شماره]

📞 برای تماس با کاربر دیگر:
@${ctx.botInfo.username} [شماره مقصد]

📞 برای پایان تماس جاری:
/endcall

ℹ️ برای مشاهده اطلاعات کاربری:
/profile`;

  ctx.reply(welcomeText);
});

// ثبت شماره کاربر - فقط در گروه
bot.command('register', (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('🤖 لطفاً این دستور را در گروه استفاده کنید.');
  }
  
  const userId = ctx.from.id;
  const phoneNumber = ctx.message.text.split(' ')[1];
  
  if (!phoneNumber) {
    return ctx.reply('❌ لطفاً شماره را وارد کنید: /register [شماره]');
  }
  
  users.set(userId, {
    phoneNumber,
    username: ctx.from.username || ctx.from.first_name || 'کاربر',
    registered: true
  });
  
  ctx.reply(`✅ شماره ${phoneNumber} برای ${ctx.from.first_name} ثبت شد!`);
});

// مشاهده پروفایل - فقط در گروه
bot.command('profile', (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('🤖 لطفاً این دستور را در گروه استفاده کنید.');
  }
  
  const userId = ctx.from.id;
  const userData = users.get(userId);
  
  if (!userData || !userData.registered) {
    return ctx.reply('❌ شما ثبت نام نکرده‌اید. اول /register [شماره] را بزنید.');
  }
  
  const profileText = `👤 پروفایل ${userData.username}

📞 شماره: ${userData.phoneNumber}
🔗 آیدی: ${userId}
📊 وضعیت: ${userStates.get(userId)?.currentCall ? '📞 در تماس' : '✅ آماده'}`;
  
  ctx.reply(profileText);
});

// پایان تماس - فقط در گروه
bot.command('endcall', (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('🤖 لطفاً این دستور را در گروه استفاده کنید.');
  }
  
  const userId = ctx.from.id;
  const userState = userStates.get(userId);
  
  if (!userState || !userState.currentCall) {
    return ctx.reply('❌ شما در حال حاضر در تماس نیستید.');
  }
  
  const callData = calls.get(userState.currentCall);
  if (!callData) return;
  
  // پیدا کردن کاربر مقابل
  const partnerId = callData.callerId === userId ? callData.calleeId : callData.callerId;
  
  // اطلاع در گروه
  ctx.reply(`📞 تماس بین ${callData.callerName} و ${callData.calleeName} به پایان رسید.`);
  
  // بازنشانی وضعیت
  userStates.delete(userId);
  userStates.delete(partnerId);
  calls.delete(userState.currentCall);
  
  ctx.reply('✅ تماس پایان یافت.');
});

// پردازش mention در گروه برای تماس
bot.on('message', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  
  const messageText = ctx.message.text || '';
  const botUsername = ctx.botInfo.username;
  
  // بررسی آیا ربات mention شده است
  if (messageText.includes(`@${botUsername}`)) {
    const parts = messageText.split(' ');
    const targetNumber = parts[1]; // شماره بعد از mention
    
    if (!targetNumber) {
      return ctx.reply(`❌ لطفاً شماره مقصد را وارد کنید: @${botUsername} [شماره]`);
    }
    
    const callerId = ctx.from.id;
    const callerData = users.get(callerId);
    
    if (!callerData || !callerData.registered) {
      return ctx.reply('❌ شما ثبت نام نکرده‌اید. اول /register [شماره] را بزنید.');
    }
    
    const callerState = userStates.get(callerId);
    if (callerState && callerState.currentCall) {
      return ctx.reply('❌ شما در حال حاضر در تماس هستید. اول /endcall را بزنید.');
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
    
    const calleeState = userStates.get(calleeId);
    if (calleeState && calleeState.currentCall) {
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
      groupId: ctx.chat.id,
      messageId: ctx.message.message_id
    };
    
    calls.set(callId, callData);
    userStates.set(callerId, { currentCall: callId, isInCall: false });
    userStates.set(calleeId, { currentCall: callId, isInCall: false });
    
    // ارسال پیام تماس در گروه با ریپلای
    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.button.callback('📞 پاسخ دادن', `answer_${callId}_${calleeId}`),
        Markup.button.callback('❌ رد تماس', `reject_${callId}_${calleeId}`)
      ]
    ]);
    
    try {
      const mentionText = calleeData.username ? `@${calleeData.username}` : calleeData.phoneNumber;
      
      await ctx.reply(
        `📞 ${mentionText} \n\n${callerData.username} با شماره ${callerData.phoneNumber} به شما زنگ زده!\n\n⏰ زمان: ${new Date().toLocaleTimeString('fa-IR')}`,
        {
          ...replyMarkup,
          reply_to_message_id: ctx.message.message_id
        }
      );
    } catch (error) {
      console.error('خطا در ارسال پیام:', error);
      ctx.reply('❌ خطا در برقراری تماس.');
      userStates.delete(callerId);
      userStates.delete(calleeId);
      calls.delete(callId);
      return;
    }
    
    // زمان‌بندی برای قطع تماس
    callData.timeout = setTimeout(() => {
      const currentCall = calls.get(callId);
      if (currentCall && currentCall.status === 'ringing') {
        ctx.reply(`⏰ تماس با ${calleeData.phoneNumber} پاسخ داده نشد.`);
        userStates.delete(callerId);
        userStates.delete(calleeId);
        calls.delete(callId);
      }
    }, 60000);
  }
});

// مدیریت پاسخ به تماس
bot.action(/answer_(.+)_(.+)/, async (ctx) => {
  const [_, callId, calleeId] = ctx.match;
  const callData = calls.get(callId);
  const userId = ctx.from.id;
  
  if (callData && callData.status === 'ringing' && userId === calleeId) {
    callData.status = 'active';
    
    // لغو timeout
    if (callData.timeout) {
      clearTimeout(callData.timeout);
    }
    
    // به روزرسانی وضعیت کاربران
    userStates.set(callData.callerId, { currentCall: callId, isInCall: true });
    userStates.set(callData.calleeId, { currentCall: callId, isInCall: true });
    
    // حذف پیام شیشه‌ای
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.log('خطا در حذف پیام:', error);
    }
    
    // اطلاع در گروه
    ctx.reply(
      `✅ ${callData.calleeName} تماس را پاسخ داد. اکنون می‌توانید گفتگو کنید.\n\n💬 برای چت، پیام خود را بفرستید.`,
      { reply_to_message_id: callData.messageId }
    );
  }
});

bot.action(/reject_(.+)_(.+)/, async (ctx) => {
  const [_, callId, calleeId] = ctx.match;
  const callData = calls.get(callId);
  const userId = ctx.from.id;
  
  if (callData && userId === calleeId) {
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
    
    // اطلاع در گروه
    ctx.reply(
      `❌ ${callData.calleeName} تماس را رد کرد.`,
      { reply_to_message_id: callData.messageId }
    );
    
    // بازنشانی وضعیت
    userStates.delete(callData.callerId);
    userStates.delete(callData.calleeId);
    calls.delete(callId);
  }
});

// انتقال پیام‌های بین کاربران در تماس
bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  if (ctx.message.text.startsWith('/')) return;
  
  const userId = ctx.from.id;
  const userState = userStates.get(userId);
  
  if (!userState || !userState.currentCall || !userState.isInCall) return;
  
  const callData = calls.get(userState.currentCall);
  if (!callData || callData.status !== 'active') return;
  
  // پیدا کردن کاربر مقابل
  const partnerId = callData.callerId === userId ? callData.calleeId : callData.callerId;
  const partnerData = users.get(partnerId);
  
  if (partnerData) {
    // ارسال پیام به صورت mention در گروه
    const mentionText = partnerData.username ? `@${partnerData.username}` : partnerData.phoneNumber;
    
    ctx.reply(
      `📞 ${mentionText} \n\n${ctx.from.first_name}: ${ctx.message.text}`,
      { reply_to_message_id: callData.messageId }
    );
  }
});

// ================== راه‌اندازی سرور ================== //

app.use(express.json());

// مسیر سلامت
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    users: users.size,
    activeCalls: Array.from(calls.values()).filter(call => call.status === 'active').length
  });
});

// مسیر وب‌هاک
app.use(bot.webhookCallback('/telegram-webhook'));

// راه‌اندازی سرور
app.listen(PORT, async () => {
  console.log(`🚀 سرور در حال اجرا روی پورت ${PORT}`);
  
  try {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('❌ WEBHOOK_URL تنظیم نشده است');
      return;
    }
    
    // تنظیم Webhook
    const fullWebhookUrl = `${webhookUrl}/telegram-webhook`;
    await bot.telegram.setWebhook(fullWebhookUrl);
    console.log('✅ وب‌هاک تنظیم شد:', fullWebhookUrl);
    
  } catch (error) {
    console.error('❌ خطا در تنظیم وب‌هاک:', error.message);
  }
});

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('🤖 ربات مخابراتی گروهی در حال راه‌اندازی...');