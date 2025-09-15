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
 * BASE_URL (https://telegram-bot-koyeb-19.onrender.com)
 * PORT (optional)
 * SUPABASE_URL (optional)
 * SUPABASE_ANON_KEY (optional)
 */

const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = 'https://telegram-bot-koyeb-19.onrender.com';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN تنظیم نشده'); process.exit(1); }

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log('✅ Supabase متصل شد');
}

global.users = global.users || {};
global.callHistory = global.callHistory || [];
global.activeCalls = global.activeCalls || {};
global.contacts = global.contacts || {};

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

bot.use(session({ defaultSession: () => ({ userState:'none', userPhone:null, contacts:[], calls:[], activeCall:null, tempContactName:null }) }));

const USER_STATES = { NONE:'none', AWAITING_CONTACT_NAME:'awaiting_contact_name', AWAITING_CONTACT_PHONE:'awaiting_contact_phone' };

function isValidPhoneNumber(phone) { return /^[A-Za-z]\d{4}$/.test((phone||'').trim()); }
function createMainMenu(){ return Markup.inlineKeyboard([[Markup.button.callback('📞 مخاطبین','manage_contacts'),Markup.button.callback('📸 دوربین','camera'),Markup.button.callback('🖼️ گالری','gallery')],[Markup.button.callback('📒 دفترچه','call_history'),Markup.button.callback('📞 تماس','quick_call'),Markup.button.callback('ℹ️ راهنما','help')]]);}
function createCallResponseKeyboard(callId){ return Markup.inlineKeyboard([[Markup.button.callback('✅ پاسخ',`answer_call_${callId}`),Markup.button.callback('❌ رد',`reject_call_${callId}`)]]);}
function createEndCallKeyboard(callId){ return Markup.inlineKeyboard([[Markup.button.callback('📞 پایان تماس',`end_call_${callId}`)]]);}
function createContactButtons(contacts){ const buttons=[]; for(let i=0;i<contacts.length;i+=3){ buttons.push(contacts.slice(i,i+3).map(c=>Markup.button.callback(`👤 ${c.contact_name}`,`quick_call_${c.phone_number}`))); } buttons.push([Markup.button.callback('🔙 بازگشت','back_to_main')]); return Markup.inlineKeyboard(buttons);}
function createContactsManagementKeyboard(){ return Markup.inlineKeyboard([[Markup.button.callback('➕ افزودن مخاطب','add_contact')],[Markup.button.callback('📞 تماس از مخاطبین','call_from_contacts')],[Markup.button.callback('🗑️ حذف مخاطب','delete_contact')],[Markup.button.callback('🔙 بازگشت','back_to_main')]]); }

async function findUserByPhone(phone){ const p=phone.toUpperCase(); if(supabase){ const {data}=await supabase.from('users').select('user_id,username,group_id,phone_number').eq('phone_number',p).maybeSingle(); return data||null; } else { for(const [uid,u] of Object.entries(global.users)){ if((u.phone_number||'').toUpperCase()===p) return {user_id:Number(uid),username:u.username,group_id:u.group_id,phone_number:u.phone_number}; } return null; } }

async function saveCallHistory(callData){ try{ const row={ call_id:callData.callId,caller_id:callData.callerId,receiver_id:callData.receiverId,caller_phone:callData.callerPhone,receiver_phone:callData.receiverPhone,status:callData.status,duration:callData.duration||null,started_at:callData.startTime?new Date(callData.startTime).toISOString():null,answered_at:callData.answerTime?new Date(callData.answerTime).toISOString():null,ended_at:callData.endTime?new Date(callData.endTime).toISOString():null }; if(supabase){ const {error}=await supabase.from('call_history').insert(row); if(error) console.error(error); } else global.callHistory.push(row);}catch(err){console.error(err);}}

async function persistActiveCall(callData){ try{ const row={ call_id:callData.callId,caller_id:callData.callerId,receiver_id:callData.receiverId,caller_phone:callData.callerPhone,receiver_phone:callData.receiverPhone,caller_group_id:callData.callerGroupId,receiver_group_id:callData.receiverGroupId,caller_message_id:callData.callerMessageId||null,receiver_message_id:callData.receiverMessageId||null,status:callData.status,started_at:callData.startTime?new Date(callData.startTime).toISOString():new Date().toISOString(),answered_at:callData.answerTime?new Date(callData.answerTime).toISOString():null }; if(supabase){ const {error}=await supabase.from('active_calls').upsert(row,{onConflict:'call_id'}); if(error) console.error(error);} else global.activeCalls[callData.callId]=callData;}catch(err){console.error(err);}

async function removeActiveCall(callId){ try{ if(supabase){ const {error}=await supabase.from('active_calls').delete().eq('call_id',callId); if(error) console.error(error);} delete global.activeCalls[callId]; }catch(err){console.error(err);}}

async function loadActiveCallsFromDbAndRecover(){ if(!supabase)return; try{ const {data}=await supabase.from('active_calls').select('*').or('status.eq.ringing,status.eq.answered'); if(!data)return; for(const row of data){ const callId=row.call_id; const call={ callId,callerId:row.caller_id,receiverId:row.receiver_id,callerPhone:row.caller_phone,receiverPhone:row.receiver_phone,callerGroupId:row.caller_group_id,receiverGroupId:row.receiver_group_id,callerMessageId:row.caller_message_id,receiverMessageId:row.receiver_message_id,status:row.status,startTime:row.started_at?new Date(row.started_at):new Date(),answerTime:row.answered_at?new Date(row.answered_at):null }; global.activeCalls[callId]=call; if(row.status==='ringing'){ const age=(Date.now()-new Date(row.started_at).getTime())/1000; if(age>70){ call.status='missed'; call.endTime=new Date(); await saveCallHistory(call); await removeActiveCall(callId); } else setTimeout(()=>autoMissCallIfStillRinging(callId).catch(()=>{}),(60000-age*1000)+500); } } }catch(err){console.error(err);}}

async function autoMissCallIfStillRinging(callId){ try{ const call=global.activeCalls[callId]; if(!call)return; if(call.status==='ringing'){ call.status='missed'; call.endTime=new Date(); await saveCallHistory(call); await removeActiveCall(callId); } }catch(err){console.error(err);}

async function userHasActiveCall(userId){ for(const c of Object.values(global.activeCalls||{})){ if((c.callerId===userId||c.receiverId===userId)&&(c.status==='ringing'||c.status==='answered')) return true; } return false; }

// ---------- /start ----------
bot.start(async(ctx)=>{ try{ await ctx.reply(`👋 به ربات خوش آمدید!\n📞 ثبت شماره: /register A1234\n📒 منوی مخاطبین: /contacts\n📜 تاریخچه تماس‌ها: /call_history`, createMainMenu()); }catch(err){console.error(err);}});

// ---------- /register ----------
bot.command('register', async(ctx)=>{ try{ const parts=ctx.message.text.split(' '); if(parts.length<2) return ctx.reply('❌ شماره وارد کنید. مثال: /register A1234'); const phone=parts[1].toUpperCase(); if(!isValidPhoneNumber(phone)) return ctx.reply('❌ فرمت نامعتبر. مثال: A1234'); global.users[ctx.from.id]={phone_number:phone,username:ctx.from.username||ctx.from.first_name||'',group_id:ctx.chat.id}; return ctx.reply(`✅ شماره ${phone} ثبت شد.`); }catch(err){console.error(err); ctx.reply('❌ خطا');}});

// ---------- webhook ----------
app.post(`/webhook/${BOT_TOKEN}`,(req,res)=>{ bot.handleUpdate(req.body,res).catch(err=>{ console.error(err); res.sendStatus(500); }); });

// ---------- startup ----------
(async()=>{ try{ await loadActiveCallsFromDbAndRecover(); }catch(e){ console.warn(e);} app.listen(PORT, async()=>{ console.log(`🚀 سرور روی پورت ${PORT}`); try{ await bot.telegram.setWebhook(`${BASE_URL}/webhook/${BOT_TOKEN}`); console.log('✅ Webhook ست شد'); }catch(err){console.error(err);} });})();
process.once('SIGINT',()=>{ bot.stop('SIGINT'); process.exit(0);});
process.once('SIGTERM',()=>{ bot.stop('SIGTERM'); process.exit(0);});
