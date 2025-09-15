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

// تابع اعتبارسنجی شماره تلفن (بهبود یافته)
function isValidPhoneNumber(phone) {
  if (!phone) return false;
  const phoneRegex = /^[A-Za-z]\d{4}$/;
  return phoneRegex.test(phone.trim());
}

// تابع ایجاد منوی اصلی با دکمه‌های شیشه‌ای
function createMainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📞 مخاطبین', 'manage_contacts'),
      Markup.button.callback('📸 دوربین', 'camera'),
      Markup.button.callback('🖼️ گالری', 'gallery')
    ],
    [
      Markup.button.callback('📒 دفترچه', 'call_history'),
      Markup.button.callback('📞 تماس', 'quick_call'),
      Markup.button.callback('ℹ️ راهنما', 'help')
    ]
  ]);
}

// تابع ایجاد کیبورد پاسخ به تماس با استایل شیشه‌ای
function createCallResponseKeyboard(callId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ پاسخ', `answer_call_${callId}`),
      Markup.button.callback('❌ رد', `reject_call_${callId}`)
    ]
  ]);
}

// تابع ایجاد کیبورد پایان تماس با استایل شیشه‌ای
function createEndCallKeyboard(callId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📞 پایان تماس', `end_call_${callId}`)]
  ]);
}

// تابع ایجاد دکمه‌های مخاطبین با استایل شیشه‌ای
function createContactButtons(contacts) {
  const buttons = [];
  
  for (let i = 0; i < contacts.length; i += 2) {
    const row = contacts.slice(i, i + 2).map(contact => 
      Markup.button.callback(
        `👤 ${contact.contact_name}`,
        `quick_call_${contact.phone_number}`
      )
    );
    buttons.push(row);
  }
  
  buttons.push([Markup.button.callback('🔙 بازگشت به منوی اصلی', 'back_to_main')]);
  
  return Markup.inlineKeyboard(buttons);
}

// تابع ایجاد کیبورد مدیریت مخاطبین با استایل شیشه‌ای
function createContactsManagementKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ افزودن مخاطب جدید', 'add_contact')],
    [Markup.button.callback('📞 تماس از مخاطبین', 'call_from_contacts')],
    [Markup.button.callback('🗑️ مدیریت مخاطبین', 'delete_contact')],
    [Markup.button.callback('🏠 بازگشت به اصلی', 'back_to_main')]
  ]);
}

// بقیه توابع بدون تغییر می‌مانند...
// [بقیه توابع مانند findUserByPhone, saveCallHistory, sendCallToGroup و...]

// ================== دستورات اصلی ربات ================== //

// دستور /start با رابط شیشه‌ای
bot.start((ctx) => {
  console.log('دستور start دریافت شد از:', ctx.from.id);
  
  const welcomeText = `✨ **به ربات مخابراتی پیشرفته خوش آمدید!** ✨

🌐 **امکانات اصلی:**
📞 ثبت شماره تلفن در گروه
📞 برقراری تماس با سایر کاربران  
📞 مدیریت مخاطبین شخصی
📒 تاریخچه تماس‌ها

🛠 **دستورات سریع:**
/register - ثبت شماره تلفن
/contacts - مدیریت مخاطبین  
/call_history - تاریخچه تماس‌ها
/help - راهنمای استفاده

💎 از منوی زیر برای navigation استفاده کنید:`;

  ctx.reply(welcomeText, {
    parse_mode: 'Markdown',
    ...createMainMenu()
  }).catch(err => {
    console.error('خطا در ارسال welcome:', err);
  });
});

// دستور /register
bot.command('register', async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      return ctx.reply('❌ این دستور فقط در گروه‌ها قابل استفاده است.');
    }
    
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
      return ctx.reply('❌ لطفاً شماره تلفن را وارد کنید.\nمثال: `/register A1234`', {
        parse_mode: 'Markdown'
      });
    }
    
    const phoneNumber = parts[1].toUpperCase();
    
    if (!isValidPhoneNumber(phoneNumber)) {
      return ctx.reply('❌ فرمت شماره تلفن نامعتبر است.\n✅ باید با یک حرف انگلیسی شروع شود و به دنبال آن 4 رقم بیاید.\nمثال: `A1234`, `B5678`', {
        parse_mode: 'Markdown'
      });
    }
    
    // [کد ثبت شماره بدون تغییر]
    
    ctx.reply(`✅ شماره ${phoneNumber} با موفقیت ثبت شد.`);
  } catch (error) {
    console.error('خطا در ثبت شماره:', error);
    ctx.reply('❌ خطایی در ثبت شماره شما رخ داد.');
  }
});

// مدیریت مخاطبین با استایل شیشه‌ای
bot.command('contacts', async (ctx) => {
  try {
    let contactsText = '👥 **مخاطبین شما:**\n\n';
    let contacts = [];
    
    // [کد دریافت مخاطبین بدون تغییر]
    
    if (contacts.length === 0) {
      contactsText += '📭 هنوز مخاطبی اضافه نکرده‌اید.\n\n';
    } else {
      contacts.forEach((contact, index) => {
        contactsText += `${index + 1}. 👤 ${contact.contact_name} - 📞 ${contact.phone_number}\n`;
      });
    }
    
    contactsText += '\n💡 از دکمه‌های زیر برای مدیریت مخاطبین استفاده کنید:';
    
    await ctx.reply(contactsText, {
      parse_mode: 'Markdown',
      ...createContactsManagementKeyboard()
    });
  } catch (error) {
    console.error('خطا در مدیریت مخاطبین:', error);
    ctx.reply('❌ خطایی رخ داده است.');
  }
});

// هندلرهای دکمه‌های شیشه‌ای
bot.action('back_to_main', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    
    const now = new Date().toLocaleString('fa-IR', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    await ctx.reply(`📱 **منوی اصلی**\n🕒 زمان فعلی: ${now}`, {
      parse_mode: 'Markdown',
      ...createMainMenu()
    });
  } catch (error) {
    console.error('خطا در بازگشت به منوی اصلی:', error);
  }
});

// هندلر افزودن مخاطب
bot.action('add_contact', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    
    ctx.session.userState = USER_STATES.AWAITING_CONTACT_NAME;
    
    await ctx.reply('👤 لطفاً نام مخاطب را وارد کنید:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 بازگشت', callback_data: 'back_to_contacts' }]
        ]
      }
    });
  } catch (error) {
    console.error('خطا در افزودن مخاطب:', error);
  }
});

// هندلر تماس از مخاطبین
bot.action('call_from_contacts', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    
    let contacts = [];
    // [کد دریافت مخاطبین بدون تغییر]
    
    if (contacts.length === 0) {
      await ctx.reply('❌ شما هیچ مخاطبی ندارید.\n💡 ابتدا از منوی مخاطبین، مخاطبی اضافه کنید.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ افزودن مخاطب', callback_data: 'add_contact' }],
            [{ text: '🔙 بازگشت', callback_data: 'back_to_main' }]
          ]
        }
      });
      return;
    }
    
    await ctx.reply('📞 **انتخاب مخاطب برای تماس:**', {
      parse_mode: 'Markdown',
      ...createContactButtons(contacts)
    });
  } catch (error) {
    console.error('خطا در تماس از مخاطبین:', error);
  }
});

// [بقیه هندلرها و توابع بدون تغییر می‌مانند]

// راه‌اندازی سرور
app.listen(PORT, () => {
  console.log(`🚀 سرور در حال اجرا روی پورت ${PORT}`);
  bot.launch().then(() => {
    console.log('✅ ربات تلگرام راه‌اندازی شد');
  }).catch(err => {
    console.error('❌ خطا در راه‌اندازی ربات:', err);
  });
});

// graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  process.exit(0);
});