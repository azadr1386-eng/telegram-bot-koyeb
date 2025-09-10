import os
import logging
import sqlite3
import asyncio
from fastapi import FastAPI, Request, Response
from telegram import Update
from telegram.constants import ChatMemberStatus
from telegram.ext import Application, CommandHandler, MessageHandler, ContextTypes, filters

# ---------- تنظیمات ----------
BOT_TOKEN = os.environ.get("BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)

DB_FILE = "bot_settings.db"

# ---------- دیتابیس ----------
def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""CREATE TABLE IF NOT EXISTS triggers (
            chat_id INTEGER,
            trigger TEXT,
            delay INTEGER,
            message TEXT,
            type TEXT,
            related_trigger_word TEXT
        )""")
    cursor.execute("""CREATE TABLE IF NOT EXISTS memberships (
            user_id INTEGER,
            chat_id INTEGER,
            is_quarantined INTEGER DEFAULT 0,
            quarantined_in_chat_id INTEGER,
            awaiting_unban_trigger TEXT,
            PRIMARY KEY (user_id, chat_id)
        )""")
    conn.commit()
    conn.close()

init_db()

def add_trigger(chat_id, trigger, delay, message, type_="normal", related_trigger_word=None):
    conn = sqlite3.connect(DB_FILE)
    conn.execute(
        "INSERT INTO triggers (chat_id, trigger, delay, message, type, related_trigger_word) VALUES (?, ?, ?, ?, ?, ?)",
        (chat_id, trigger, delay, message, type_, related_trigger_word),
    )
    conn.commit()
    conn.close()

def get_triggers(chat_id):
    conn = sqlite3.connect(DB_FILE)
    result = conn.execute(
        "SELECT trigger, delay, message, type, related_trigger_word FROM triggers WHERE chat_id = ?", (chat_id,)
    ).fetchall()
    conn.close()
    return result

def clear_triggers(chat_id):
    conn = sqlite3.connect(DB_FILE)
    conn.execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))
    conn.commit()
    conn.close()

def add_membership(user_id, chat_id):
    conn = sqlite3.connect(DB_FILE)
    conn.execute("INSERT OR IGNORE INTO memberships (user_id, chat_id) VALUES (?, ?)", (user_id, chat_id))
    conn.commit()
    conn.close()

def get_user_memberships_with_status(user_id):
    conn = sqlite3.connect(DB_FILE)
    result = conn.execute(
        "SELECT chat_id, is_quarantined, quarantined_in_chat_id, awaiting_unban_trigger FROM memberships WHERE user_id = ?", (user_id,)
    ).fetchall()
    conn.close()
    return result

def remove_membership(user_id, chat_id):
    conn = sqlite3.connect(DB_FILE)
    conn.execute("DELETE FROM memberships WHERE user_id = ? AND chat_id = ?", (user_id, chat_id))
    conn.commit()
    conn.close()

def set_user_quarantine_status(user_id, is_quarantined, quarantined_in_chat_id=None, awaiting_unban_trigger=None):
    conn = sqlite3.connect(DB_FILE)
    conn.execute(
        "UPDATE memberships SET is_quarantined = ?, quarantined_in_chat_id = ?, awaiting_unban_trigger = ? WHERE user_id = ?",
        (1 if is_quarantined else 0, quarantined_in_chat_id, awaiting_unban_trigger, user_id),
    )
    conn.commit()
    conn.close()

def get_user_global_quarantine_status(user_id):
    conn = sqlite3.connect(DB_FILE)
    result = conn.execute(
        "SELECT is_quarantined, quarantined_in_chat_id, awaiting_unban_trigger FROM memberships WHERE user_id = ? AND is_quarantined = 1 LIMIT 1",
        (user_id,)
    ).fetchone()
    conn.close()
    return result if result else (0, None, None)

# ---------- هندلرها ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ ربات روشنه و فعاله")

async def set_trigger_normal(update: Update, context: ContextTypes.DEFAULT_TYPE):
try:
        member = await context.bot.get_chat_member(update.effective_chat.id, update.effective_user.id)
        if member.status not in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
            await update.message.reply_text("❌ فقط ادمین‌ها میتونن تریگر ثبت کنن")

return

        if len(context.args) < 3:
            await update.message.reply_text("❌ استفاده: /set <کلمه> <زمان> <پیام>")
            return

        trigger_word = context.args[0]
        try:
            delay = int(context.args[1])
        except ValueError:
            await update.message.reply_text("⏱ زمان باید عدد باشه")
            return

        message = " ".join(context.args[2:])
        add_trigger(update.effective_chat.id, trigger_word, delay, message, "normal")

        await update.message.reply_text(
            f"✅ تریگر «{trigger_word}» (عادی) با تأخیر {delay} ثانیه ثبت شد.\n📩 پیام ذخیره‌شده: {message}",
            parse_mode="HTML",
        )
    except Exception as e:
        logging.error(f"خطا در set_trigger_normal: {e}")

async def set_trigger_quarantine(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        member = await context.bot.get_chat_member(update.effective_chat.id, update.effective_user.id)
        if member.status not in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
            await update.message.reply_text("❌ فقط ادمین‌ها میتونن تریگر ثبت کنن")
            return

        if len(context.args) < 4:
            await update.message.reply_text("❌ استفاده: /setquarantine <کلمه_ورود> <زمان_تاخیر> <پیام_قرنطینه> <کلمه_خروج>")
            return

        trigger_word = context.args[0]
        try:
            delay = int(context.args[1])
        except ValueError:
            await update.message.reply_text("⏱ زمان باید عدد باشه")
            return

        unquarantine_trigger_word = context.args[-1]
        quarantine_message = " ".join(context.args[2:-1])
        
        add_trigger(update.effective_chat.id, trigger_word, delay, quarantine_message, "ban", unquarantine_trigger_word)

        await update.message.reply_text(
            f"🚨 تریگر قرنطینه «{trigger_word}» با تأخیر {delay} ثانیه ثبت شد.\nپیام قرنطینه: {quarantine_message}\n🔓 برای خروج از قرنطینه: «{unquarantine_trigger_word}»",
            parse_mode="HTML",
        )
    except Exception as e:
        logging.error(f"خطا در set_trigger_quarantine: {e}")

async def set_trigger_unquarantine(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        member = await context.bot.get_chat_member(update.effective_chat.id, update.effective_user.id)
        if member.status not in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
            await update.message.reply_text("❌ فقط ادمین‌ها میتونن تریگر ثبت کنن")
            return

        if len(context.args) < 2:
            await update.message.reply_text("❌ استفاده: /setunquarantine <کلمه_خروج> <پیام_خروج>")
            return

        unquarantine_trigger_word = context.args[0]
        message = " ".join(context.args[1:])
        
        add_trigger(update.effective_chat.id, unquarantine_trigger_word, 0, message, "unban")

        await update.message.reply_text(
            f"🔓 تریگر خروج از قرنطینه «{unquarantine_trigger_word}» ثبت شد.\nپیام خروج: {message}",
            parse_mode="HTML",
        )
    except Exception as e:
        logging.error(f"خطا در set_trigger_unquarantine: {e}")

async def list_triggers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        triggers = get_triggers(update.effective_chat.id)
        if not triggers:
            await update.message.reply_text("📭 هیچ تریگری ثبت نشده.")
            return

        msg = "📋 تریگرهای این گروه:\n\n"
        for t, d, m, type_, related_t_word in triggers:
            if type_ == 'ban':
msg += f"🚫 قرنطینه: {t} (خروج: {related_t_word}) → {d} ثانیه → «{m}»\n"
            elif type_ == 'unban':
                msg += f"✅ خروج: {t} → «{m}»\n"
            else:
                msg += f"✨ عادی: {t} → {d} ثانیه → «{m}»\n"
                
        await update.message.reply_text(msg, parse_mode="HTML")
    except Exception as e:
        logging.error(f"خطا در list_triggers: {e}")

async def clear_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        clear_triggers(update.effective_chat.id)

await update.message.reply_text("🗑 تمام تریگرهای این گروه پاک شدند.")
    except Exception as e:
        logging.error(f"خطا در clear_all: {e}")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        if not update.message or not update.message.text:
            return

        text = update.message.text
        user_id = update.effective_user.id
        user_name = update.effective_user.full_name
        chat_id = update.effective_chat.id
        group_name = update.effective_chat.title or "Private"

        # بررسی وضعیت قرنطینه کاربر
        is_quarantined, quarantined_in_chat_id, awaiting_unban_trigger = get_user_global_quarantine_status(user_id)

        if is_quarantined:
            # کاربر در قرنطینه است
            if awaiting_unban_trigger and awaiting_unban_trigger.lower() in text.lower():
                # کاربر تریگر خروج را زده
                set_user_quarantine_status(user_id, False, None, None)
                logging.info(f"🔓 کاربر {user_name} با تریگر '{awaiting_unban_trigger}' از قرنطینه خارج شد.")
                await update.message.reply_text(f"🎉 شما با موفقیت از وضعیت قرنطینه خارج شدید!", reply_to_message_id=update.message.message_id)
                return
            else:
                # کاربر در قرنطینه است اما تریگر خروج نزده
                if chat_id != quarantined_in_chat_id:
                    # کاربر در گروهی غیر از گروه قرنطینه است
                    try:
                        await context.bot.ban_chat_member(chat_id, user_id)
                        await context.bot.unban_chat_member(chat_id, user_id)
                        remove_membership(user_id, chat_id)
                        await update.message.reply_text(
                            f"⛔ شما در وضعیت قرنطینه هستید و اجازه فعالیت در این گروه را ندارید تا زمانی که تریگر خروج را بزنید: <b>{awaiting_unban_trigger}</b>",
                            parse_mode="HTML"
                        )
                        logging.info(f"✅ کاربر {user_name} به دلیل قرنطینه از گروه {group_name} حذف شد.")
                    except Exception as e:
                        logging.error(f"❌ خطا در حذف کاربر قرنطینه {user_name} از {group_name}: {e}")
                else:
                    # کاربر در گروه قرنطینه است
                    await update.message.reply_text(
                        f"⚠️ شما در قرنطینه هستید. برای خروج، تریگر <b>{awaiting_unban_trigger}</b> را ارسال کنید.",
                        parse_mode="HTML"
                    )
                return

        # اگر کاربر قرنطینه نیست، عضویت او را ثبت کنید
        add_membership(user_id, chat_id)

        # بررسی تریگرها
        triggers = get_triggers(chat_id)
        for trigger_word, delay, message, type_, related_trigger_word in triggers:
            if trigger_word.lower() in text.lower():
                if type_ == 'ban':
                    # تریگر قرنطینه فعال شد
                    logging.info(f"🚨 تریگر قرنطینه '{trigger_word}' توسط {user_name} در گروه {group_name} فعال شد.")
                    set_user_quarantine_status(user_id, True, chat_id, related_trigger_word)

                    info_text = f"👤 پلیر <b>{user_name}</b> به منطقه <b>{group_name}</b> وارد شد و به دلیل فعال کردن تریگر <b>«{trigger_word}»</b> به قرنطینه منتقل شد.\n\n⏱ مدت زمان سفر شما <b>{delay} ثانیه</b> می‌باشد تا به پیام اصلی برسید."
                    await update.message.reply_text(info_text, parse_mode="HTML", reply_to_message_id=update.message.message_id)
# حذف کاربر از سایر گروه‌ها
                    user_memberships_info = get_user_memberships_with_status(user_id)
                    for member_chat_id, _, _, _ in user_memberships_info:
                        if member_chat_id != chat_id:
                            try:
                                bot_member = await context.bot.get_chat_member(member_chat_id, context.bot.id)
                                if bot_member.status in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:

await context.bot.ban_chat_member(member_chat_id, user_id)
                                    await context.bot.unban_chat_member(member_chat_id, user_id)
                                    remove_membership(user_id, member_chat_id)
                                    logging.info(f"✅ کاربر {user_name} از گروه {member_chat_id} حذف شد.")
                            except Exception as e:
                                logging.error(f"❌ خطا در حذف {user_name} از {member_chat_id}: {e}")

                    # ارسال پیام با تأخیر
                    async def delayed_reply_quarantine():
                        await asyncio.sleep(delay)
                        await update.message.reply_text(message, parse_mode="HTML", reply_to_message_id=update.message.message_id)
                        await update.message.reply_text(f"برای خروج از قرنطینه، لطفاً تریگر <b>«{related_trigger_word}»</b> را ارسال کنید.", parse_mode="HTML")

                    asyncio.create_task(delayed_reply_quarantine())
                    return

                elif type_ == 'normal':
                    # تریگر عادی فعال شد
                    logging.info(f"✨ تریگر عادی '{trigger_word}' توسط {user_name} فعال شد.")
                    info_text = f"👤 پلیر <b>{user_name}</b> به منطقه <b>{group_name}</b> وارد شد.\n\n⏱ مدت زمان سفر شما <b>{delay} ثانیه</b> می‌باشد."
                    await update.message.reply_text(info_text, parse_mode="HTML", reply_to_message_id=update.message.message_id)

                    # ارسال پیام با تأخیر
                    async def delayed_reply_normal():
                        await asyncio.sleep(delay)
                        await update.message.reply_text(message, parse_mode="HTML", reply_to_message_id=update.message.message_id)

                    asyncio.create_task(delayed_reply_normal())
                    return
                    
    except Exception as e:
        logging.error(f"خطا در handle_message: {e}")

# ---------- اجرای ربات ----------
app = FastAPI()
application = Application.builder().token(BOT_TOKEN).build()

# اضافه کردن هندلرها
application.add_handler(CommandHandler("start", start))
application.add_handler(CommandHandler("set", set_trigger_normal))
application.add_handler(CommandHandler("setquarantine", set_trigger_quarantine))
application.add_handler(CommandHandler("setunquarantine", set_trigger_unquarantine))
application.add_handler(CommandHandler("list", list_triggers))
application.add_handler(CommandHandler("clear", clear_all))
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

@app.on_event("startup")
async def on_startup():
    await application.initialize()
    await application.start()
    logging.info("🚀 Bot initialized. Waiting for webhook events...")

@app.on_event("shutdown")
async def on_shutdown():
    await application.stop()
    await application.shutdown()

@app.post(f"/webhook/{BOT_TOKEN}")
async def telegram_webhook(request: Request):
    try:
        data = await request.json()
        update = Update.de_json(data, application.bot)
        await application.process_update(update)
        return Response(status_code=200)
    except Exception as e:
        logging.error(f"خطا در webhook: {e}")
        return Response(status_code=500)

@app.get("/health")
def health():
    return {"ok": True}
@app.get("/set-webhook")
async def set_webhook(request: Request):
    try:
        base_url = str(request.base_url).rstrip("/")
        await application.bot.set_webhook(url=f"{base_url}/webhook/{BOT_TOKEN}")
        return {"status": "set", "webhook": f"{base_url}/webhook/{BOT_TOKEN}"}
    except Exception as e:
        logging.error(f"خطا در set-webhook: {e}")
        return {"status": "error", "message": str(e)}