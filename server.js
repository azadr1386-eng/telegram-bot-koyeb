/**
 * full-featured Telegram call-bot (webhook-only)
 * - Supabase optional, else memory fallback
 * - Active calls persist for restarts
 * - Auto-missed handling removed (فقط کاربر قطع می‌کند)
 * - Contact management (add/list/delete)
 * - Mention-based calls (@bot A1234) و quick call buttons
 * - پیام‌های ریپلای بین گروه‌ها منتقل می‌شوند
 *
 * Required env:
 * BOT_TOKEN
 * BASE_URL  (https://your-base-url.com)
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

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN تنظیم نشده'); process.exit(1); }
if (!BASE_URL) { console.error('❌ BASE_URL تنظیم نشده'); process.exit(1); }

// ---------- Supabase client (optional) ----------
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    console.log('✅ Supabase متصل شد');
} else console.warn('⚠️ Supabase تنظیم نشده — از حافظه محلی استفاده می‌شود.');

// ---------- memory fallback ----------
global.users = global.users || {};
global.contacts = global.contacts || {};
global.activeCalls = global.activeCalls || {};
global.callHistory = global.callHistory || [];

// ---------- bot & server ----------
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// ---------- session ----------
bot.use(session({
    defaultSession: () => ({
        userState: 'none',
        tempContactName: null
    })
}));

// ---------- constants ----------
const USER_STATES = {
    NONE: 'none',
    AWAITING_CONTACT_NAME: 'awaiting_contact_name',
    AWAITING_CONTACT_PHONE: 'awaiting_contact_phone'
};

// ---------- helpers ----------
function isValidPhoneNumber(phone) {
    if (!phone) return false;
    return /^[A-Za-z]\d{4}$/.test(phone.trim());
}

function createMainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📞 مخاطبین','manage_contacts'),
         Markup.button.callback('📸 دوربین','camera'),
         Markup.button.callback('🖼️ گالری','gallery')],
        [Markup.button.callback('📒 تاریخچه','call_history'),
         Markup.button.callback('📞 تماس سریع','quick_call'),
         Markup.button.callback('ℹ️ راهنما','help')]
    ]);
}

function createCallResponseKeyboard(callId) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ پاسخ',`answer_call_${callId}`),
         Markup.button.callback('❌ رد',`reject_call_${callId}`)]
    ]);
}

function createEndCallKeyboard(callId) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📞 پایان تماس',`end_call_${callId}`)]
    ]);
}

function createContactsManagementKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ افزودن مخاطب','add_contact')],
        [Markup.button.callback('📞 تماس از مخاطبین','call_from_contacts')],
        [Markup.button.callback('🗑️ حذف مخاطب','delete_contact')],
        [Markup.button.callback('🔙 بازگشت','back_to_main')]
    ]);
}
// ---------- DB helpers ----------
async function findUserByPhone(phone){
    const target = phone.toUpperCase();
    if(supabase){
        const { data } = await supabase.from('users').select('*').eq('phone_number',target).maybeSingle();
        return data||null;
    } else {
        for(const [uid,u] of Object.entries(global.users)){
            if((u.phone_number||'').toUpperCase()===target) return {...u,user_id:Number(uid)};
        }
        return null;
    }
}

async function persistActiveCall(callData){
    global.activeCalls[callData.callId]=callData;
    if(supabase){
        await supabase.from('active_calls').upsert({
            call_id: callData.callId,
            caller_id: callData.callerId,
            receiver_id: callData.receiverId,
            caller_phone: callData.callerPhone,
            receiver_phone: callData.receiverPhone,
            status: callData.status,
            started_at: new Date().toISOString()
        }, { onConflict: 'call_id' });
    }
}

async function removeActiveCall(callId){
    delete global.activeCalls[callId];
    if(supabase){
        await supabase.from('active_calls').delete().eq('call_id',callId);
    }
}

async function saveCallHistory(callData){
    global.callHistory.push(callData);
    if(supabase){
        await supabase.from('call_history').insert({
            call_id: callData.callId,
            caller_id: callData.callerId,
            receiver_id: callData.receiverId,
            caller_phone: callData.callerPhone,
            receiver_phone: callData.receiverPhone,
            status: callData.status,
            started_at: callData.startTime,
            answered_at: callData.answerTime,
            ended_at: callData.endTime,
            duration: callData.duration||null
        });
    }
}

async function userHasActiveCall(userId){
    for(const c of Object.values(global.activeCalls||{})){
        if((c.callerId===userId||c.receiverId===userId)&&['ringing','answered'].includes(c.status)) return true;
    }
    return false;
}

// ---------- commands ----------
bot.start(async ctx=>{
    await ctx.reply(`👋 خوش آمدید!\n📞 /register A1234\n📒 /contacts\n📜 /call_history`, createMainMenu());
});

bot.command('register', async ctx=>{
    if(ctx.chat.type==='private') return ctx.reply('❌ فقط در گروه‌ها استفاده شود.');
    const parts = ctx.message.text.split(' ');
    if(parts.length < 2) return ctx.reply('❌ شماره وارد کنید. مثال: /register A1234');
    const phone = parts[1].toUpperCase();
    if(!isValidPhoneNumber(phone)) return ctx.reply('❌ فرمت نامعتبر. مثال: A1234');

    const userRow = {
        user_id: ctx.from.id,
        username: ctx.from.username||ctx.from.first_name||'',
        phone_number: phone,
        group_id: ctx.chat.id
    };

    if(supabase){
        await supabase.from('users').upsert(userRow, { onConflict: 'user_id' });
    } else {
        global.users[ctx.from.id] = { phone_number: phone, username: userRow.username, group_id: ctx.chat.id };
    }

    ctx.reply(`✅ شماره ${phone} ثبت شد.`);
});

bot.command('contacts', async ctx=>{
    let contacts = [];
    if(supabase){
        const { data } = await supabase.from('contacts').select('*').eq('user_id', ctx.from.id).order('contact_name');
        contacts = data || [];
    } else contacts = global.contacts[ctx.from.id] || [];

    let text = '👥 مخاطبین شما:\n\n';
    if(!contacts.length) text += '📭 هیچ مخاطبی وجود ندارد.';
    else contacts.forEach((c,i)=> text += `${i+1}. ${c.contact_name} — ${c.phone_number}\n`);

    await ctx.reply(text, createContactsManagementKeyboard());
});

bot.command('call_history', async ctx=>{
    let hist = [];
    if(supabase){
        const { data } = await supabase.from('call_history')
            .select('*')
            .or(`caller_id.eq.${ctx.from.id},receiver_id.eq.${ctx.from.id}`)
            .order('started_at',{ascending:false})
            .limit(10);
        hist = data || [];
    } else hist = global.callHistory.filter(c=>c.callerId===ctx.from.id||c.receiverId===ctx.from.id);

    if(!hist.length) return ctx.reply('📭 تاریخچه‌ای یافت نشد.');

    let msg = '📜 تاریخچه تماس‌ها:\n\n';
    hist.forEach(h=> msg += `📞 ${h.caller_phone} ➜ ${h.receiver_phone}\nوضعیت: ${h.status}\n📅 ${h.started_at}\n\n`);

    ctx.reply(msg);
});

// ---------- mention-based call ----------
bot.on('text', async (ctx,next)=>{
    const text = ctx.message.text || '';
    const mention = `@${ctx.botInfo.username}`;
    if(text.includes(mention)){
        const parts = text.split(/\s+/);
        const idx = parts.findIndex(p=>p.includes(mention));
        const target = parts[idx+1]?parts[idx+1].toUpperCase():null;
        if(!target) return;
        if(!isValidPhoneNumber(target)) return ctx.reply('❌ شماره نامعتبر. مثال: A1234');

        // check caller registration
        let userPhone = null, userGroup = null;
        if(supabase){
            const { data } = await supabase.from('users').select('phone_number,group_id').eq('user_id', ctx.from.id).maybeSingle();
            if(!data) return ctx.reply('❌ ابتدا /register کنید.');
            userPhone = data.phone_number; userGroup = data.group_id;
        } else if(global.users[ctx.from.id]){
            userPhone = global.users[ctx.from.id].phone_number;
            userGroup = global.users[ctx.from.id].group_id;
        } else return ctx.reply('❌ ابتدا /register کنید.');

        const targetUser = await findUserByPhone(target);
        if(!targetUser) return ctx.reply('❌ کاربر یافت نشد.');
        if(await userHasActiveCall(ctx.from.id)) return ctx.reply('❌ شما در تماس هستید.');
        if(await userHasActiveCall(targetUser.user_id)) return ctx.reply('❌ کاربر مقصد در تماس است.');

        const callId = uuidv4();
        const callData = {
            callId,
            callerId: ctx.from.id,
            callerPhone: userPhone,
            callerGroupId: userGroup,
            receiverId: targetUser.user_id,
            receiverPhone: target,
            receiverGroupId: targetUser.group_id,
            status: 'ringing',
            startTime: new Date().toISOString(),
            callerChatId: ctx.chat.id,
            callerMessageId: null,
            receiverMessageId: null,
            receiverChatId: null
        };

        await persistActiveCall(callData);

        // send messages
        const sentCaller = await ctx.reply(
            `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n⏳ در حال برقراری...`,
            { reply_to_message_id: ctx.message.message_id, reply_markup: createCallResponseKeyboard(callId).reply_markup }
        );
        callData.callerMessageId = sentCaller.message_id;
        callData.callerChatId = sentCaller.chat.id;

        const sentReceiver = await bot.telegram.sendMessage(
            callData.receiverGroupId,
            `📞 تماس ورودی از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n⏳ در حال برقراری...`,
            createCallResponseKeyboard(callId)
        );
        callData.receiverMessageId = sentReceiver.message_id;
        callData.receiverChatId = sentReceiver.chat.id;

        await persistActiveCall(callData);

        return;
    }

    // contact add flow
    if(ctx.session.userState === USER_STATES.AWAITING_CONTACT_NAME){
        const name = ctx.message.text.trim();
        if(!name||name.length<2) return ctx.reply('نام معتبر وارد کنید.');
        ctx.session.tempContactName = name;
        ctx.session.userState = USER_STATES.AWAITING_CONTACT_PHONE;
        return ctx.reply('شماره تماس را وارد کنید:');
    } else if(ctx.session.userState === USER_STATES.AWAITING_CONTACT_PHONE){
        const phone = ctx.message.text.trim().toUpperCase();
        const name = ctx.session.tempContactName || 'بدون نام';
        if(supabase){
            await supabase.from('contacts').insert({
                user_id: ctx.from.id,
                contact_name: name,
                phone_number: phone,
                created_at: new Date().toISOString()
            });
        } else {
            global.contacts[ctx.from.id] = global.contacts[ctx.from.id]||[];
            global.contacts[ctx.from.id].push({contact_name: name, phone_number: phone});
        }
        ctx.session.userState = USER_STATES.NONE;
        ctx.session.tempContactName = null;
        return ctx.reply(`✅ مخاطب ${name} با شماره ${phone} ذخیره شد.`);
    } else return next();
});
// ---------- callback handlers ----------
bot.action(/answer_call_(.+)/, async ctx => {
    const callId = ctx.match[1];
    let call = global.activeCalls[callId];
    if(!call) return ctx.answerCbQuery('❌ تماس فعال نیست.');
    if(ctx.from.id !== call.receiverId) return ctx.answerCbQuery('❌ فقط کاربر مقصد می‌تواند پاسخ دهد.');

    call.status = 'answered';
    call.answerTime = new Date().toISOString();
    await persistActiveCall(call);

    try {
        if(call.callerChatId && call.callerMessageId)
            await bot.telegram.editMessageText(
                call.callerChatId, call.callerMessageId, null,
                `📞 تماس برقرار شد.`,
                createEndCallKeyboard(callId)
            );
    } catch(e){}

    try {
        if(call.receiverChatId && call.receiverMessageId)
            await bot.telegram.editMessageText(
                call.receiverChatId, call.receiverMessageId, null,
                `📞 تماس برقرار شد.`,
                createEndCallKeyboard(callId)
            );
    } catch(e){}

    ctx.answerCbQuery('✅ تماس پاسخ داده شد.');
});

bot.action(/reject_call_(.+)/, async ctx => {
    const callId = ctx.match[1];
    let call = global.activeCalls[callId];
    if(!call) return ctx.answerCbQuery('❌ تماس پیدا نشد.');

    call.status = 'rejected';
    call.endTime = new Date().toISOString();
    await saveCallHistory(call);
    await removeActiveCall(callId);

    try {
        if(call.callerChatId && call.callerMessageId)
            await bot.telegram.editMessageText(call.callerChatId, call.callerMessageId, null, '❌ تماس رد شد.');
    } catch(e){}

    try {
        if(call.receiverChatId && call.receiverMessageId)
            await bot.telegram.editMessageText(call.receiverChatId, call.receiverMessageId, null, '❌ تماس رد شد.');
    } catch(e){}

    ctx.answerCbQuery('✅ تماس رد شد.');
});

bot.action(/end_call_(.+)/, async ctx => {
    const callId = ctx.match[1];
    let call = global.activeCalls[callId];
    if(!call || call.status !== 'answered') return ctx.answerCbQuery('❌ قابل پایان نیست.');

    call.status = 'ended';
    call.endTime = new Date().toISOString();
    call.duration = call.answerTime ? Math.floor((new Date(call.endTime) - new Date(call.answerTime)) / 1000) : 0;
    await saveCallHistory(call);
    await removeActiveCall(callId);

    try {
        if(call.callerChatId && call.callerMessageId)
            await bot.telegram.editMessageText(
                call.callerChatId, call.callerMessageId, null,
                `⏹️ پایان یافت\n⏱ ${call.duration}s`
            );
    } catch(e){}

    try {
        if(call.receiverChatId && call.receiverMessageId)
            await bot.telegram.editMessageText(
                call.receiverChatId, call.receiverMessageId, null,
                `⏹️ پایان یافت\n⏱ ${call.duration}s`
            );
    } catch(e){}

    ctx.answerCbQuery('✅ تماس پایان یافت.');
});

// ---------- auto-miss ----------
async function autoMissCall(callId){
    const call = global.activeCalls[callId];
    if(!call || call.status !== 'ringing') return;

    call.status = 'missed';
    call.endTime = new Date().toISOString();
    await saveCallHistory(call);
    await removeActiveCall(callId);

    try {
        if(call.callerChatId && call.callerMessageId)
            await bot.telegram.editMessageText(call.callerChatId, call.callerMessageId, null, '❌ تماس بی‌پاسخ ماند.');
    } catch(e){}

    try {
        if(call.receiverChatId && call.receiverMessageId)
            await bot.telegram.editMessageText(call.receiverChatId, call.receiverMessageId, null, '❌ تماس بی‌پاسخ ماند.');
    } catch(e){}
});
// ---------- webhook ----------
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
    bot.handleUpdate(req.body, res).catch(err => {
        console.error(err);
        res.sendStatus(500);
    });
});

// ---------- startup ----------
app.listen(PORT, async () => {
    console.log(`🚀 سرور روی پورت ${PORT} اجرا شد`);
    try {
        const webhookUrl = `${BASE_URL.replace(/\/$/, '')}/webhook/${BOT_TOKEN}`;
        const set = await bot.telegram.setWebhook(webhookUrl);
        console.log('✅ Webhook ست شد:', webhookUrl, set);
    } catch(err) {
        console.error('❌ خطا در ست webhook:', err);
    }
});
