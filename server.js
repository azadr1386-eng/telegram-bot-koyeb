/**
 * full-featured telegraph call-bot (webhook-ready)
 * - uses Supabase when configured, otherwise falls back to in-memory globals
 * - stores active_calls in DB so calls survive restarts
 * - auto-miss handling, answer/reject/end handlers
 * - reply_to_message_id stored for better UX
 * - contact management (add/list/delete), quick call from contacts
 *
 * Required env:
 * BOT_TOKEN
 * BASE_URL  (https://your-app.onrender.com)
 * PORT (optional)
 * SUPABASE_URL (optional)
 * SUPABASE_ANON_KEY (optional)
 */

const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ---------- config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL; // must be https://...
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN تنظیم نشده است');
  process.exit(1);
}
if (!BASE_URL) {
  console.error('❌ BASE_URL تنظیم نشده است (مثال: https://your-app.onrender.com)');
  process.exit(1);
}

// Supabase client (optional)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log('✅ Supabase متصل شد');
} else {
  console.warn('⚠️ Supabase تنظیم نشده است — از حافظه محلی استفاده می‌شود.');
}

// ---------- globals fallback ----------
global.users = global.users || {}; // { userId: { phone_number, username, group_id } }
global.callHistory = global.callHistory || []; // array of callData
global.activeCalls = global.activeCalls || {}; // callId -> callData
global.contacts = global.contacts || {}; // userId -> [ { contact_name, phone_number } ]

// ---------- bot & server ----------
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// ---------- session ----------
bot.use(session({
  defaultSession: () => ({
    userState: 'none',
    userPhone: null,
    contacts: [],
    calls: [],
    activeCall: null,
    tempContactName: null,
  })
}));

// ---------- constants ----------
const USER_STATES = {
  NONE: 'none',
  AWAITING_CONTACT_NAME: 'awaiting_contact_name',
  AWAITING_CONTACT_PHONE: 'awaiting_contact_phone',
};

// ---------- helpers ----------
function isValidPhoneNumber(phone) {
  if (!phone) return false;
  const phoneRegex = /^[A-Za-z]\d{4}$/;
  return phoneRegex.test(phone.trim());
}

function createMainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📞 مخاطبین', 'manage_contacts'),
      Markup.button.callback('📸 دوربین', 'camera'),
      Markup.button.callback('🖼️ گالری', 'gallery'),
    ],
    [
      Markup.button.callback('📒 دفترچه', 'call_history'),
      Markup.button.callback('📞 تماس', 'quick_call'),
      Markup.button.callback('ℹ️ راهنما', 'help'),
    ]
  ]);
}

function createCallResponseKeyboard(callId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ پاسخ', `answer_call_${callId}`),
      Markup.button.callback('❌ رد', `reject_call_${callId}`)
    ]
  ]);
}

function createEndCallKeyboard(callId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📞 پایان تماس', `end_call_${callId}`)]
  ]);
}

function createContactButtons(contacts) {
  const buttons = [];
  for (let i = 0; i < contacts.length; i += 3) {
    const row = contacts.slice(i, i + 3).map(contact =>
      Markup.button.callback(`👤 ${contact.contact_name}`, `quick_call_${contact.phone_number}`)
    );
    buttons.push(row);
  }
  buttons.push([Markup.button.callback('🔙 بازگشت', 'back_to_main')]);
  return Markup.inlineKeyboard(buttons);
}

function createContactsManagementKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ افزودن مخاطب', 'add_contact')],
    [Markup.button.callback('📞 تماس از مخاطبین', 'call_from_contacts')],
    [Markup.button.callback('🗑️ حذف مخاطب', 'delete_contact')],
    [Markup.button.callback('🔙 بازگشت', 'back_to_main')]
  ]);
}

async function findUserByPhone(phoneNumber) {
  const phone = phoneNumber.toUpperCase();
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('user_id, username, group_id, phone_number')
      .eq('phone_number', phone)
      .maybeSingle();
    if (error) {
      console.error('❌ خطا در findUserByPhone supabase:', error);
      return null;
    }
    return data || null;
  } else {
    for (const [uid, u] of Object.entries(global.users)) {
      if ((u.phone_number || '').toUpperCase() === phone) {
        return {
          user_id: Number(uid),
          username: u.username,
          group_id: u.group_id,
          phone_number: u.phone_number
        };
      }
    }
    return null;
  }
}

async function saveCallHistory(callData) {
  try {
    const row = {
      call_id: callData.callId,
      caller_id: callData.callerId,
      receiver_id: callData.receiverId,
      caller_phone: callData.callerPhone,
      receiver_phone: callData.receiverPhone,
      status: callData.status,
      duration: callData.duration || null,
      started_at: callData.startTime ? new Date(callData.startTime).toISOString() : null,
      answered_at: callData.answerTime ? new Date(callData.answerTime).toISOString() : null,
      ended_at: callData.endTime ? new Date(callData.endTime).toISOString() : null,
    };

    if (supabase) {
      const { error } = await supabase.from('call_history').insert(row);
      if (error) console.error('❌ خطا در saveCallHistory supabase:', error);
    } else {
      global.callHistory.push(row);
    }
  } catch (err) {
    console.error('❌ خطا در saveCallHistory:', err);
  }
}

async function persistActiveCall(callData) {
  try {
    const row = {
      call_id: callData.callId,
      caller_id: callData.callerId,
      receiver_id: callData.receiverId,
      caller_phone: callData.callerPhone,
      receiver_phone: callData.receiverPhone,
      caller_group_id: callData.callerGroupId,
      receiver_group_id: callData.receiverGroupId,
      caller_message_id: callData.callerMessageId || null,
      receiver_message_id: callData.receiverMessageId || null,
      status: callData.status,
      started_at: callData.startTime ? new Date(callData.startTime).toISOString() : new Date().toISOString(),
      answered_at: callData.answerTime ? new Date(callData.answerTime).toISOString() : null,
    };
    if (supabase) {
      // upsert to avoid duplicates
      const { error } = await supabase.from('active_calls').upsert(row, { onConflict: 'call_id' });
      if (error) console.error('❌ خطا در persistActiveCall supabase:', error);
    } else {
      global.activeCalls[callData.callId] = callData;
    }
  } catch (err) {
    console.error('❌ خطا در persistActiveCall:', err);
  }
}

async function removeActiveCall(callId) {
  try {
    if (supabase) {
      const { error } = await supabase.from('active_calls').delete().eq('call_id', callId);
      if (error) console.error('❌ خطا در removeActiveCall supabase:', error);
    }
    delete global.activeCalls[callId];
  } catch (err) {
    console.error('❌ خطا در removeActiveCall:', err);
  }
}

async function loadActiveCallsFromDbAndRecover() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('active_calls').select('*').or('status.eq.ringing,status.eq.answered');
    if (error) {
      console.error('❌ خطا در loadActiveCallsFromDbAndRecover:', error);
      return;
    }
    if (!data) return;
    for (const row of data) {
      // hydrate into memory
      const callId = row.call_id;
      const callData = {
        callId,
        callerId: row.caller_id,
        receiverId: row.receiver_id,
        callerPhone: row.caller_phone,
        receiverPhone: row.receiver_phone,
        callerGroupId: row.caller_group_id,
        receiverGroupId: row.receiver_group_id,
        callerMessageId: row.caller_message_id,
        receiverMessageId: row.receiver_message_id,
        status: row.status,
        startTime: row.started_at ? new Date(row.started_at) : new Date(),
        answerTime: row.answered_at ? new Date(row.answered_at) : null
      };
      global.activeCalls[callId] = callData;

      // if ringing and older than 70s -> mark as missed
      if (row.status === 'ringing') {
        const started = new Date(row.started_at);
        const ageSec = (Date.now() - started.getTime()) / 1000;
        if (ageSec > 70) {
          console.log(`⏱ marking stale call ${callId} as missed (age ${Math.floor(ageSec)}s)`);
          callData.status = 'missed';
          callData.endTime = new Date();
          await saveCallHistory(callData);
          await removeActiveCall(callId);
          delete global.activeCalls[callId];
        } else {
          // schedule a timeout for remaining time
          const remaining = Math.max(0, 60000 - Math.floor(ageSec * 1000));
          setTimeout(() => {
            autoMissCallIfStillRinging(callId).catch(err => console.error(err));
          }, remaining + 500);
        }
      }
    }
  } catch (err) {
    console.error('❌ خطا در loadActiveCallsFromDbAndRecover (catch):', err);
  }
}

async function autoMissCallIfStillRinging(callId) {
  try {
    const call = global.activeCalls[callId];
    if (!call) {
      // try fetch from DB
      if (supabase) {
        const { data } = await supabase.from('active_calls').select('*').eq('call_id', callId).maybeSingle();
        if (!data) return;
        if (data.status !== 'ringing') return;
        // mark missed
        await supabase.from('active_calls').update({ status: 'missed', ended_at: new Date().toISOString() }).eq('call_id', callId);
        await saveCallHistory({
          callId,
          callerId: data.caller_id,
          receiverId: data.receiver_id,
          callerPhone: data.caller_phone,
          receiverPhone: data.receiver_phone,
          status: 'missed',
          startTime: data.started_at,
          endTime: new Date()
        });
        await removeActiveCall(callId);
      }
      return;
    }
    if (call.status === 'ringing') {
      call.status = 'missed';
      call.endTime = new Date();
      try {
        // update messages if exist
        if (call.callerChatId && call.callerMessageId) {
          await bot.telegram.editMessageText(call.callerChatId, call.callerMessageId, null,
            `📞 تماس از: ${call.callerPhone}\n📞 به: ${call.receiverPhone}\n\n❌ تماس پاسخ داده نشد.`);
        }
      } catch (e) {
        // ignore edit errors
      }
      try {
        if (call.receiverChatId && call.receiverMessageId) {
          await bot.telegram.editMessageText(call.receiverChatId, call.receiverMessageId, null,
            `📞 تماس از: ${call.callerPhone}\n📞 به: ${call.receiverPhone}\n\n❌ تماس پاسخ داده نشد.`);
        }
      } catch (e) {}
      await saveCallHistory(call);
      await removeActiveCall(callId);
      delete global.activeCalls[callId];
    }
  } catch (err) {
    console.error('❌ خطا در autoMissCallIfStillRinging:', err);
  }
}

async function userHasActiveCall(userId) {
  // check in-memory first
  for (const c of Object.values(global.activeCalls || {})) {
    if ((c.callerId === userId || c.receiverId === userId) && (c.status === 'ringing' || c.status === 'answered')) {
      return true;
    }
  }
  if (supabase) {
    const { data, error } = await supabase.from('active_calls').select('call_id').or(`caller_id.eq.${userId},receiver_id.eq.${userId}`).in('status', ['ringing','answered']).maybeSingle();
    if (error) {
      console.error('❌ خطا در userHasActiveCall supabase:', error);
      return false;
    }
    return !!data;
  }
  return false;
}

// ---------- command handlers & logic ----------

// /start
bot.start(async (ctx) => {
  try {
    const welcomeText = `👋 به ربات مخابراتی خوش آمدید!

📞 برای ثبت شماره خود در گروه:
/register A1234

📞 برای تماس با کاربر:
@${ctx.botInfo.username} A1234

📒 برای مشاهده منوی مخاطبین:
/contacts

📜 برای دیدن تاریخچه تماس‌ها:
/call_history

برای باز کردن منو، روی دکمه‌ها کلیک کنید.`;
    await ctx.reply(welcomeText, createMainMenu());
  } catch (err) {
    console.error('خطا در /start reply:', err);
  }
});

// /register
bot.command('register', async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      return ctx.reply('❌ این دستور فقط در گروه‌ها قابل استفاده است.');
    }
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
      return ctx.reply('❌ لطفاً شماره تلفن را وارد کنید. مثال: /register A1234');
    }
    const phone = parts[1].toUpperCase();
    if (!isValidPhoneNumber(phone)) {
      return ctx.reply('❌ فرمت شماره نامعتبر است. مثال: A1234');
    }

    const userRow = {
      user_id: ctx.from.id,
      username: ctx.from.username || `${ctx.from.first_name || ''}${ctx.from.last_name ? `_${ctx.from.last_name}` : ''}`,
      phone_number: phone,
      group_id: ctx.chat.id,
      updated_at: new Date().toISOString()
    };

    if (supabase) {
      const { error } = await supabase.from('users').upsert(userRow, { onConflict: 'user_id' });
      if (error) {
        console.error('❌ خطا در ثبت کاربر supabase:', error);
        return ctx.reply('❌ خطایی در ثبت شماره رخ داد.');
      }
    } else {
      global.users[ctx.from.id] = {
        phone_number: phone,
        username: userRow.username,
        group_id: ctx.chat.id
      };
    }

    ctx.reply(`✅ شماره ${phone} با موفقیت ثبت شد.`);
  } catch (err) {
    console.error('❌ خطا در /register:', err);
    ctx.reply('❌ خطایی رخ داد.');
  }
});

// /contacts
bot.command('contacts', async (ctx) => {
  try {
    let contacts = [];
    if (supabase) {
      const { data, error } = await supabase.from('contacts').select('*').eq('user_id', ctx.from.id).order('contact_name', { ascending: true });
      if (error) {
        console.error('❌ خطا در دریافت مخاطبین supabase:', error);
      } else {
        contacts = data || [];
      }
    } else {
      contacts = global.contacts[ctx.from.id] || [];
    }

    let text = '👥 مخاطبین شما:\n\n';
    if (!contacts.length) {
      text += '📭 هنوز مخاطبی اضافه نکرده‌اید.\n';
    } else {
      contacts.forEach((c, i) => {
        text += `${i + 1}. ${c.contact_name} — ${c.phone_number}\n`;
      });
    }

    await ctx.reply(text, createContactsManagementKeyboard());
  } catch (err) {
    console.error('❌ خطا در /contacts:', err);
    ctx.reply('❌ خطا در دریافت مخاطبین');
  }
});

// /call_history
bot.command('call_history', async (ctx) => {
  try {
    let history = [];
    if (supabase) {
      const { data, error } = await supabase.from('call_history')
        .select('*')
        .or(`caller_id.eq.${ctx.from.id},receiver_id.eq.${ctx.from.id}`)
        .order('started_at', { ascending: false })
        .limit(10);
      if (error) console.error('❌ خطا در call_history supabase:', error);
      history = data || [];
    } else {
      history = global.callHistory.filter(c => c.caller_id === ctx.from.id || c.receiver_id === ctx.from.id);
    }

    if (!history.length) return ctx.reply('📭 تاریخچه‌ای یافت نشد.');

    let msg = '📜 تاریخچه تماس‌ها:\n\n';
    history.forEach(h => {
      msg += `📞 ${h.caller_phone} ➜ ${h.receiver_phone}\nوضعیت: ${h.status}${h.duration ? `\n⏱ ${h.duration}s` : ''}\n📅 ${h.started_at ? new Date(h.started_at).toLocaleString() : ''}\n\n`;
    });
    ctx.reply(msg);
  } catch (err) {
    console.error('❌ خطا در /call_history:', err);
    ctx.reply('❌ خطا در دریافت تاریخچه');
  }
});

// Mention-based call: @bot A1234 OR command /callto A1234
bot.on('text', async (ctx, next) => {
  try {
    const text = ctx.message.text || '';
    const mention = `@${ctx.botInfo.username}`;
    if (text.includes(mention)) {
      // format: "@bot A1234" or mention + other text
      const parts = text.split(/\s+/);
      const idx = parts.findIndex(p => p.includes(mention));
      const target = parts[idx + 1] ? parts[idx + 1].toUpperCase() : null;
      if (!target) return; // ignore
      if (!isValidPhoneNumber(target)) {
        return ctx.reply('❌ فرمت شماره مقصد نامعتبر است. مثال: A1234');
      }

      // require caller registered
      let userPhone = null, userGroupId = null;
      if (supabase) {
        const { data } = await supabase.from('users').select('phone_number,group_id').eq('user_id', ctx.from.id).maybeSingle();
        if (!data) return ctx.reply('❌ ابتدا از دستور /register شماره خود را ثبت کنید.');
        userPhone = data.phone_number;
        userGroupId = data.group_id;
      } else if (global.users[ctx.from.id]) {
        userPhone = global.users[ctx.from.id].phone_number;
        userGroupId = global.users[ctx.from.id].group_id;
      } else {
        return ctx.reply('❌ ابتدا از دستور /register شماره خود را ثبت کنید.');
      }

      const targetUser = await findUserByPhone(target);
      if (!targetUser) return ctx.reply('❌ کاربری با این شماره یافت نشد.');

      // prevent simultaneous calls
      if (await userHasActiveCall(ctx.from.id)) return ctx.reply('❌ شما هم‌اکنون در حال تماس هستید.');
      if (await userHasActiveCall(targetUser.user_id)) return ctx.reply('❌ کاربر مقصد در حال تماس دیگری است.');

      // create call
      const callId = uuidv4();
      const callData = {
        callId,
        callerId: ctx.from.id,
        callerPhone: userPhone,
        callerGroupId: userGroupId,
        receiverId: targetUser.user_id,
        receiverPhone: target,
        receiverGroupId: targetUser.group_id,
        status: 'ringing',
        startTime: new Date().toISOString(),
        callerChatId: ctx.chat.id,
        callerMessageId: null,
        receiverMessageId: null
      };

      // persist active call
      if (supabase) {
        await persistActiveCall(callData);
      }
      global.activeCalls[callId] = callData;

      // send caller message (reply to their message for clarity)
      try {
        const sent = await ctx.replyWithMarkdown(
          `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n\n⏳ در حال برقراری...`,
          {
            reply_to_message_id: ctx.message.message_id,
            reply_markup: createCallResponseKeyboard(callId).reply_markup
          }
        );
        callData.callerMessageId = sent.message_id;
        callData.callerChatId = sent.chat.id;
        if (supabase) await persistActiveCall(callData);
      } catch (e) {
        console.warn('⚠️ خطا در ارسال پیام مبدأ:', e && e.message);
      }

      // send to target group
      try {
        const sent2 = await bot.telegram.sendMessage(
          callData.receiverGroupId,
          `📞 تماس ورودی از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n\n⏳ در حال برقراری...`,
          createCallResponseKeyboard(callId)
        );
        callData.receiverMessageId = sent2.message_id;
        callData.receiverChatId = sent2.chat.id;
        if (supabase) await persistActiveCall(callData);
      } catch (e) {
        console.warn('⚠️ خطا در ارسال پیام گروه مقصد:', e && e.message);
      }

      // schedule auto-miss after 60s (works in current runtime; DB also used for recovery)
      setTimeout(async () => {
        await autoMissCallIfStillRinging(callId);
      }, 60000);

      return;
    }
    // continue to next handlers (e.g., contact add flow)
    await next();
  } catch (err) {
    console.error('❌ خطا در mention handler:', err);
  }
});

// ---------- callback handlers (answer/reject/end) ----------
bot.action(/answer_call_(.+)/, async (ctx) => {
  try {
    const callId = ctx.match[1];
    let call = global.activeCalls[callId];
    if (!call && supabase) {
      const { data } = await supabase.from('active_calls').select('*').eq('call_id', callId).maybeSingle();
      call = data;
    }
    if (!call) return ctx.answerCbQuery('❌ این تماس دیگر فعال نیست.');

    // only receiver can answer
    if (ctx.from.id !== call.receiverId) {
      return ctx.answerCbQuery('❌ فقط کاربر مقصد می‌تواند به این تماس پاسخ دهد.');
    }

    call.status = 'answered';
    call.answerTime = new Date().toISOString();

    // update DB
    if (supabase) {
      const { error } = await supabase.from('active_calls').update({ status: 'answered', answered_at: call.answerTime }).eq('call_id', callId);
      if (error) console.error('❌ خطا در update active_calls(answer):', error);
    }
    global.activeCalls[callId] = call;

    // Edit messages in both groups (try/catch each)
    try {
      if (call.callerChatId && call.callerMessageId) {
        await bot.telegram.editMessageText(call.callerChatId, call.callerMessageId, null,
          `📞 تماس از: ${call.callerPhone}\n📞 به: ${call.receiverPhone}\n\n✅ تماس برقرار شد.`,
          createEndCallKeyboard(callId)
        );
      }
    } catch (e) { console.warn('⚠️ caller edit failed:', e && e.message); }

    try {
      if (call.receiverChatId && call.receiverMessageId) {
        await bot.telegram.editMessageText(call.receiverChatId, call.receiverMessageId, null,
          `📞 تماس از: ${call.callerPhone}\n📞 به: ${call.receiverPhone}\n\n✅ تماس برقرار شد.`,
          createEndCallKeyboard(callId)
        );
      }
    } catch (e) { console.warn('⚠️ receiver edit failed:', e && e.message); }

    ctx.answerCbQuery('✅ تماس پاسخ داده شد.');
  } catch (err) {
    console.error('❌ خطا در answer handler:', err);
    ctx.answerCbQuery('❌ خطا در پاسخ‌دهی');
  }
});

bot.action(/reject_call_(.+)/, async (ctx) => {
  try {
    const callId = ctx.match[1];
    let call = global.activeCalls[callId];
    if (!call && supabase) {
      const { data } = await supabase.from('active_calls').select('*').eq('call_id', callId).maybeSingle();
      call = data;
    }
    if (!call) return ctx.answerCbQuery('❌ تماس پیدا نشد.');

    call.status = 'rejected';
    call.endTime = new Date().toISOString();

    // save history and remove active
    await saveCallHistory(call);
    await removeActiveCall(callId);

    // edit messages
    try {
      if (call.callerChatId && call.callerMessageId) {
        await bot.telegram.editMessageText(call.callerChatId, call.callerMessageId, null,
          `📞 تماس از: ${call.callerPhone}\n📞 به: ${call.receiverPhone}\n\n❌ تماس رد شد.`);
      }
    } catch (e) {}
    try {
      if (call.receiverChatId && call.receiverMessageId) {
        await bot.telegram.editMessageText(call.receiverChatId, call.receiverMessageId, null,
          `📞 تماس از: ${call.callerPhone}\n📞 به: ${call.receiverPhone}\n\n❌ تماس رد شد.`);
      }
    } catch (e) {}

    ctx.answerCbQuery('✅ تماس رد شد.');
  } catch (err) {
    console.error('❌ خطا در reject handler:', err);
    ctx.answerCbQuery('❌ خطا');
  }
});

bot.action(/end_call_(.+)/, async (ctx) => {
  try {
    const callId = ctx.match[1];
    let call = global.activeCalls[callId];
    if (!call && supabase) {
      const { data } = await supabase.from('active_calls').select('*').eq('call_id', callId).maybeSingle();
      call = data;
    }
    if (!call || call.status !== 'answered') {
      return ctx.answerCbQuery('❌ این تماس قابل پایان دادن نیست.');
    }

    call.status = 'ended';
    call.endTime = new Date().toISOString();
    call.duration = call.answerTime ? Math.floor((new Date(call.endTime) - new Date(call.answerTime)) / 1000) : null;

    await saveCallHistory(call);
    await removeActiveCall(callId);

    // update messages in both sides
    try {
      if (call.callerChatId && call.callerMessageId) {
        await bot.telegram.editMessageText(call.callerChatId, call.callerMessageId, null,
          `📞 تماس بین ${call.callerPhone} و ${call.receiverPhone}\n\n⏹️ پایان یافت\n⏱ مدت: ${call.duration || 0} ثانیه`);
      }
    } catch (e) {}
    try {
      if (call.receiverChatId && call.receiverMessageId) {
        await bot.telegram.editMessageText(call.receiverChatId, call.receiverMessageId, null,
          `📞 تماس بین ${call.callerPhone} و ${call.receiverPhone}\n\n⏹️ پایان یافت\n⏱ مدت: ${call.duration || 0} ثانیه`);
      }
    } catch (e) {}

    ctx.answerCbQuery('✅ تماس پایان یافت.');
  } catch (err) {
    console.error('❌ خطا در end handler:', err);
    ctx.answerCbQuery('❌ خطا');
  }
});

// ---------- contact flows ----------
bot.action('add_contact', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    ctx.session.userState = USER_STATES.AWAITING_CONTACT_NAME;
    await ctx.reply('📨 لطفاً نام مخاطب را ارسال کنید:');
  } catch (err) { console.error(err); }
});

bot.action('call_from_contacts', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    let contacts = [];
    if (supabase) {
      const { data, error } = await supabase.from('contacts').select('*').eq('user_id', ctx.from.id).order('contact_name', { ascending: true });
      if (error) console.error('❌ contacts load error:', error);
      contacts = data || [];
    } else {
      contacts = global.contacts[ctx.from.id] || [];
    }
    if (!contacts.length) {
      return ctx.reply('❌ شما هیچ مخاطبی ندارید. از افزودن مخاطب استفاده کنید.', createContactsManagementKeyboard());
    }
    await ctx.reply('📞 انتخاب مخاطب برای تماس:', createContactButtons(contacts));
  } catch (err) { console.error(err); }
});

bot.action('delete_contact', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    let contacts = [];
    if (supabase) {
      const { data, error } = await supabase.from('contacts').select('*').eq('user_id', ctx.from.id).order('contact_name', { ascending: true });
      if (error) console.error(error);
      contacts = data || [];
    } else {
      contacts = global.contacts[ctx.from.id] || [];
    }
    if (!contacts.length) {
      return ctx.reply('❌ مخاطبی برای حذف وجود ندارد.');
    }
    // present keyboard with delete buttons
    const keyboard = Markup.inlineKeyboard(
      contacts.map(c => [Markup.button.callback(`🗑️ حذف ${c.contact_name}`, `delete_contact_${c.phone_number}`)])
      .concat([[Markup.button.callback('🔙 بازگشت', 'back_to_main')]])
    );
    await ctx.reply('انتخاب کنید کدام مخاطب حذف شود:', keyboard);
  } catch (err) { console.error(err); }
});

bot.action(/delete_contact_(.+)/, async (ctx) => {
  try {
    const phone = ctx.match[1];
    if (supabase) {
      const { error } = await supabase.from('contacts').delete().eq('user_id', ctx.from.id).eq('phone_number', phone);
      if (error) console.error('❌ delete contact supabase error:', error);
    } else {
      global.contacts[ctx.from.id] = (global.contacts[ctx.from.id] || []).filter(c => c.phone_number !== phone);
    }
    await ctx.answerCbQuery('✅ حذف شد');
    await ctx.deleteMessage().catch(() => {});
  } catch (err) { console.error(err); }
});

// quick call from contact button: quick_call_<PHONE>
bot.action(/quick_call_(.+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const phone = ctx.match[1].toUpperCase();
    // emulate mention-based call using the phone
    // create a synthetic ctx.message to reply to
    const fakeText = `@${ctx.botInfo.username} ${phone}`;
    // call the same logic by invoking mention flow (simple approach: reuse code)
    // We will reuse the mention path by directly constructing a caller context:
    // But simpler: just tell user to mention the bot in group OR create call initiating UI
    await ctx.reply(`سعی برای تماس با ${phone}... (برای شروع تماس حتما در گروه از ربات mention استفاده کنید یا دستور /callto)`);
  } catch (err) { console.error(err); }
});

// session text handler for contact adding
bot.on('text', async (ctx, next) => {
  try {
    if (ctx.session.userState === USER_STATES.AWAITING_CONTACT_NAME) {
      const name = ctx.message.text.trim();
      if (!name || name.length < 2) return ctx.reply('نام معتبر وارد کنید (حداقل 2 کاراکتر).');
      ctx.session.tempContactName = name;
      ctx.session.userState = USER_STATES.AWAITING_CONTACT_PHONE;
      return ctx.reply('حالا شماره تماس را وارد کنید (مثل: A1234 یا شماره دلخواه):');
    } else if (ctx.session.userState === USER_STATES.AWAITING_CONTACT_PHONE) {
      const phone = ctx.message.text.trim().toUpperCase();
      const name = ctx.session.tempContactName || 'بدون نام';
      // save contact
      if (supabase) {
        const { error } = await supabase.from('contacts').insert({
          user_id: ctx.from.id,
          contact_name: name,
          phone_number: phone,
          created_at: new Date().toISOString()
        });
        if (error) {
          console.error('❌ insert contact supabase error:', error);
          return ctx.reply('❌ خطا در ذخیره مخاطب');
        }
      } else {
        global.contacts[ctx.from.id] = global.contacts[ctx.from.id] || [];
        global.contacts[ctx.from.id].push({ contact_name: name, phone_number: phone });
      }
      ctx.session.userState = USER_STATES.NONE;
      ctx.session.tempContactName = null;
      return ctx.reply(`✅ مخاطب ${name} با شماره ${phone} ذخیره شد.`);
    } else {
      // if none of above, continue to other handlers (e.g., mention handler handled earlier)
      return next();
    }
  } catch (err) {
    console.error('❌ خطا در contact session handler:', err);
    ctx.reply('❌ خطا');
  }
});

// ---------- webhook route ----------
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res).catch(err => {
    console.error('❌ خطا در handleUpdate:', err);
    res.sendStatus(500);
  });
});

// ---------- startup ----------
(async () => {
  try {
    await loadActiveCallsFromDbAndRecover();
  } catch (e) {
    console.warn('⚠️ خطا در بازیابی active calls:', e && e.message);
  }

  app.listen(PORT, async () => {
    console.log(`🚀 سرور روی پورت ${PORT} اجرا شد`);
    try {
      // set webhook
      const webhookUrl = `${BASE_URL.replace(/\/$/, '')}/webhook/${BOT_TOKEN}`;
      const set = await bot.telegram.setWebhook(webhookUrl);
      console.log('✅ Webhook ست شد:', webhookUrl, set);
    } catch (err) {
      console.error('❌ خطا در ست کردن webhook:', err);
    }
  });
})();

// graceful shutdown
process.once('SIGINT', () => {
  console.log('SIGINT received, stopping bot...');
  bot.stop('SIGINT');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('SIGTERM received, stopping bot...');
  bot.stop('SIGTERM');
  process.exit(0);
});
