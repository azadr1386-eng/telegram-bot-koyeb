const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// بررسی وجود توکن
if (!process.env.BOT_TOKEN) {
  console.error('❌ خطا: توکن ربات تنظیم نشده است');
  process.exit(1);
}

// ایجاد کلاینت Supabase
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log('✅ Supabase متصل شد');
} else {
  console.warn('⚠️ Supabase تنظیم نشده است. از حافظه موقت استفاده می‌شود.');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session({
  defaultSession: () => ({
    userState: 'none',
    userPhone: null,
    contacts: [],
    calls: [],
    activeCall: null
  })
}));

// وضعیت‌های کاربر
const USER_STATES = {
  NONE: 'none',
  AWAITING_PHONE: 'awaiting_phone',
  AWAITING_CONTACT_NAME: 'awaiting_contact_name',
  AWAITING_CONTACT_PHONE: 'awaiting_contact_phone',
  IN_CALL: 'in_call'
};

// مدیریت خطا
bot.catch((err, ctx) => {
  console.error('❌ خطای ربات:', err);
  if (ctx && ctx.reply) {
    ctx.reply('❌ متأسفانه خطایی در پردازش درخواست شما رخ داده است.').catch(() => {});
  }
});

// تابع اعتبارسنجی شماره تلفن
function isValidPhoneNumber(phone) {
  if (!phone) return false;
  const phoneRegex = /^[Ww]\d{4}$/;
  return phoneRegex.test(phone.trim());
}

// تابع ایجاد منوی اصلی
function createMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📞 مخاطبین', 'manage_contacts')],
    [Markup.button.callback('📞 تماس سریع', 'quick_call')],
    [Markup.button.callback('📒 دفترچه تلفن', 'call_history')],
    [Markup.button.callback('⚙️ تنظیمات', 'settings')],
    [Markup.button.callback('ℹ️ راهنما', 'help')]
  ]);
}

// تابع ایجاد کیبورد پاسخ به تماس
function createCallResponseKeyboard(callId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📞 پاسخ', `answer_call_${callId}`)],
    [Markup.button.callback('❌ رد تماس', `reject_call_${callId}`)]
  ]);
}

// تابع ایجاد کیبورد پایان تماس
function createEndCallKeyboard(callId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📞 پایان تماس', `end_call_${callId}`)]
  ]);
}

// تابع جستجوی کاربر بر اساس شماره تلفن
async function findUserByPhone(phoneNumber) {
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('user_id, username')
      .eq('phone_number', phoneNumber.toUpperCase())
      .single();
    
    if (error) {
      console.error('خطا در جستجوی کاربر:', error);
      return null;
    }
    
    return data;
  }
  
  // در حالت بدون دیتابیس، نمی‌توانیم کاربر را پیدا کنیم
  return null;
}

// تابع ذخیره تاریخچه تماس
async function saveCallHistory(callData) {
  if (supabase) {
    const { error } = await supabase
      .from('call_history')
      .insert({
        call_id: callData.callId,
        caller_id: callData.callerId,
        caller_phone: callData.callerPhone,
        receiver_id: callData.receiverId,
        receiver_phone: callData.receiverPhone,
        status: callData.status,
        duration: callData.duration,
        started_at: callData.startTime,
        ended_at: callData.endTime
      });
    
    if (error) {
      console.error('خطا در ذخیره تاریخچه تماس:', error);
    }
  } else {
    // ذخیره در حافظه موقت
    if (!global.callHistory) global.callHistory = [];
    global.callHistory.push(callData);
  }
}

// ================== دستورات اصلی ربات ================== //

// دستور /start
bot.start((ctx) => {
  console.log('دستور start دریافت شد از:', ctx.from.id);
  const welcomeText = `👋 به ربات مخابراتی خوش آمدید!

📞 برای ثبت شماره خود در گروه:
/register [شماره]

📞 برای تماس با کاربر دیگر در گروه:
@${ctx.botInfo.username} [شماره مقصد]

📞 برای پایان تماس جاری:
/endcall

📱 برای مشاهده منوی اصلی:
#فون

📒 برای مدیریت مخاطبین:
/contacts

ℹ️ برای مشاهده اطلاعات کاربری:
/profile`;

  ctx.reply(welcomeText).catch(err => {
    console.error('خطا در ارسال welcome:', err);
  });
});

// دستور /register
bot.command('register', async (ctx) => {
  try {
    // بررسی اینکه آیا کاربر در یک گروه است
    if (ctx.chat.type === 'private') {
      return ctx.reply('❌ این دستور فقط در گروه‌ها قابل استفاده است.');
    }
    
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
      return ctx.reply('❌ لطفاً شماره تلفن را وارد کنید. مثال: /register W1234');
    }
    
    const phoneNumber = parts[1];
    
    if (!isValidPhoneNumber(phoneNumber)) {
      return ctx.reply('❌ فرمت شماره تلفن نامعتبر است. باید با W شروع شود و به دنبال آن 4 رقم بیاید. مثال: W1234');
    }
    
    // ذخیره شماره کاربر
    if (supabase) {
      const { error } = await supabase
        .from('users')
        .upsert({
          user_id: ctx.from.id,
          username: ctx.from.username || `${ctx.from.first_name}${ctx.from.last_name ? `_${ctx.from.last_name}` : ''}`,
          phone_number: phoneNumber.toUpperCase(),
          group_id: ctx.chat.id,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
      
      if (error) {
        console.error('خطا در ذخیره کاربر:', error);
        return ctx.reply('❌ خطایی در ثبت شماره شما رخ داد.');
      }
    } else {
      // حالت fallback بدون دیتابیس
      ctx.session.userPhone = phoneNumber.toUpperCase();
      ctx.session.groupId = ctx.chat.id;
    }
    
    ctx.reply(`✅ شماره ${phoneNumber.toUpperCase()} با موفقیت ثبت شد.`);
  } catch (error) {
    console.error('خطا در ثبت شماره:', error);
    ctx.reply('❌ خطایی در ثبت شماره شما رخ داد.');
  }
});

// دستور /contacts - مدیریت مخاطبین
bot.command('contacts', async (ctx) => {
  try {
    let contactsText = '📞 مخاطبین شما:\n\n';
    let contacts = [];
    
    if (supabase) {
      // دریافت مخاطبین کاربر از دیتابیس
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', ctx.from.id)
        .order('contact_name', { ascending: true });
      
      if (error) {
        console.error('خطا در دریافت مخاطبین:', error);
        contactsText += '❌ خطایی در دریافت مخاطبین رخ داد.';
      } else if (data && data.length === 0) {
        contactsText += 'هنوز مخاطبی اضافه نکرده‌اید.\n\n';
      } else {
        contacts = data || [];
        contacts.forEach((contact, index) => {
          contactsText += `${index + 1}. ${contact.contact_name} - ${contact.phone_number}\n`;
        });
      }
    } else {
      // حالت fallback بدون دیتابیس
      if (ctx.session.contacts && ctx.session.contacts.length > 0) {
        contacts = ctx.session.contacts;
        contacts.forEach((contact, index) => {
          contactsText += `${index + 1}. ${contact.contact_name} - ${contact.phone_number}\n`;
        });
      } else {
        contactsText += 'هنوز مخاطبی اضافه نکرده‌اید.\n\n';
      }
    }
    
    // ایجاد دکمه‌های مدیریت مخاطبین
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ افزودن مخاطب', 'add_contact')],
      [Markup.button.callback('📞 تماس از مخاطبین', 'call_from_contacts')],
      [Markup.button.callback('🗑️ حذف مخاطب', 'delete_contact')],
      [Markup.button.callback('🔙 بازگشت', 'back_to_main')]
    ]);
    
    await ctx.reply(contactsText, keyboard);
  } catch (error) {
    console.error('خطا در مدیریت مخاطبین:', error);
    ctx.reply('❌ خطایی رخ داده است.');
  }
});

// دستور /call_history - تاریخچه تماس‌ها
bot.command('call_history', async (ctx) => {
  try {
    let historyText = '📒 تاریخچه تماس‌های اخیر:\n\n';
    let callHistory = [];
    
    if (supabase) {
      // دریافت تاریخچه تماس از دیتابیس
      const { data, error } = await supabase
        .from('call_history')
        .select('*')
        .or(`caller_id.eq.${ctx.from.id},receiver_id.eq.${ctx.from.id}`)
        .order('started_at', { ascending: false })
        .limit(10);
      
      if (error) {
        console.error('خطا در دریافت تاریخچه تماس:', error);
        historyText += '❌ خطایی در دریافت تاریخچه تماس رخ داد.';
      } else if (data && data.length === 0) {
        historyText += 'هنوز تماسی ثبت نشده است.\n\n';
      } else {
        callHistory = data || [];
        callHistory.forEach((call, index) => {
          const isOutgoing = call.caller_id === ctx.from.id;
          const duration = call.duration ? `${call.duration} ثانیه` : 'پاسخ داده نشد';
          const statusEmoji = call.status === 'answered' ? '✅' : '❌';
          const direction = isOutgoing ? '📤 به' : '📥 از';
          const contact = isOutgoing ? call.receiver_phone : call.caller_phone;
          
          historyText += `${index + 1}. ${direction} ${contact} - ${statusEmoji} ${duration}\n`;
          historyText += `   📅 ${new Date(call.started_at).toLocaleDateString('fa-IR')}\n\n`;
        });
      }
    } else {
      // حالت fallback بدون دیتابیس
      if (global.callHistory && global.callHistory.length > 0) {
        callHistory = global.callHistory
          .filter(call => call.callerId === ctx.from.id || call.receiverId === ctx.from.id)
          .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
          .slice(0, 10);
        
        if (callHistory.length === 0) {
          historyText += 'هنوز تماسی ثبت نشده است.\n\n';
        } else {
          callHistory.forEach((call, index) => {
            const isOutgoing = call.callerId === ctx.from.id;
            const duration = call.duration ? `${call.duration} ثانیه` : 'پاسخ داده نشد';
            const statusEmoji = call.status === 'answered' ? '✅' : '❌';
            const direction = isOutgoing ? '📤 به' : '📥 از';
            const contact = isOutgoing ? call.receiverPhone : call.callerPhone;
            
            historyText += `${index + 1}. ${direction} ${contact} - ${statusEmoji} ${duration}\n`;
            historyText += `   📅 ${new Date(call.startTime).toLocaleDateString('fa-IR')}\n\n`;
          });
        }
      } else {
        historyText += 'هنوز تماسی ثبت نشده است.\n\n';
      }
    }
    
    await ctx.reply(historyText);
  } catch (error) {
    console.error('خطا در دریافت تاریخچه تماس:', error);
    ctx.reply('❌ خطایی در دریافت تاریخچه تماس رخ داد.');
  }
});

// پاسخ به mention ربات برای تماس
bot.on('text', async (ctx) => {
  try {
    // بررسی آیا ربات mention شده است
    if (ctx.message.text && ctx.message.text.includes(`@${ctx.botInfo.username}`)) {
      // بررسی اینکه آیا کاربر در یک گروه است
      if (ctx.chat.type === 'private') {
        return ctx.reply('❌ این قابلیت فقط در گروه‌ها قابل استفاده است.');
      }
      
      const parts = ctx.message.text.split(' ');
      if (parts.length < 2) {
        return ctx.reply('❌ لطفاً شماره مقصد را وارد کنید. مثال: @${ctx.botInfo.username} W1234');
      }
      
      const targetPhone = parts[1].toUpperCase();
      
      if (!isValidPhoneNumber(targetPhone)) {
        return ctx.reply('❌ فرمت شماره تلفن نامعتبر است. باید با W شروع شود و به دنبال آن 4 رقم بیاید. مثال: W1234');
      }
      
      // بررسی آیا کاربر شماره خود را ثبت کرده است
      let userPhone = null;
      
      if (supabase) {
        const { data: user, error } = await supabase
          .from('users')
          .select('phone_number')
          .eq('user_id', ctx.from.id)
          .single();
        
        if (error || !user) {
          return ctx.reply('❌ ابتدا باید شماره خود را ثبت کنید. از دستور /register استفاده کنید.');
        }
        
        userPhone = user.phone_number;
      } else if (ctx.session.userPhone) {
        userPhone = ctx.session.userPhone;
      } else {
        return ctx.reply('❌ ابتدا باید شماره خود را ثبت کنید. از دستور /register استفاده کنید.');
      }
      
      // جستجوی کاربر مقصد
      const targetUser = await findUserByPhone(targetPhone);
      if (!targetUser) {
        return ctx.reply('❌ کاربری با این شماره یافت نشد.');
      }
      
      // ایجاد تماس
      const callId = uuidv4();
      const callMessage = await ctx.reply(
        `📞 تماس از: ${userPhone}\n📞 به: ${targetPhone}\n\n⏳ در حال برقراری ارتباط...`,
        createCallResponseKeyboard(callId)
      );
      
      // ذخیره اطلاعات تماس
      const callData = {
        callId,
        callerId: ctx.from.id,
        callerPhone: userPhone,
        receiverId: targetUser.user_id,
        receiverPhone: targetPhone,
        status: 'ringing',
        startTime: new Date(),
        messageId: callMessage.message_id,
        chatId: ctx.chat.id
      };
      
      // ذخیره در حافظه
      if (!global.activeCalls) global.activeCalls = {};
      global.activeCalls[callId] = callData;
      
      // زمان‌بندی برای رد خودکار تماس پس از 1 دقیقه
      setTimeout(async () => {
        if (global.activeCalls[callId] && global.activeCalls[callId].status === 'ringing') {
          global.activeCalls[callId].status = 'missed';
          global.activeCalls[callId].endTime = new Date();
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            callMessage.message_id,
            null,
            `📞 تماس از: ${userPhone}\n📞 به: ${targetPhone}\n\n❌ تماس پاسخ داده نشد.`
          );
          
          // ذخیره تاریخچه تماس
          await saveCallHistory(global.activeCalls[callId]);
          delete global.activeCalls[callId];
        }
      }, 60000); // 1 دقیقه
      
      return;
    }
    
    // پردازش وضعیت‌های کاربر
    if (ctx.session.userState === USER_STATES.AWAITING_CONTACT_NAME) {
      const contactName = ctx.message.text;
      
      if (contactName.length < 2) {
        return ctx.reply('❌ نام مخاطب باید حداقل ۲ کاراکتر باشد.');
      }
      
      ctx.session.tempContactName = contactName;
      ctx.session.userState = USER_STATES.AWAITING_CONTACT_PHONE;
      
      await ctx.reply('لطفاً شماره تلفن مخاطب را وارد کنید (فرمت: W1234):');
      return;
    } 
    else if (ctx.session.userState === USER_STATES.AWAITING_CONTACT_PHONE) {
      const phoneNumber = ctx.message.text.toUpperCase();
      
      if (!isValidPhoneNumber(phoneNumber)) {
        return ctx.reply('❌ فرمت شماره تلفن نامعتبر است. باید با W شروع شود و به دنبال آن 4 رقم بیاید. مثال: W1234');
      }
      
      const contactName = ctx.session.tempContactName;
      
      if (supabase) {
        const { error } = await supabase
          .from('contacts')
          .insert({
            user_id: ctx.from.id,
            contact_name: contactName,
            phone_number: phoneNumber,
            created_at: new Date().toISOString()
          });
        
        if (error) {
          console.error('خطا در ذخیره مخاطب:', error);
          return ctx.reply('❌ خطایی در ذخیره مخاطب رخ داد.');
        }
      } else {
        // حالت fallback بدون دیتابیس
        if (!ctx.session.contacts) ctx.session.contacts = [];
        ctx.session.contacts.push({
          contact_name: contactName,
          phone_number: phoneNumber
        });
      }
      
      // پاکسازی وضعیت
      ctx.session.userState = USER_STATES.NONE;
      delete ctx.session.tempContactName;
      
      await ctx.reply(`✅ مخاطب "${contactName}" با شماره ${phoneNumber} با موفقیت افزوده شد.`);
      return;
    }
    
    // دستور #فون - نمایش منوی اصلی
    if (ctx.message.text && ctx.message.text.includes('#فون')) {
      // دریافت زمان و تاریخ فعلی
      const now = new Date().toLocaleString('fa-IR', {
        timeZone: 'Asia/Tehran',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });

      await ctx.reply(`📱 منوی اصلی\n🕒 زمان فعلی: ${now}`, createMainMenu());
      return;
    }
    
  } catch (error) {
    console.error('خطا در پردازش متن:', error);
    ctx.reply('❌ خطایی در پردازش درخواست شما رخ داد.');
  }
});

// مدیریت پاسخ به تماس
bot.action(/answer_call_(.+)/, async (ctx) => {
  try {
    const callId = ctx.match[1];
    const callData = global.activeCalls[callId];
    
    if (!callData || callData.status !== 'ringing') {
      return ctx.answerCbQuery('❌ این تماس دیگر فعال نیست.');
    }
    
    // بررسی اینکه آیا کاربر مجاز به پاسخ به تماس است
    if (ctx.from.id !== callData.receiverId) {
      return ctx.answerCbQuery('❌ فقط کاربر مورد نظر می‌تواند به این تماس پاسخ دهد.');
    }
    
    // به‌روزرسانی وضعیت تماس
    callData.status = 'answered';
    callData.answerTime = new Date();
    
    await ctx.telegram.editMessageText(
      callData.chatId,
      callData.messageId,
      null,
      `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n\n✅ تماس برقرار شد.`,
      createEndCallKeyboard(callId)
    );
    
    ctx.answerCbQuery('✅ تماس پاسخ داده شد.');
  } catch (error) {
    console.error('خطا در پاسخ به تماس:', error);
    ctx.answerCbQuery('❌ خطایی در پاسخ به تماس رخ داد.');
  }
});

// مدیریت رد تماس
bot.action(/reject_call_(.+)/, async (ctx) => {
  try {
    const callId = ctx.match[1];
    const callData = global.activeCalls[callId];
    
    if (!callData || callData.status !== 'ringing') {
      return ctx.answerCbQuery('❌ این تماس دیگر فعال نیست.');
    }
    
    // بررسی اینکه آیا کاربر مجاز به رد تماس است
    if (ctx.from.id !== callData.receiverId) {
      return ctx.answerCbQuery('❌ فقط کاربر مورد نظر می‌تواند این تماس را رد کند.');
    }
    
    // به‌روزرسانی وضعیت تماس
    callData.status = 'rejected';
    callData.endTime = new Date();
    
    await ctx.telegram.editMessageText(
      callData.chatId,
      callData.messageId,
      null,
      `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n\n❌ تماس رد شد.`
    );
    
    // ذخیره تاریخچه تماس
    await saveCallHistory(callData);
    delete global.activeCalls[callId];
    
    ctx.answerCbQuery('❌ تماس رد شد.');
  } catch (error) {
    console.error('خطا در رد تماس:', error);
    ctx.answerCbQuery('❌ خطایی در رد تماس رخ داد.');
  }
});

// مدیریت پایان تماس
bot.action(/end_call_(.+)/, async (ctx) => {
  try {
    const callId = ctx.match[1];
    const callData = global.activeCalls[callId];
    
    if (!callData || callData.status !== 'answered') {
      return ctx.answerCbQuery('❌ این تماس دیگر فعال نیست.');
    }
    
    // بررسی اینکه آیا کاربر مجاز به پایان تماس است
    if (ctx.from.id !== callData.callerId && ctx.from.id !== callData.receiverId) {
      return ctx.answerCbQuery('❌ فقط کاربران درگیر در تماس می‌توانند آن را پایان دهند.');
    }
    
    // محاسبه مدت تماس
    const endTime = new Date();
    const duration = Math.round((endTime - callData.answerTime) / 1000);
    
    // به‌روزرسانی وضعیت تماس
    callData.status = 'ended';
    callData.endTime = endTime;
    callData.duration = duration;
    
    await ctx.telegram.editMessageText(
      callData.chatId,
      callData.messageId,
      null,
      `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n\n📞 تماس پایان یافت.\n⏰ مدت تماس: ${duration} ثانیه`
    );
    
    // ذخیره تاریخچه تماس
    await saveCallHistory(callData);
    delete global.activeCalls[callId];
    
    ctx.answerCbQuery('✅ تماس پایان یافت.');
  } catch (error) {
    console.error('خطا در پایان تماس:', error);
    ctx.answerCbQuery('❌ خطایی در پایان تماس رخ داد.');
  }
});

// تماس سریع از مخاطبین
bot.action('call_from_contacts', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    
    let contacts = [];
    
    if (supabase) {
      // دریافت مخاطبین کاربر از دیتابیس
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', ctx.from.id)
        .order('contact_name', { ascending: true });
      
      if (error) {
        console.error('خطا در دریافت مخاطبین:', error);
        return ctx.reply('❌ خطایی در دریافت مخاطبین رخ داد.');
      }
      
      contacts = data || [];
    } else {
      // حالت fallback بدون دیتابیس
      contacts = ctx.session.contacts || [];
    }
    
    if (contacts.length === 0) {
      return ctx.reply('❌ شما هیچ مخاطبی ندارید. ابتدا مخاطبی اضافه کنید.');
    }
    
    // ایجاد دکمه‌های مخاطبین برای تماس
    const contactButtons = contacts.map(contact => [
      Markup.button.callback(
        `📞 ${contact.contact_name} - ${contact.phone_number}`,
        `quick_call_${contact.phone_number}`
      )
    ]);
    
    const keyboard = Markup.inlineKeyboard([
      ...contactButtons,
      [Markup.button.callback('🔙 بازگشت', 'back_to_main')]
    ]);
    
    await ctx.reply('📞 انتخاب مخاطب برای تماس:', keyboard);
  } catch (error) {
    console.error('خطا در تماس سریع:', error);
    ctx.reply('❌ خطایی در تماس سریع رخ داد.');
  }
});

// مدیریت تماس سریع
bot.action(/quick_call_(.+)/, async (ctx) => {
  try {
    const phoneNumber = ctx.match[1];
    
    // بررسی اینکه آیا کاربر در یک گروه است
    if (ctx.chat.type === 'private') {
      return ctx.answerCbQuery('❌ این قابلیت فقط در گروه‌ها قابل استفاده است.');
    }
    
    // بررسی آیا کاربر شماره خود را ثبت کرده است
    let userPhone = null;
    
    if (supabase) {
      const { data: user, error } = await supabase
        .from('users')
        .select('phone_number')
        .eq('user_id', ctx.from.id)
        .single();
      
      if (error || !user) {
        return ctx.answerCbQuery('❌ ابتدا باید شماره خود را ثبت کنید.');
      }
      
      userPhone = user.phone_number;
    } else if (ctx.session.userPhone) {
      userPhone = ctx.session.userPhone;
    } else {
      return ctx.answerCbQuery('❌ ابتدا باید شماره خود را ثبت کنید.');
    }
    
    // جستجوی کاربر مقصد
    const targetUser = await findUserByPhone(phoneNumber);
    if (!targetUser) {
      return ctx.answerCbQuery('❌ کاربری با این شماره یافت نشد.');
    }
    
    // ایجاد تماس
    const callId = uuidv4();
    const callMessage = await ctx.reply(
      `📞 تماس از: ${userPhone}\n📞 به: ${phoneNumber}\n\n⏳ در حال برقراری ارتباط...`,
      createCallResponseKeyboard(callId)
    );
    
    // ذخیره اطلاعات تماس
    const callData = {
      callId,
      callerId: ctx.from.id,
      callerPhone: userPhone,
      receiverId: targetUser.user_id,
      receiverPhone: phoneNumber,
      status: 'ringing',
      startTime: new Date(),
      messageId: callMessage.message_id,
      chatId: ctx.chat.id
    };
    
    // ذخیره در حافظه
    if (!global.activeCalls) global.activeCalls = {};
    global.activeCalls[callId] = callData;
    
    // زمان‌بندی برای رد خودکار تماس پس از 1 دقیقه
    setTimeout(async () => {
      if (global.activeCalls[callId] && global.activeCalls[callId].status === 'ringing') {
        global.activeCalls[callId].status = 'missed';
        global.activeCalls[callId].endTime = new Date();
        
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          callMessage.message_id,
          null,
          `📞 تماس از: ${userPhone}\n📞 به: ${phoneNumber}\n\n❌ تماس پاسخ داده نشد.`
        );
        
        // ذخیره تاریخچه تماس
        await saveCallHistory(global.activeCalls[callId]);
        delete global.activeCalls[callId];
      }
    }, 60000); // 1 دقیقه
    
    ctx.answerCbQuery('📞 در حال برقراری تماس...');
  } catch (error) {
    console.error('خطا در تماس سریع:', error);
    ctx.answerCbQuery('❌ خطایی در تماس سریع رخ داد.');
  }
});

// بقیه هندلرها (مانند قبل)...

// ================== راه‌اندازی سرور و Webhook ================== //

app.use(express.json());

// مسیر سلامت
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'ربات تلگرام در حال اجراست',
    webhook: true
  });
});

// مسیر وب‌هاک
app.use(bot.webhookCallback('/telegram-webhook'));

// راه‌اندازی سرور
app.listen(PORT, async () => {
  console.log(`🚀 سرور در حال اجرا روی پورت ${PORT}`);
  
  try {
    // تنظیم وب‌هاک
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('❌ WEBHOOK_URL تنظیم نشده است');
      process.exit(1);
    }
    
    const fullWebhookUrl = `${webhookUrl}/telegram-webhook`;
    await bot.telegram.setWebhook(fullWebhookUrl);
    console.log('✅ وب‌هاک تنظیم شد:', fullWebhookUrl);
    
  } catch (error) {
    console.error('❌ خطا در تنظیم وب‌هاک:', error.message);
    process.exit(1);
  }
  
  console.log('🤖 ربات مخابراتی مبتنی بر Webhook آماده است');
});

// مدیریت graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 دریافت SIGINT - خاموش کردن ربات...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('🛑 دریافت SIGTERM - خاموش کردن ربات...');
  bot.stop('SIGTERM');
  process.exit(0);
});