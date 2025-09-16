// ---------- session و وضعیت کاربر ----------
bot.use(session({
    defaultSession: () => ({
        userState: 'none',
        tempContactName: null,
        tempPhotoLinks: [],   // برای ذخیره موقت لینک‌ها
        tempFilmLinks: []
    })
}));

// ---------- دستورات ثبت مخاطب ----------
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

// ---------- جریان افزودن مخاطب ----------
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
// ---------- ایجاد تماس mention-based ----------
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

    // ایجاد شناسه تماس
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

    // ارسال پیام به تماس گیرنده
    const sentCaller = await ctx.reply(
        `📞 تماس از: ${callData.callerPhone}\n📞 به: ${callData.receiverPhone}\n⏳ در حال برقراری...`,
        { reply_to_message_id: ctx.message.message_id, reply_markup: createCallResponseKeyboard(callId).reply_markup }
    );
    callData.callerMessageId = sentCaller.message_id;
    callData.callerChatId = sentCaller.chat.id;

    // ارسال پیام به کاربر مقصد
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
    let call = global.activeCalls[callId];
    if(!call) return ctx.answerCbQuery('❌ تماس فعال نیست.');
    if(ctx.from.id !== call.receiverId) return ctx.answerCbQuery('❌ فقط کاربر مقصد می‌تواند پاسخ دهد.');

    call.status = 'answered';
    call.answerTime = new Date().toISOString();
    await persistActiveCall(call);

    // بروزرسانی پیام‌ها و اضافه کردن دکمه پایان تماس
    if(call.callerChatId && call.callerMessageId){
        await bot.telegram.editMessageText(
            call.callerChatId, call.callerMessageId, null,
            `📞 تماس برقرار شد.`,
            createEndCallKeyboard(callId)
        );
    }
    if(call.receiverChatId && call.receiverMessageId){
        await bot.telegram.editMessageText(
            call.receiverChatId, call.receiverMessageId, null,
            `📞 تماس برقرار شد.`,
            createEndCallKeyboard(callId)
        );
    }

    ctx.answerCbQuery('✅ تماس پاسخ داده شد.');
});

// ---------- رد تماس ----------
bot.action(/reject_call_(.+)/, async ctx => {
    const callId = ctx.match[1];
    let call = global.activeCalls[callId];
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

// ---------- پایان تماس توسط کاربر ----------
bot.action(/end_call_(.+)/, async ctx => {
    const callId = ctx.match[1];
    let call = global.activeCalls[callId];
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
// ---------- ریپلای پیام بین گروه‌ها ----------
bot.on('message', async (ctx, next) => {
    const reply = ctx.message.reply_to_message;
    if(reply){
        // بررسی اینکه پیام reply مربوط به تماس باشد
        const callEntry = Object.values(global.activeCalls).find(c =>
            (c.callerMessageId === reply.message_id && c.callerChatId === ctx.chat.id) ||
            (c.receiverMessageId === reply.message_id && c.receiverChatId === ctx.chat.id)
        );

        if(callEntry){
            // تعیین مقصد پیام
            let destChatId = null;
            if(callEntry.callerMessageId === reply.message_id) destChatId = callEntry.receiverChatId;
            else if(callEntry.receiverMessageId === reply.message_id) destChatId = callEntry.callerChatId;

            if(destChatId){
                // ارسال پیام به گروه مقصد
                await bot.telegram.sendMessage(destChatId, `📩 پیام ریپلای شده از ${ctx.from.first_name}:\n${ctx.message.text || ''}`);
                return;
            }
        }
    }
    return next();
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
// ---------- مدیریت مخاطبین ----------
bot.action('manage_contacts', async ctx => {
    await ctx.reply('📋 مدیریت مخاطبین:', createContactsManagementKeyboard());
    ctx.answerCbQuery();
});

bot.action('add_contact', async ctx => {
    ctx.session.userState = USER_STATES.AWAITING_CONTACT_NAME;
    await ctx.reply('📥 لطفا نام مخاطب را وارد کنید:');
    ctx.answerCbQuery();
});

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

bot.action('call_from_contacts', async ctx => {
    let contacts = global.contacts[ctx.from.id] || [];
    if(supabase){
        const { data } = await supabase.from('contacts').select('*').eq('user_id', ctx.from.id);
        contacts = data || [];
    }
    if(!contacts.length) return ctx.reply('📭 هیچ مخاطبی وجود ندارد.');
    const buttons = [];
    for(let i=0; i<contacts.length; i+=3){
        buttons.push(contacts.slice(i,i+3).map(c => Markup.button.callback(`👤 ${c.contact_name}`, `quick_call_${c.phone_number}`)));
    }
    buttons.push([Markup.button.callback('🔙 بازگشت', 'back_to_main')]);
    await ctx.reply('📞 مخاطبین برای تماس سریع:', Markup.inlineKeyboard(buttons));
    ctx.answerCbQuery();
});

bot.action(/quick_call_(.+)/, async ctx => {
    const targetPhone = ctx.match[1];
    const callerId = ctx.from.id;

    const targetUser = await findUserByPhone(targetPhone);
    if(!targetUser) return ctx.reply('❌ کاربر یافت نشد.');
    if(await userHasActiveCall(callerId)) return ctx.reply('❌ شما در تماس هستید.');
    if(await userHasActiveCall(targetUser.user_id)) return ctx.reply('❌ کاربر مقصد در تماس است.');

    const callId = uuidv4();
    const userPhone = global.users[callerId]?.phone_number || 'UNKNOWN';
    const userGroup = global.users[callerId]?.group_id || ctx.chat.id;

    const callData = {
        callId,
        callerId,
        callerPhone: userPhone,
        callerGroupId: userGroup,
        receiverId: targetUser.user_id,
        receiverPhone: targetPhone,
        receiverGroupId: targetUser.group_id,
        status: 'ringing',
        startTime: new Date().toISOString(),
        callerChatId: ctx.chat.id,
        callerMessageId: null,
        receiverMessageId: null,
        receiverChatId: null
    };
    await persistActiveCall(callData);

    // پیام‌ها
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

bot.action('back_to_main', async ctx => {
    await ctx.reply('🏠 منوی اصلی:', createMainMenu());
    ctx.answerCbQuery();
});
// ---------- گالری و دوربین ----------
bot.action('gallery', async ctx => {
    await ctx.reply('🖼️ گالری شما:\nبرای اضافه کردن عکس از /PHOTO و برای فیلم /FILM استفاده کنید.');
    ctx.answerCbQuery();
});

bot.action('camera', async ctx => {
    await ctx.reply('📸 دوربین شبیه‌سازی شده (پیام‌ها را می‌توانید ریپلای کنید تا ذخیره شوند).');
    ctx.answerCbQuery();
});

// ---------- ذخیره پیام‌ها ----------
bot.command('PHOTO', async ctx => {
    ctx.session.awaitingGalleryType = 'PHOTO';
    await ctx.reply('📌 لینک پیام یا متن را ارسال کنید تا به گالری عکس اضافه شود:');
});

bot.command('FILM', async ctx => {
    ctx.session.awaitingGalleryType = 'FILM';
    ctx.session.filmMessages = [];
    await ctx.reply('🎬 لینک پیام‌ها یا متن‌ها را یکی‌یکی ارسال کنید. بعد از آخرین پیام /END را بزنید:');
});

bot.command('END', async ctx => {
    if(ctx.session.awaitingGalleryType === 'FILM' && ctx.session.filmMessages.length){
        // ذخیره فیلم در DB یا حافظه
        global.gallery = global.gallery || { PHOTO: [], FILM: [] };
        global.gallery.FILM.push([...ctx.session.filmMessages]);
        ctx.session.filmMessages = [];
        ctx.session.awaitingGalleryType = null;
        return ctx.reply('✅ فیلم ذخیره شد.');
    }
    ctx.reply('❌ هیچ فیلیمی در حال ثبت وجود ندارد.');
});

bot.on('text', async ctx => {
    if(ctx.session.awaitingGalleryType === 'PHOTO'){
        const text = ctx.message.text;
        global.gallery = global.gallery || { PHOTO: [], FILM: [] };
        global.gallery.PHOTO.push(text);
        ctx.session.awaitingGalleryType = null;
        return ctx.reply('✅ عکس ذخیره شد.');
    } else if(ctx.session.awaitingGalleryType === 'FILM'){
        ctx.session.filmMessages.push(ctx.message.text);
        return ctx.reply('پیام ثبت شد. پیام بعدی یا /END');
    }
});

// ---------- نمایش گالری ----------
bot.action('gallery', async ctx => {
    global.gallery = global.gallery || { PHOTO: [], FILM: [] };
    let msg = '🖼️ گالری:\n\n📷 عکس‌ها:\n';
    global.gallery.PHOTO.forEach((p,i)=> msg += `${i+1}. ${p}\n`);
    msg += '\n🎬 فیلم‌ها:\n';
    global.gallery.FILM.forEach((f,i)=> msg += `${i+1}. ${f.join(' | ')}\n`);
    await ctx.reply(msg);
    ctx.answerCbQuery();
});

// ---------- ریپلای بین گروه‌ها ----------
bot.on('message', async ctx => {
    if(ctx.message.reply_to_message){
        const replyMsg = ctx.message.text || ctx.message.caption || '';
        // بررسی اینکه پیام reply شده متعلق به تماس باشد
        const call = Object.values(global.activeCalls).find(c=>c.callerMessageId===ctx.message.reply_to_message.message_id || c.receiverMessageId===ctx.message.reply_to_message.message_id);
        if(call){
            // فوروارد پیام به گروه مقصد
            const targetChatId = ctx.from.id === call.callerId ? call.receiverChatId : call.callerChatId;
            const sent = await bot.telegram.sendMessage(targetChatId, `💬 ریپلای:\n${replyMsg}`, { reply_to_message_id: ctx.from.id===call.callerId ? call.receiverMessageId : call.callerMessageId });
        }
    }
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
    const buttons = contacts.map(c=>Markup.button.callback(`❌ ${c.contact_name}`, `delete_contact_${c.phone_number}`));
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
    ctx.answerCbQuery();
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

// ---------- گالری / دوربین / فیلم ----------
// از پارت ۵ استفاده می‌شود

// ---------- ریپلای بین گروه‌ها ----------
// از پارت ۵ استفاده می‌شود

// ---------- webhook ----------
app.post(`/webhook/${BOT_TOKEN}`, (req,res)=>{
    bot.handleUpdate(req.body,res).catch(err=>{console.error(err); res.sendStatus(500);});
});

// ---------- startup ----------
app.listen(PORT, async ()=>{
    console.log(`🚀 سرور روی پورت ${PORT} اجرا شد`);
    try{
        const webhookUrl = `${BASE_URL.replace(/\/$/,'')}/webhook/${BOT_TOKEN}`;
        const set = await bot.telegram.setWebhook(webhookUrl);
        console.log('✅ Webhook ست شد:', webhookUrl,set);
    }catch(err){console.error('❌ خطا در ست webhook:',err);}
});
