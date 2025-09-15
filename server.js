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
  console.warn('⚠️ Supabase تنظیم نشده است. برخی قابلیت‌ها غیرفعال خواهند بود.');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// وضعیت‌های کاربر
const USER_STATES = {
  AWAITING_PHONE: 'awaiting_phone',
  AWAITING_CONTACT_NAME: 'awaiting_contact_name',
  IN_CALL: 'in_call'
};

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
    const phoneNumber = ctx.message.text.split(' ')[1];
    
    if (!phoneNumber) {
      return ctx.reply('❌ لطفاً شماره تلفن را وارد کنید. مثال: /register W1234');
    }
    
    if (!isValidPhoneNumber(phoneNumber)) {
      return ctx.reply('❌ فرمت شماره تلفن نامعتبر است. باید با W شروع شود و به دنبال آن 4 رقم بیاید. مثال: W1234');
    }
    
    // ذخیره شماره کاربر
    if (supabase) {
      const { data, error } = await supabase
        .from('users')
        .upsert({
          user_id: ctx.from.id,
          username: ctx.from.username || `${ctx.from.first_name}${ctx.from.last_name ? `_${ctx.from.last_name}` : ''}`,
          phone_number: phoneNumber,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
      
      if (error) {
        console.error('خطا در ذخیره کاربر:', error);
        return ctx.reply('❌ خطایی در ثبت شماره شما رخ داد.');
      }
    } else {
      // حالت fallback بدون دیتابیس
      ctx.session.userPhone = phoneNumber;
    }
    
    ctx.reply(`✅ شماره ${phoneNumber} با موفقیت ثبت شد.`);
  } catch (error) {
    console.error('خطا در ثبت شماره:', error);
    ctx.reply('❌ خطایی در ثبت شماره شما رخ داد.');
  }
});

// دستور /contacts - مدیریت مخاطبین
bot.command('contacts', async (ctx) => {
  try {
    let contactsText = '📞 مخاطبین شما:\n\n';
    
    if (supabase) {
      // دریافت مخاطبین کاربر از دیتابیس
      const { data: contacts, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', ctx.from.id)
        .order('contact_name', { ascending: true });
      
      if (error) {
        console.error('خطا در دریافت مخاطبین:', error);
        contactsText += '❌ خطایی در دریافت مخاطبین رخ داد.';
      } else if (contacts.length === 0) {
        contactsText += 'هنوز مخاطبی اضافه نکرده‌اید.\n\n';
      } else {
        contacts.forEach((contact, index) => {
          contactsText += `${index + 1}. ${contact.contact_name} - ${contact.phone_number}\n`;
        });
      }
    } else {
      contactsText += '❌ سیستم ذخیره‌سازی مخاطبین در حال حاضر غیرفعال است.';
    }
    
    // ایجاد دکمه‌های مدیریت مخاطبین
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ افزودن مخاطب', 'add_contact')],
      [Markup.button.callback('🗑️ حذف مخاطب', 'delete_contact')],
      [Markup.button.callback('🔙 بازگشت', 'back_to_main')]
    ]);
    
    await ctx.reply(contactsText, keyboard);
  } catch (error) {
    console.error('خطا در مدیریت مخاطبین:', error);
    ctx.reply('❌ خطایی رخ داده است.');
  }
});

// دستور /profile - نمایش پروفایل کاربر
bot.command('profile', async (ctx) => {
  try {
    let profileText = `👤 اطلاعات کاربری:\n\n`;
    profileText += `🆔 شناسه کاربری: ${ctx.from.id}\n`;
    profileText += `👤 نام: ${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}\n`;
    if (ctx.from.username) {
      profileText += `📧 نام کاربری: @${ctx.from.username}\n`;
    }
    
    if (supabase) {
      // دریافت اطلاعات کاربر از دیتابیس
      const { data: user, error } = await supabase
        .from('users')
        .select('phone_number, created_at')
        .eq('user_id', ctx.from.id)
        .single();
      
      if (!error && user) {
        profileText += `📞 شماره تلفن: ${user.phone_number || 'ثبت نشده'}\n`;
        if (user.created_at) {
          profileText += `📅 تاریخ عضویت: ${new Date(user.created_at).toLocaleDateString('fa-IR')}\n`;
        }
      }
    } else if (ctx.session.userPhone) {
      profileText += `📞 شماره تلفن: ${ctx.session.userPhone}\n`;
    } else {
      profileText += `📞 شماره تلفن: ثبت نشده\n`;
    }
    
    await ctx.reply(profileText);
  } catch (error) {
    console.error('خطا در نمایش پروفایل:', error);
    ctx.reply('❌ خطایی در دریافت اطلاعات پروفایل رخ داد.');
  }
});

// دستور /endcall - پایان تماس
bot.command('endcall', async (ctx) => {
  try {
    if (ctx.session.callStatus) {
      const callId = ctx.session.callStatus.callId;
      // اینجا باید منطق پایان تماس پیاده‌سازی شود
      delete ctx.session.callStatus;
      ctx.reply('✅ تماس پایان یافت.');
    } else {
      ctx.reply('❌ شما در حال حاضر در تماس نیستید.');
    }
  } catch (error) {
    console.error('خطا در پایان تماس:', error);
    ctx.reply('❌ خطایی در پایان تماس رخ داد.');
  }
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
      [Markup.button.callback('📞 تماس سریع', 'quick_call')],
      [Markup.button.callback('📒 دفترچه تلفن', 'phonebook')],
      [Markup.button.callback('⚙️ تنظیمات', 'settings')],
      [Markup.button.callback('ℹ️ راهنما', 'help')]
    ]);

    // ارسال پیام
    await ctx.reply(`📱 منوی اصلی\n🕒 زمان فعلی: ${now}`, keyboard);
  } catch (error) {
    console.error('خطا در اجرای دستور فون:', error);
    ctx.reply('متأسفانه خطایی رخ داده است.').catch(() => {});
  }
});

// مدیریت کلیک روی دکمه مخاطبین
bot.action('manage_contacts', async (ctx) => {
  try {
    await ctx.deleteMessage();
    await ctx.replyWithChatAction('typing');
    
    let contactsText = '📞 مخاطبین شما:\n\n';
    
    if (supabase) {
      // دریافت مخاطبین کاربر از دیتابیس
      const { data: contacts, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', ctx.from.id)
        .order('contact_name', { ascending: true });
      
      if (error) {
        console.error('خطا در دریافت مخاطبین:', error);
        contactsText += '❌ خطایی در دریافت مخاطبین رخ داد.';
      } else if (contacts.length === 0) {
        contactsText += 'هنوز مخاطبی اضافه نکرده‌اید.\n\n';
      } else {
        contacts.forEach((contact, index) => {
          contactsText += `${index + 1}. ${contact.contact_name} - ${contact.phone_number}\n`;
        });
      }
    } else {
      contactsText += '❌ سیستم ذخیره‌سازی مخاطبین در حال حاضر غیرفعال است.';
    }
    
    contactsText += '\nبرای اضافه کردن مخاطب جدید، از دکمه زیر استفاده کنید.';
    
    // ایجاد دکمه‌های مدیریت مخاطبین
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ افزودن مخاطب', 'add_contact')],
      [Markup.button.callback('🗑️ حذف مخاطب', 'delete_contact')],
      [Markup.button.callback('🔙 بازگشت', 'back_to_main')]
    ]);
    
    await ctx.reply(contactsText, keyboard);
  } catch (error) {
    console.error('خطا در مدیریت مخاطبین:', error);
    ctx.reply('❌ خطایی رخ داده است.');
  }
});

// افزودن مخاطب
bot.action('add_contact', async (ctx) => {
  try {
    await ctx.deleteMessage();
    ctx.session.userState = USER_STATES.AWAITING_CONTACT_NAME;
    await ctx.reply('لطفاً نام مخاطب را وارد کنید:');
  } catch (error) {
    console.error('خطا در افزودن مخاطب:', error);
    ctx.reply('❌ خطایی رخ داده است.');
  }
});

// پردازش نام مخاطب
bot.on('text', async (ctx) => {
  try {
    if (ctx.session.userState === USER_STATES.AWAITING_CONTACT_NAME) {
      const contactName = ctx.message.text;
      ctx.session.contactName = contactName;
      ctx.session.userState = USER_STATES.AWAITING_PHONE;
      await ctx.reply('لطفاً شماره تلفن مخاطب را وارد کنید (فرمت: W1234):');
    } 
    else if (ctx.session.userState === USER_STATES.AWAITING_PHONE) {
      const phoneNumber = ctx.message.text;
      
      if (!isValidPhoneNumber(phoneNumber)) {
        return ctx.reply('❌ فرمت شماره تلفن نامعتبر است. باید با W شروع شود و به دنبال آن 4 رقم بیاید. مثال: W1234');
      }
      
      if (supabase) {
        const { error } = await supabase
          .from('contacts')
          .insert({
            user_id: ctx.from.id,
            contact_name: ctx.session.contactName,
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
          contact_name: ctx.session.contactName,
          phone_number: phoneNumber
        });
      }
      
      // پاکسازی وضعیت
      delete ctx.session.userState;
      delete ctx.session.contactName;
      
      await ctx.reply(`✅ مخاطب "${ctx.session.contactName}" با شماره ${phoneNumber} با موفقیت افزوده شد.`);
    }
  } catch (error) {
    console.error('خطا در پردازش متن:', error);
    ctx.reply('❌ خطایی رخ داده است.');
  }
});

// بازگشت به منوی اصلی
bot.action('back_to_main', async (ctx) => {
  try {
    await ctx.deleteMessage();
    
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

    // ایجاد دکمه‌های منوی اصلی
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📞 مخاطبین', 'manage_contacts')],
      [Markup.button.callback('📞 تماس سریع', 'quick_call')],
      [Markup.button.callback('📒 دفترچه تلفن', 'phonebook')],
      [Markup.button.callback('⚙️ تنظیمات', 'settings')],
      [Markup.button.callback('ℹ️ راهنما', 'help')]
    ]);

    await ctx.reply(`📱 منوی اصلی\n🕒 زمان فعلی: ${now}`, keyboard);
  } catch (error) {
    console.error('خطا در بازگشت به منوی اصلی:', error);
    ctx.reply('❌ خطایی رخ داده است.');
  }
});

// سایر action handlers
bot.action('quick_call', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('این قابلیت به زودی اضافه خواهد شد.');
});

bot.action('phonebook', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('این قابلیت به زودی اضافه خواهد شد.');
});

bot.action('settings', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('این قابلیت به زودی اضافه خواهد شد.');
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`📖 راهنمای ربات مخابراتی:

📞 ثبت شماره:
/register [شماره] - ثبت شماره تلفن شما (مثال: /register W1234)

📞 مدیریت مخاطبین:
/contacts - مشاهده و مدیریت مخاطبین

📞 برقراری تماس:
@${ctx.botInfo.username} [شماره] - تماس با شماره مورد نظر

📞 پایان تماس:
/endcall - پایان تماس جاری

👤 اطلاعات کاربری:
/profile - مشاهده اطلاعات پروفایل

📱 منوی اصلی:
#فون - نمایش منوی اصلی ربات`);
});

// تابع اعتبارسنجی شماره تلفن
function isValidPhoneNumber(phone) {
  const phoneRegex = /^[Ww]\d{4}$/;
  return phoneRegex.test(phone);
}

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
    
    // ایجاد جداول مورد نیاز در Supabase اگر وجود ندارند
    if (supabase) {
      await createTablesIfNotExist();
    }
    
  } catch (error) {
    console.error('❌ خطا در تنظیم وب‌هاک:', error.message);
    process.exit(1);
  }
  
  console.log('🤖 ربات مخابراتی مبتنی بر Webhook آماده است');
});

// تابع ایجاد جداول در Supabase
async function createTablesIfNotExist() {
  try {
    // ایجاد جدول users اگر وجود ندارد
    const { error: usersError } = await supabase.rpc('create_users_table_if_not_exists');
    if (usersError && !usersError.message.includes('already exists')) {
      console.error('خطا در ایجاد جدول users:', usersError);
    }
    
    // ایجاد جدول contacts اگر وجود ندارد
    const { error: contactsError } = await supabase.rpc('create_contacts_table_if_not_exists');
    if (contactsError && !contactsError.message.includes('already exists')) {
      console.error('خطا در ایجاد جدول contacts:', contactsError);
    }
    
    console.log('✅ جداول دیتابیس بررسی شدند');
  } catch (error) {
    console.error('خطا در ایجاد جداول:', error);
  }
}

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