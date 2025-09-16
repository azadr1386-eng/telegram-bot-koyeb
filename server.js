/**
 * full-featured Telegram call-bot (webhook-only)
 * قابلیت‌ها:
 * - تماس با mention یا تماس سریع
 * - مدیریت مخاطبین
 * - گالری عکس و فیلم
 * - ریپلای بین گروه‌ها
 * - persist با Supabase یا حافظه
 */

const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ---------- config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
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
global.gallery = global.gallery || { PHOTO: [], FILM: [] };

// ---------- bot & server ----------
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// ---------- session و وضعیت کاربر ----------
bot.use(session({
    defaultSession: () => ({
        userState: 'none',
        tempContactName: null,
        tempPhotoLinks: [],
        tempFilmLinks: [],
        tempMessages: [],
        galleryType: null,
        awaitingGalleryType: null,
        filmMessages: []
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

async function findUserByPhone(phone){
    const target = phone.toUpperCase();
    if(supabase){
        const { data } = await supabase.from('users').select('*').eq('phone_number',target).maybeSingle();
        return data || null;
    } else {
        for(const [uid,u] of Object.entries(global.users)){
            if((u.phone_number||'').toUpperCase()===target) return {...u,user_id:Number(uid)};
        }
        return null;
    }
}

async function persistActiveCall(callData){
    global.activeCalls[callData.callId] = callData;
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
            duration: callData.duration || null
        });
    }
}

async function userHasActiveCall(userId){
    for(const c of Object.values(global.activeCalls||{})){
        if((c.callerId===userId||c.receiverId===userId)&&['ringing','answered'].includes(c.status)) return true;
    }
    return false;
}
// ---------- ثبت شماره کاربر ----------
bot.command('register', async ctx => {
    const args = ctx.message.text.split(' ').slice(1);
    if(!args.length) return ctx.reply('❌ مثال صحیح: /register A1234');
    const phone = args[0].toUpperCase();

    if(!isValidPhoneNumber(phone)) return ctx.reply('❌ شماره نامعتبر است. مثال: A1234');

    if(supabase){
        await supabase.from('users').upsert({
            user_id: ctx.from.id,
            phone_number: phone,
            group_id: ctx.chat.id
        }, { onConflict: 'user_id' });
    } else {
        global.users[ctx.from.id] = { phone_number: phone, group_id: ctx.chat.id };
    }

    return ctx.reply(`✅ شماره شما ثبت شد: ${phone}`);
});

// ---------- نمایش مخاطبین ----------
bot.command('contacts', async ctx => {
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

// ---------- افزودن مخاطب ----------
bot.action('add_contact', async ctx => {
    ctx.session.userState = USER_STATES.AWAITING_CONTACT_NAME;
    await ctx.reply('📥 لطفاً نام مخاطب را وارد کنید:');
    ctx.answerCbQuery();
});

bot.on('text', async ctx => {
    if(ctx.session.userState === USER_STATES.AWAITING_CONTACT_NAME){
        const name = ctx.message.text.trim();
        if(!name || name.length < 2) return ctx.reply('نام معتبر وارد کنید.');
        ctx.session.tempContactName = name;
        ctx.session.userState = USER_STATES.AWAITING_CONTACT_PHONE;
        return ctx.reply('شماره تماس را وارد کنید:');
    }

    if(ctx.session.userState === USER_STATES.AWAITING_CONTACT_PHONE){
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
    }
});

// ---------- حذف مخاطب ----------
bot.action('delete_contact', async ctx => {
    let contacts = global.contacts[ctx.from.id] || [];
    if(supabase){
        const { data } = await supabase.from('contacts').select('*').eq('user_id', ctx.from.id);
        contacts = data || [];
    }
    if(!contacts.length) return ctx.reply('📭 هیچ مخاطبی وجود ندارد.');
    const buttons = contacts.map(c => [Markup.button.callback(`🗑️ ${c.contact_name}`, `del_contact_${c.phone_number}`)]);
    buttons.push([Markup.button.callback('🔙 بازگشت', 'back_to_main')]);
    await ctx.reply('🗑️ کدام مخاطب را حذف می‌کنید؟', Markup.inlineKeyboard(buttons));
    ctx.answerCbQuery();
});

bot.action(/del_contact_(.+)/, async ctx => {
    const phone = ctx.match[1];
    if(supabase){
        await supabase.from('contacts').delete().eq('user_id', ctx.from.id).eq('phone_number', phone);
    } else {
        global.contacts[ctx.from.id] = (global.contacts[ctx.from.id]||[]).filter(c=>c.phone_number !== phone);
    }
    await ctx.reply(`✅ مخاطب با شماره ${phone} حذف شد.`);
    ctx.answerCbQuery();
});

// ---------- تاریخچه تماس ----------
bot.command('call_history', async ctx => {
    let history = [];
    if(supabase){
        const { data } = await supabase.from('call_history').select('*').or(`caller_id.eq.${ctx.from.id},receiver_id.eq.${ctx.from.id}`).order('started_at', { ascending: false });
        history = data || [];
    } else {
        history = global.callHistory.filter(c=>c.callerId===ctx.from.id||c.receiverId===ctx.from.id);
    }

    if(!history.length) return ctx.reply('📭 تاریخچه‌ای موجود نیست.');
    let msg = '📒 تاریخچه تماس‌ها:\n\n';
    history.slice(0,20).forEach(c=>{
        msg += `📞 ${c.callerPhone} → ${c.receiverPhone} | ${c.status.toUpperCase()} | ⏱ ${c.duration||0}s\n`;
    });
    await ctx.reply(msg);
});
// ---------- تماس mention-based ----------
bot.on('text', async (ctx, next) => {
    const text = ctx.message.text || '';
    const mention = `@${ctx.botInfo.username}`;
    if(!text.includes(mention)) return next();

    const parts = text.split(/\s+/);
    const idx = parts.findIndex(p => p.includes(mention));
    const targetPhone = parts[idx + 1] ? parts[idx + 1].toUpperCase() : null;
    if(!targetPhone || !isValidPhoneNumber(targetPhone)) return ctx.reply('❌ شماره نامعتبر. مثال: A1234');

    // بررسی ثبت کاربر تماس گیرنده
    let callerPhone = null, callerGroup = null;
    if(supabase){
        const { data } = await supabase.from('users').select('phone_number,group_id').eq('user_id', ctx.from.id).maybeSingle();
        if(!data) return ctx.reply('❌ ابتدا /register کنید.');
        callerPhone = data.phone_number; callerGroup = data.group_id;
    } else if(global.users[ctx.from.id]){
        callerPhone = global.users[ctx.from.id].phone_number;
        callerGroup = global.users[ctx.from.id].group_id;
    } else return ctx.reply('❌ ابتدا /register کنید.');

    const targetUser = await findUserByPhone(targetPhone);
    if(!targetUser) return ctx.reply('❌ کاربر مقصد یافت نشد.');
    if(await userHasActiveCall(ctx.from.id)) return ctx.reply('❌ شما در تماس هستید.');
    if(await userHasActiveCall(targetUser.user_id)) return ctx.reply('❌ کاربر مقصد در تماس است.');

    const callId = uuidv4();
    const callData = {
        callId,
        callerId: ctx.from.id,
        callerPhone,
        callerGroupId: callerGroup,
        receiverId: targetUser.user_id,
        receiverPhone: targetPhone,
        receiverGroupId: targetUser.group_id,
        status: 'ringing',
        startTime: new Date().toISOString(),
        callerChatId: ctx.chat.id,
        callerMessageId: null,
        receiverChatId: null,
        receiverMessageId: null
    };

    await persistActiveCall(callData);

    // پیام به تماس گیرنده
    const sentCaller = await ctx.reply(
        `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n⏳ در حال برقراری...`,
        { reply_to_message_id: ctx.message.message_id, reply_markup: createCallResponseKeyboard(callId).reply_markup }
    );
    callData.callerMessageId = sentCaller.message_id;
    callData.callerChatId = sentCaller.chat.id;

    // پیام به کاربر مقصد
    const sentReceiver = await bot.telegram.sendMessage(
        callData.receiverGroupId,
        `📞 تماس ورودی از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n⏳ در حال برقراری...`,
        createCallResponseKeyboard(callId)
    );
    callData.receiverMessageId = sentReceiver.message_id;
    callData.receiverChatId = sentReceiver.chat.id;

    await persistActiveCall(callData);
});

// ---------- پاسخ تماس ----------
bot.action(/answer_call_(.+)/, async ctx => {
    const callId = ctx.match[1];
    const call = global.activeCalls[callId];
    if(!call) return ctx.answerCbQuery('❌ تماس فعال نیست.');
    if(ctx.from.id !== call.receiverId) return ctx.answerCbQuery('❌ فقط کاربر مقصد می‌تواند پاسخ دهد.');

    call.status = 'answered';
    call.answerTime = new Date().toISOString();
    await persistActiveCall(call);

    if(call.callerChatId && call.callerMessageId)
        await bot.telegram.editMessageText(
            call.callerChatId, call.callerMessageId, null,
            `📞 تماس برقرار شد.`,
            createEndCallKeyboard(callId)
        );

    if(call.receiverChatId && call.receiverMessageId)
        await bot.telegram.editMessageText(
            call.receiverChatId, call.receiverMessageId, null,
            `📞 تماس برقرار شد.`,
            createEndCallKeyboard(callId)
        );

    ctx.answerCbQuery('✅ تماس پاسخ داده شد.');
});

// ---------- رد تماس ----------
bot.action(/reject_call_(.+)/, async ctx => {
    const callId = ctx.match[1];
    const call = global.activeCalls[callId];
    if(!call) return ctx.answerCbQuery('❌ تماس فعال نیست.');

    call.status = 'rejected';
    call.endTime = new Date().toISOString();
    await saveCallHistory(call);
    await removeActiveCall(callId);

    if(call.callerChatId && call.callerMessageId)
        await bot.telegram.editMessageText(call.callerChatId, call.callerMessageId, null, '❌ تماس رد شد.');
    if(call.receiverChatId && call.receiverMessageId)
        await bot.telegram.editMessageText(call.receiverChatId, call.receiverMessageId, null, '❌ تماس رد شد.');

    ctx.answerCbQuery('✅ تماس رد شد.');
});

// ---------- پایان تماس ----------
bot.action(/end_call_(.+)/, async ctx => {
    const callId = ctx.match[1];
    const call = global.activeCalls[callId];
    if(!call || call.status !== 'answered') return ctx.answerCbQuery('❌ قابل پایان نیست.');

    call.status = 'ended';
    call.endTime = new Date().toISOString();
    call.duration = call.answerTime ? Math.floor((new Date(call.endTime) - new Date(call.answerTime))/1000) : 0;
    await saveCallHistory(call);
    await removeActiveCall(callId);

    if(call.callerChatId && call.callerMessageId)
        await bot.telegram.editMessageText(call.callerChatId, call.callerMessageId, null, `⏹️ پایان یافت\n⏱ ${call.duration}s`);
    if(call.receiverChatId && call.receiverMessageId)
        await bot.telegram.editMessageText(call.receiverChatId, call.receiverMessageId, null, `⏹️ پایان یافت\n⏱ ${call.duration}s`);

    ctx.answerCbQuery('✅ تماس پایان یافت.');
});

// ---------- تماس سریع (quick call) ----------
bot.action(/quick_call_(.+)/, async ctx => {
    const phone = ctx.match[1];
    const callerId = ctx.from.id;

    const targetUser = await findUserByPhone(phone);
    if(!targetUser) return ctx.reply('❌ کاربر یافت نشد.');
    if(await userHasActiveCall(callerId)) return ctx.reply('❌ شما در تماس هستید.');
    if(await userHasActiveCall(targetUser.user_id)) return ctx.reply('❌ کاربر مقصد در تماس است.');

    const callId = uuidv4();
    const callData = {
        callId,
        callerId,
        callerPhone: global.users[callerId]?.phone_number || '',
        callerGroupId: global.users[callerId]?.group_id || ctx.chat.id,
        receiverId: targetUser.user_id,
        receiverPhone: phone,
        receiverGroupId: targetUser.group_id,
        status: 'ringing',
        startTime: new Date().toISOString(),
        callerChatId: ctx.chat.id,
        callerMessageId: null,
        receiverMessageId: null,
        receiverChatId: null
    };
    await persistActiveCall(callData);

    const sentCaller = await ctx.reply(
        `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n⏳ در حال برقراری...`,
        { reply_markup: createCallResponseKeyboard(callId).reply_markup }
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
    ctx.answerCbQuery('✅ تماس برقرار شد.');
});
// ---------- گالری و فیلم ----------
global.gallery = global.gallery || {}; // user_id => array of {type:'photo'|'film', messages:[...]}
bot.command('PHOTO', async ctx => {
    ctx.session.galleryType = 'photo';
    return ctx.reply('✅ لینک پیام PHOTO را ارسال کنید:');
});
bot.command('FILM', async ctx => {
    ctx.session.galleryType = 'film';
    ctx.session.tempMessages = [];
    return ctx.reply('✅ لینک پیام FILM را ارسال کنید (برای چند پیام جداگانه ارسال کنید):');
});

bot.on('text', async ctx => {
    if(ctx.session.galleryType === 'photo'){
        const link = ctx.message.text.trim();
        if(!link) return ctx.reply('❌ لینک نامعتبر است.');
        global.gallery[ctx.from.id] = global.gallery[ctx.from.id] || [];
        global.gallery[ctx.from.id].push({ type: 'photo', messages: [link] });
        ctx.session.galleryType = null;
        return ctx.reply('✅ عکس ذخیره شد.');
    } else if(ctx.session.galleryType === 'film'){
        const link = ctx.message.text.trim();
        if(!link) return ctx.reply('❌ لینک نامعتبر است.');
        ctx.session.tempMessages.push(link);
        return ctx.reply('✅ لینک ثبت شد. برای اتمام /ENDFILM بزنید.');
    } else if(ctx.message.text === '/ENDFILM' && ctx.session.tempMessages && ctx.session.tempMessages.length){
        global.gallery[ctx.from.id] = global.gallery[ctx.from.id] || [];
        global.gallery[ctx.from.id].push({ type: 'film', messages: ctx.session.tempMessages });
        ctx.session.tempMessages = [];
        ctx.session.galleryType = null;
        return ctx.reply('✅ فیلم‌ها ذخیره شدند.');
    }
});

// ---------- نمایش گالری ----------
bot.action('gallery', async ctx => {
    const userGallery = global.gallery[ctx.from.id] || [];
    if(!userGallery.length) return ctx.answerCbQuery('📭 چیزی ذخیره نشده.');
    let msg = '🖼️ گالری شما:\n';
    userGallery.forEach((g, i) => {
        msg += `${i+1}. ${g.type.toUpperCase()} - ${g.messages.length} پیام\n`;
    });
    await ctx.reply(msg);
    ctx.answerCbQuery();
});

// ---------- دکمه دوربین ----------
bot.action('camera', async ctx => {
    const userGallery = global.gallery[ctx.from.id] || [];
    const photos = userGallery.filter(g => g.type==='photo');
    if(!photos.length) return ctx.reply('📭 هیچ عکسی ذخیره نشده.');
    for(const p of photos){
        for(const msg of p.messages){
            await ctx.reply(`📸 ${msg}`);
        }
    }
    ctx.answerCbQuery();
});

// ---------- ریپلای پیام بین گروه‌ها ----------
bot.on('message', async (ctx, next) => {
    const reply = ctx.message.reply_to_message;
    if(reply){
        const callEntry = Object.values(global.activeCalls).find(c =>
            (c.callerMessageId === reply.message_id && c.callerChatId === ctx.chat.id) ||
            (c.receiverMessageId === reply.message_id && c.receiverChatId === ctx.chat.id)
        );

        if(callEntry){
            let destChatId = null;
            if(callEntry.callerMessageId === reply.message_id) destChatId = callEntry.receiverChatId;
            else if(callEntry.receiverMessageId === reply.message_id) destChatId = callEntry.callerChatId;

            if(destChatId){
                await bot.telegram.sendMessage(destChatId, `📩 پیام ریپلای شده از ${ctx.from.first_name}:\n${ctx.message.text || ''}`);
                return;
            }
        }
    }
    return next();
});
// ---------- مدیریت مخاطبین ----------
bot.action('manage_contacts', async ctx => {
    await ctx.reply('📋 مدیریت مخاطبین:', createContactsManagementKeyboard());
    ctx.answerCbQuery();
});

bot.action('add_contact', async ctx => {
    ctx.session.userState = USER_STATES.AWAITING_CONTACT_NAME;
    await ctx.reply('📝 لطفاً نام مخاطب را وارد کنید:');
    ctx.answerCbQuery();
});

bot.action('delete_contact', async ctx => {
    const contacts = global.contacts[ctx.from.id] || [];
    if(!contacts.length) return ctx.reply('📭 هیچ مخاطبی برای حذف وجود ندارد.');
    const buttons = contacts.map(c => Markup.button.callback(`❌ ${c.contact_name}`, `delete_contact_${c.phone_number}`));
    buttons.push([Markup.button.callback('🔙 بازگشت','back_to_main')]);
    await ctx.reply('🗑️ مخاطب مورد نظر را برای حذف انتخاب کنید:', Markup.inlineKeyboard(buttons));
    ctx.answerCbQuery();
});

bot.action(/delete_contact_(.+)/, async ctx => {
    const phone = ctx.match[1];
    global.contacts[ctx.from.id] = (global.contacts[ctx.from.id] || []).filter(c=>c.phone_number!==phone);
    await ctx.reply(`✅ مخاطب با شماره ${phone} حذف شد.`);
    ctx.answerCbQuery();
});

bot.action('call_from_contacts', async ctx => {
    const contacts = global.contacts[ctx.from.id] || [];
    if(!contacts.length) return ctx.reply('📭 هیچ مخاطبی وجود ندارد.');
    await ctx.reply('📞 مخاطب را برای تماس انتخاب کنید:', createContactButtons(contacts));
    ctx.answerCbQuery();
});

// ---------- تماس سریع ----------
bot.action(/quick_call_(.+)/, async ctx => {
    const phone = ctx.match[1];
    const targetUser = await findUserByPhone(phone);
    if(!targetUser) return ctx.reply('❌ کاربر یافت نشد.');
    if(await userHasActiveCall(ctx.from.id)) return ctx.reply('❌ شما در تماس هستید.');
    if(await userHasActiveCall(targetUser.user_id)) return ctx.reply('❌ کاربر مقصد در تماس است.');

    const callId = uuidv4();
    const callData = {
        callId,
        callerId: ctx.from.id,
        callerPhone: (global.users[ctx.from.id]||{}).phone_number || '',
        callerGroupId: (global.users[ctx.from.id]||{}).group_id || ctx.chat.id,
        receiverId: targetUser.user_id,
        receiverPhone: phone,
        receiverGroupId: targetUser.group_id,
        status: 'ringing',
        startTime: new Date().toISOString(),
        callerChatId: ctx.chat.id,
        callerMessageId: null,
        receiverMessageId: null,
        receiverChatId: null
    };
    await persistActiveCall(callData);

    const sentCaller = await ctx.reply(
        `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n⏳ در حال برقراری...`,
        { reply_markup: createCallResponseKeyboard(callId).reply_markup }
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
    ctx.answerCbQuery('✅ تماس برقرار شد.');
});

// ---------- بازگشت به منو ----------
bot.action('back_to_main', async ctx => {
    await ctx.reply('🏠 منوی اصلی:', createMainMenu());
    ctx.answerCbQuery();
});

// ---------- کمک / راهنما ----------
bot.action('help', async ctx => {
    await ctx.reply(`ℹ️ راهنما:
- /register A1234 → ثبت شماره شما
- 📞 تماس سریع یا با ریپلای @bot A1234
- 📒 تاریخچه → مشاهده تماس‌ها
- 📸 دوربین → ثبت پیام‌ها و عکس‌ها
- 🖼️ گالری → مشاهده گالری
- ➕ افزودن مخاطب / 🗑️ حذف مخاطب`);
    ctx.answerCbQuery();
});
// ---------- webhook ----------
app.post(`/webhook/${BOT_TOKEN}`, (req,res)=>{
    bot.handleUpdate(req.body,res).catch(err=>{
        console.error('❌ خطا در پردازش webhook:', err);
        res.sendStatus(500);
    });
});

// ---------- startup ----------
app.listen(PORT, async ()=>{
    console.log(`🚀 سرور روی پورت ${PORT} اجرا شد`);
    try{
        const webhookUrl = `${BASE_URL.replace(/\/$/,'')}/webhook/${BOT_TOKEN}`;
        const set = await bot.telegram.setWebhook(webhookUrl);
        console.log('✅ Webhook ست شد:', webhookUrl, set);
    }catch(err){
        console.error('❌ خطا در ست webhook:', err);
    }
});

// ---------- اطمینان از تعریف توابع کمکی ----------
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

function createContactButtons(contacts){
    const buttons = [];
    for(let i=0; i<contacts.length; i+=3){
        buttons.push(contacts.slice(i,i+3).map(c=>Markup.button.callback(`👤 ${c.contact_name}`, `quick_call_${c.phone_number}`)));
    }
    buttons.push([Markup.button.callback('🔙 بازگشت','back_to_main')]);
    return Markup.inlineKeyboard(buttons);
}
