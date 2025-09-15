const { Telegraf, Markup } = require('telegraf');
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

// ایجاد کلاینت Supabase (اگر تنظیم شده باشد)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log('✅ Supabase متصل شد');
} else {
  console.warn('⚠️ Supabase تنظیم نشده است. برخی قابلیت‌ها غیرفعال خواهند بود.');
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// دیتابیس ساده در حافظه
const users = new Map();
const calls = new Map();
const userStates = new Map();

// مدیریت خطا
bot.catch((err, ctx) => {
  console.error('❌ خطای ربات:', err);
  if (ctx && ctx.reply) {
    ctx.reply('❌ متأسفانه خطایی در پردازش درخواست شما رخ داده است.').catch(() => {});
  }
});

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

ℹ️ برای مشاهده اطلاعات کاربری:
/profile`;

  ctx.reply(welcomeText).catch(err => {
    console.error('خطا در ارسال welcome:', err);
  });
});

// دستور #فون - نمایش منوی اصلی
bot.hears('#فون', async (ctx) => {
  try {
    console.log('دستور فون دریافت شد از:', ctx.from.id);
    
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

    // ایجاد دکمه‌های شیشه‌ای
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📞 مخاطبین', 'manage_contacts')],
      [Markup.button.callback('🖼️ گالری', 'open_gallery')],
      [Markup.button.callback('⚙️ تنظیمات', 'settings')],
      [Markup.button.callback('ℹ️ راهنما', 'help')]
    ]);

    // ارسال پیام
    await ctx.reply(`🕒 زمان فعلی: ${now}`, keyboard);
  } catch (error) {
    console.error('خطا در اجرای دستور فون:', error);
    ctx.reply('متأسفانه خطایی رخ داده است.').catch(() => {});
  }
});

// مدیریت کلیک روی دکمه مخاطبین
bot.action('manage_contacts', async (ctx) => {
  try {
    await ctx.deleteMessage();
    
    let contactsText = '📞 مخاطبین شما:\n\n';
    
    if (supabase) {
      // دریافت مخاطبین کاربر از دیتابیس
      const { data: contacts, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', ctx.from.id);
      
      if (error) {
        console.error('خطا در دریافت مخاطبین:', error);
        contactsText += '❌ خطایی در دریافت مخاطبین رخ داد.';
      } else if (contacts.length === 0) {
        contactsText += 'هنوز مخاطبی اضافه نکرده‌اید.\n\n';
      } else {
        contacts.forEach((contact, index) => {
          contactsText += `${index + 1}. ${contact.contact_name} - ${contact.phone_prefix}${contact.phone_number}\n`;
        });
      }
    } else {
      contactsText += '❌ سیستم ذخیره‌سازی مخاطبین در حال حاضر غیرفعال است.';
    }
    
    contactsText += '\nبرای اضافه کردن مخاطب جدید، شماره را با فرمت صحیح ارسال کنید (مثال: W1234)';
    
    // ایجاد دکمه بازگشت
    const backKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 بازگشت', 'back_to_main')]
    ]);
    
    await ctx.reply(contactsText, backKeyboard);
    
    // تنظیم وضعیت کاربر برای دریافت شماره
    userStates.set(ctx.from.id, { action: 'awaiting_phone' });
  } catch (error) {
    console.error('خطا در مدیریت مخاطبین:', error);
    ctx.reply('❌ خطایی رخ داده است.');
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

// مسیر تست وب‌هاک
app.get('/test-webhook', async (req, res) => {
  try {
    // بررسی وضعیت وب‌هاک
    const webhookInfo = await bot.telegram.getWebhookInfo();
    
    res.json({ 
      status: 'WEBHOOK_TEST_OK',
      webhook_url: webhookInfo.url,
      pending_updates: webhookInfo.pending_update_count,
      last_error: webhookInfo.last_error_message
    });
  } catch (error) {
    res.status(500).json({
      status: 'WEBHOOK_TEST_FAILED',
      error: error.message
    });
  }
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
    
    // بررسی وضعیت وب‌هاک
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('📋 اطلاعات وب‌هاک:', {
      url: webhookInfo.url,
      has_custom_certificate: webhookInfo.has_custom_certificate,
      pending_update_count: webhookInfo.pending_update_count,
      last_error_date: webhookInfo.last_error_date,
      last_error_message: webhookInfo.last_error_message
    });
    
  } catch (error) {
    console.error('❌ خطا در تنظیم وب‌هاک:', error.message);
    process.exit(1);
  }
  
  console.log('🤖 ربات مخابراتی مبتنی بر Webhook آماده است');
});

// مدیریت graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 دریافت SIGINT - خاموش کردن ربات...');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('🛑 دریافت SIGTERM - خاموش کردن ربات...');
  process.exit(0);
});
