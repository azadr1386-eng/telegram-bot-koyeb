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
bot.use(session());

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
    [Markup.button.callback('📒 دفترچه تلفن', 'phonebook')],
    [Markup.button.callback('⚙️ تنظیمات', 'settings')],
    [Markup.button.callback('ℹ️ راهنما', 'help')]
  ]);
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
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
      
      if (error) {
        console.error('خطا در ذخیره کاربر:', error);
        return ctx.reply('❌ خطایی در ثبت شماره شما رخ داد.');
      }
    } else {
      // حالت fallback بدون دیتابیس
      if (!ctx.session) ctx.session = {};
      ctx.session.userPhone = phoneNumber.toUpperCase();
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
      if (ctx.session && ctx.session.contacts && ctx.session.contacts.length > 0) {
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
    
    let userPhone = null;
    
    if (supabase) {
      // دریافت اطلاعات کاربر از دیتابیس
      const { data: user, error } = await supabase
        .from('users')
        .select('phone_number, created_at')
        .eq('user_id', ctx.from.id)
        .single();
      
      if (!error && user) {
        userPhone = user.phone_number;
        profileText += `📞 شماره تلفن: ${user.phone_number || 'ثبت نشده'}\n`;
        if (user.created_at) {
          profileText += `📅 تاریخ عضویت: ${new Date(user.created_at).toLocaleDateString('fa-IR')}\n`;
        }
      }
    } else if (ctx.session && ctx.session.userPhone) {
      userPhone = ctx.session.userPhone;
      profileText += `📞 شماره تلفن: ${ctx.session.userPhone}\n`;
    } else {
      profileText += `📞 شماره تلفن: ثبت نشده\n`;
    }
    
    // نمایش وضعیت تماس
    if (ctx.session && ctx.session.callStatus) {
      profileText += `📞 وضعیت تماس: در حال مکالمه با ${ctx.session.callStatus.with}\n`;
    } else {
      profileText += `📞 وضعیت تماس: در حال حاضر در تماس نیستید\n`;
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
    if (ctx.session && ctx.session.callStatus) {
      const callWith = ctx.session.callStatus.with;
      delete ctx.session.callStatus;
      ctx.reply(`✅ تماس با ${callWith} پایان یافت.`);
    } else {
      ctx.reply('❌ شما در حال حاضر در تماس نیستید.');
    }
  } catch (error) {
    console.error('خطا در پایان تماس:', error);
    ctx.reply('❌ خطایی در پایان تماس رخ داد.');
  }
});

// پاسخ به mention ربات برای تماس
bot.on('text', async (ctx) => {
  try {
    // بررسی آیا ربات mention شده است
    if (ctx.message.text && ctx.message.text.includes(`@${ctx.botInfo.username}`)) {
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
      } else if (ctx.session && ctx.session.userPhone) {
        userPhone = ctx.session.userPhone;
      } else {
        return ctx.reply('❌ ابتدا باید شماره خود را ثبت کنید. از دستور /register استفاده کنید.');
      }
      
      // شبیه‌سازی تماس
      if (!ctx.session) ctx.session = {};
      ctx.session.callStatus = {
        callId: uuidv4(),
        from: userPhone,
        with: targetPhone,
        startTime: new Date()
      };
      
      ctx.reply(`📞 در حال برقراری تماس با ${targetPhone}...\n\nبرای پایان تماس از دستور /endcall استفاده کنید.`);
      
      // شبیه‌سازی پاسخ بعد از چند ثانیه
      setTimeout(() => {
        ctx.reply(`✅ تماس با ${targetPhone} برقرار شد.`);
      }, 2000);
      
      return;
    }
    
    // پردازش وضعیت‌های کاربر
    if (ctx.session && ctx.session.userState) {
      if (ctx.session.userState === USER_STATES.AWAITING_CONTACT_NAME) {
        const contactName = ctx.message.text;
        
        if (contactName.length < 2) {
          return ctx.reply('❌ نام مخاطب باید حداقل ۲ کاراکتر باشد.');
        }
        
        if (!ctx.session) ctx.session = {};
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
        delete ctx.session.userState;
        delete ctx.session.tempContactName;
        
        await ctx.reply(`✅ مخاطب "${contactName}" با شماره ${phoneNumber} با موفقیت افزوده شد.`);
        return;
      }
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

// مدیریت کلیک روی دکمه مخاطبین
bot.action('manage_contacts', async (ctx) => {
  try {
    await ctx.deleteMessage();
    
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
      if (ctx.session && ctx.session.contacts && ctx.session.contacts.length > 0) {
        contacts = ctx.session.contacts;
        contacts.forEach((contact, index) => {
          contactsText += `${index + 1}. ${contact.contact_name} - ${contact.phone_number}\n`;
        });
      } else {
        contactsText += 'هنوز مخاطبی اضافه نکرده‌اید.\n\n';
      }
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
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    
    if (!ctx.session) ctx.session = {};
    ctx.session.userState = USER_STATES.AWAITING_CONTACT_NAME;
    
    await ctx.reply('لطفاً نام مخاطب را وارد کنید:');
  } catch (error) {
    console.error('خطا در افزودن مخاطب:', error);
    ctx.reply('❌ خطایی رخ داده است.');
  }
});

// بازگشت به منوی اصلی
bot.action('back_to_main', async (ctx) => {
  try {
    await ctx.answerCbQuery();
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

    await ctx.reply(`📱 منوی اصلی\n🕒 زمان فعلی: ${now}`, createMainMenu());
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

bot.action('delete_contact', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('این قابلیت به زودی اضافه خواهد شد.');
});

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
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('🛑 دریافت SIGTERM - خاموش کردن ربات...');
  bot.stop('SIGTERM');
  process.exit(0);
});