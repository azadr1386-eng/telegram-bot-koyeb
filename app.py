import os
import logging
import sqlite3
import asyncio
from fastapi import FastAPI, Request, Response
from telegram import Update
from telegram.constants import ChatMemberStatus
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# ---------- تنظیمات ----------
BOT_TOKEN = os.environ["BOT_TOKEN"]

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)

DB_FILE = "bot_settings.db"

# ---------- دیتابیس ----------
def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("""CREATE TABLE IF NOT EXISTS triggers (
                chat_id INTEGER,
                trigger TEXT,
                delay INTEGER,
                message TEXT,
                type TEXT, -- 'normal', 'ban', 'unban'
                related_trigger_word TEXT DEFAULT NULL -- for 'ban' type, stores the unban trigger
            )""")
        cursor.execute("""CREATE TABLE IF NOT EXISTS memberships (
                user_id INTEGER,
                chat_id INTEGER,
                is_quarantined INTEGER DEFAULT 0, -- 0 for false, 1 for true
                quarantined_in_chat_id INTEGER DEFAULT NULL, -- The chat_id where the user got quarantined
                awaiting_unban_trigger TEXT DEFAULT NULL, -- The specific trigger word to unquarantine
                PRIMARY KEY (user_id, chat_id)
            )""")
        conn.commit()

init_db()

def add_trigger(chat_id: int, trigger: str, delay: int, message: str, type_: str = "normal", related_trigger_word: str = None):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "INSERT INTO triggers (chat_id, trigger, delay, message, type, related_trigger_word) VALUES (?, ?, ?, ?, ?, ?)",
            (chat_id, trigger, delay, message, type_, related_trigger_word),
        )
        conn.commit()

def get_triggers(chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        return conn.execute(
            "SELECT trigger, delay, message, type, related_trigger_word FROM triggers WHERE chat_id = ?", (chat_id,)
        ).fetchall()

def clear_triggers(chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))
        conn.commit()

def add_membership(user_id: int, chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        # Insert or ignore to not overwrite existing quarantine status
        conn.execute(
            "INSERT OR IGNORE INTO memberships (user_id, chat_id) VALUES (?, ?)",
            (user_id, chat_id),
        )
        conn.commit()

def get_user_memberships_with_status(user_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        return conn.execute(
            "SELECT chat_id, is_quarantined, quarantined_in_chat_id, awaiting_unban_trigger FROM memberships WHERE user_id = ?", (user_id,)
        ).fetchall()

def remove_membership(user_id: int, chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "DELETE FROM memberships WHERE user_id = ? AND chat_id = ?",
            (user_id, chat_id),
        )
        conn.commit()

def set_user_quarantine_status(user_id: int, is_quarantined: bool, quarantined_in_chat_id: int = None, awaiting_unban_trigger: str = None):
    with sqlite3.connect(DB_FILE) as conn:
        # Update quarantine status for ALL memberships of this user
        conn.execute(
            """
            UPDATE memberships
            SET is_quarantined = ?, quarantined_in_chat_id = ?, awaiting_unban_trigger = ?
            WHERE user_id = ?
            """,
            (1 if is_quarantined else 0, quarantined_in_chat_id, awaiting_unban_trigger, user_id),
        )
        conn.commit()

def get_user_global_quarantine_status(user_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        # Find if user is quarantined in *any* chat
        result = conn.execute(
            "SELECT is_quarantined, quarantined_in_chat_id, awaiting_unban_trigger FROM memberships WHERE user_id = ? AND is_quarantined = 1 LIMIT 1",
            (user_id,)
        ).fetchone()
        return result if result else (0, None, None) # Return (0, None, None) if not quarantined

# ---------- هندلرها ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ ربات روشنه و فعاله")

async def set_trigger_normal(update: Update, context: ContextTypes.DEFAULT_TYPE):
    member = await context.bot.get_chat_member(
        update.effective_chat.id, update.effective_user.id
    )
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
        f"✅ تریگر «{trigger_word}» (عادی) با تأخیر {delay} ثانیه ثبت شد.\n"
        f"📩 پیام ذخیره‌شده: {message}",
        parse_mode="HTML",
    )

async def set_trigger_quarantine(update: Update, context: ContextTypes.DEFAULT_TYPE):
    member = await context.bot.get_chat_member(
        update.effective_chat.id, update.effective_user.id
    )
    if member.status not in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
        await update.message.reply_text("❌ فقط ادمین‌ها میتونن تریگر ثبت کنن")
        return

    if len(context.args) < 4: # trigger_word, delay, quarantine_message, unquarantine_trigger_word
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
        f"🚨 تریگر قرنطینه «{trigger_word}» با تأخیر {delay} ثانیه ثبت شد.\n"
        f"پیام قرنطینه: {quarantine_message}\n"
        f"🔓 برای خروج از قرنطینه: «{unquarantine_trigger_word}»",
        parse_mode="HTML",
    )

async def set_trigger_unquarantine(update: Update, context: ContextTypes.DEFAULT_TYPE):
    member = await context.bot.get_chat_member(
        update.effective_chat.id, update.effective_user.id
    )
    if member.status not in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
        await update.message.reply_text("❌ فقط ادمین‌ها میتونن تریگر ثبت کنن")
        return

    if len(context.args) < 2: # unquarantine_trigger_word, message
        await update.message.reply_text("❌ استفاده: /setunquarantine <کلمه_خروج> <پیام_خروج>")
        return

    unquarantine_trigger_word = context.args[0]
    message = " ".join(context.args[1:])
    
    add_trigger(update.effective_chat.id, unquarantine_trigger_word, 0, message, "unban") # Delay not relevant

    await update.message.reply_text(
        f"🔓 تریگر خروج از قرنطینه «{unquarantine_trigger_word}» ثبت شد.\n"
        f"پیام خروج: {message}",
        parse_mode="HTML",
    )

async def list_triggers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    triggers = get_triggers(update.effective_chat.id)
    if not triggers:
        await update.message.reply_text("📭 هیچ تریگری ثبت نشده.")
        return

    msg = "📋 تریگرهای این گروه:\n\n"
    for t, d, m, type_, related_t_word in triggers:
        type_emoji = "✨"
        if type_ == 'ban':
            type_emoji = "🚫"
            if related_t_word:
                msg += f"{type_emoji} قرنطینه: {t} (خروج: {related_t_word}) → {d} ثانیه → «{m}»\n"
                continue
        elif type_ == 'unban':
            type_emoji = "✅"
        msg += f"{type_emoji} {t} (نوع: {type_}) → {d} ثانیه → «{m}»\n"
    await update.message.reply_text(msg, parse_mode="HTML")

async def clear_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    clear_triggers(update.effective_chat.id)
    await update.message.reply_text("🗑 تمام تریگرهای این گروه پاک شدند.")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.text:
        return

    text = update.message.text
    user_id = update.effective_user.id
    user_name = update.effective_user.full_name
    chat_id = update.effective_chat.id
    group_name = update.effective_chat.title or "Private"

    # --- Step 1: Check user's global quarantine status ---
    is_quarantined, quarantined_in_chat_id, awaiting_unban_trigger = get_user_global_quarantine_status(user_id)

    if is_quarantined:
        # User is in quarantine. Check if they sent the unquarantine trigger.
        if awaiting_unban_trigger and awaiting_unban_trigger.lower() in text.lower():
            # User sent the correct unquarantine trigger
            set_user_quarantine_status(user_id, False, None, None)  # Global unquarantine - اصلاح این خط
            logging.info(f"🔓 کاربر {user_name} با تریگر '{awaiting_unban_trigger}' از قرنطینه خارج شد.")
            await update.message.reply_text(f"🎉 شما با موفقیت از وضعیت قرنطینه خارج شدید!", reply_to_message_id=update.message.message_id)

            # Send the unquarantine message if defined for this chat
            unban_triggers_in_chat = [m for t, _, m, type_, _ in get_triggers(chat_id) if type_ == 'unban' and t.lower() == awaiting_unban_trigger.lower()]
            if unban_triggers_in_chat:
                await update.message.reply_text(unban_triggers_in_chat[0], parse_mode="HTML")

            return # Stop further processing, quarantine lifted.
        else:
            # User is quarantined and sent a message, but it's NOT the unquarantine trigger.
            # If they are not in the chat where they were quarantined, remove them from THIS group.
            if chat_id != quarantined_in_chat_id:
                logging.info(f"🚫 کاربر {user_name} در وضعیت قرنطینه است و در گروه {group_name} پیام فرستاد (که گروه قرنطینه نیست).")
                try:
                    # Remove from this group to enforce quarantine
                    await context.bot.ban_chat_member(chat_id, user_id)
                    await context.bot.unban_chat_member(chat_id, user_id) # Allow manual re-entry later
                    remove_membership(user_id, chat_id) # Also update our local membership
                    await update.message.reply_text(
                        f"⛔ شما در وضعیت قرنطینه هستید و اجازه فعالیت در این گروه را ندارید تا زمانی که تریگر خروج را بزنید: <b>{awaiting_unban_trigger}</b>",
                        parse_mode="HTML"
                    )
                    logging.info(f"✅ کاربر {user_name} به دلیل قرنطینه از گروه {group_name} حذف شد.")
                    return # Stop further processing for quarantined users trying to bypass.
                except Exception as e:
                    logging.error(f"❌ خطا در حذف کاربر قرنطینه {user_name} از {group_name}: {e}")
            else:
                # User is quarantined and sent a message in the *quarantine* chat, but not the unquarantine trigger.
                # Allow them to continue messaging in the quarantine chat, as they need to send the unquarantine trigger there.
                logging.info(f"💬 کاربر {user_name} در گروه قرنطینه پیام داد اما تریگر خروج نبود.")
                await update.message.reply_text(
                    f"⚠️ شما در قرنطینه هستید. برای خروج، تریگر <b>{awaiting_unban_trigger}</b> را ارسال کنید.",
                    parse_mode="HTML"
                )
                return # Prevent other triggers from firing if the user is in quarantine.

    # --- Step 2: Process normal messages and initiate quarantine if not already quarantined ---

    # ثبت عضویت در گروه
    add_membership(user_id, chat_id)

    # بررسی تریگرها
    triggers = get_triggers(chat_id)
    for trigger_word, delay, message, type_, related_trigger_word in triggers:
        if trigger_word.lower() in text.lower():
            if type_ == 'ban': # This is the quarantine trigger (e.g., #ورود)
                logging.info(f"🚨 تریگر قرنطینه '{trigger_word}' توسط {user_name} در گروه {group_name} فعال شد.")
                # Set user's global quarantine status
                set_user_quarantine_status(user_id, True, chat_id, related_trigger_word)

                # Send immediate info message
                info_text = (
                    f"👤 پلیر <b>{user_name}</b> به منطقه <b>{group_name}</b> وارد شد و به دلیل فعال کردن تریگر <b>«{trigger_word}»</b> به قرنطینه منتقل شد.\n\n"
                    f"⏱ مدت زمان سفر شما <b>{delay} ثانیه</b> می‌باشد تا به پیام اصلی برسید."
                )
                await update.message.reply_text(
                    info_text,
                    parse_mode="HTML",
                    reply_to_message_id=update.message.message_id,
                )

                # Remove user from all other groups where the bot is admin
                user_memberships_info = get_user_memberships_with_status(user_id) # Get all memberships, including their quarantine status
                for member_chat_id, _, _, _ in user_memberships_info:
                    if member_chat_id != chat_id: # If it's not the current (quarantine) chat
                        try:
                            bot_member = await context.bot.get_chat_member(member_chat_id, context.bot.id)
                            if bot_member.status in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
                                await context.bot.ban_chat_member(member_chat_id, user_id)
                                await context.bot.unban_chat_member(member_chat_id, user_id)
                                remove_membership(user_id, member_chat_id) # Also remove from our membership tracking
                                logging.info(f"✅ کاربر {user_name} از گروه {member_chat_id} (که خارج از قرنطینه است) حذف شد.")
                            else:
                                logging.warning(f"⚠️ بات توی گروه {member_chat_id} ادمین نیست، نمی‌تونه {user_name} رو حذف کنه.")
                        except Exception as e:
                            logging.error(f"❌ خطا در حذف {user_name} از {member_chat_id}: {e}")

                # Final message after delay in the quarantine chat
                async def delayed_reply_quarantine():
                    try:
                        await asyncio.sleep(delay)
                        await update.message.reply_text(
                            message, # This is the quarantine_message
                            parse_mode="HTML",
                            reply_to_message_id=update.message.message_id,
                        )
                        await update.message.reply_text(
                            f"برای خروج از قرنطینه، لطفاً تریگر <b>«{related_trigger_word}»</b> را ارسال کنید.",
                            parse_mode="HTML"
                        )
                    except Exception as e:
                        logging.error(e)

                asyncio.create_task(delayed_reply_quarantine())
                return # Stop processing further triggers for this message, quarantine initiated.

            elif type_ == 'normal':
                # Original normal trigger behavior
                logging.info(f"✨ تریگر عادی '{trigger_word}' توسط {user_name} فعال شد.")
                info_text = (
                    f"👤 پلیر <b>{user_name}</b> به منطقه <b>{group_name}</b> وارد شد.\n\n"
                    f"⏱ مدت زمان سفر شما <b>{delay} ثانیه</b> می‌باشد."
                )
                await update.message.reply_text(
                    info_text,
                    parse_mode="HTML",
                    reply_to_message_id=update.message.message_id,
                )

                async def delayed_reply_normal():
                    try:
                        await asyncio.sleep(delay)
                        await update.message.reply_text(
                            message,
                            parse_mode="HTML",
                            reply_to_message_id=update.message.message_id,
                        )
                    except Exception as e:
                        logging.error(e)

                asyncio.create_task(delayed_reply_normal())
                return # Stop processing further triggers for this message.

# ---------- اجرای ربات ----------
app = FastAPI()
application = Application.builder().token(BOT_TOKEN).build()

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
    data = await request.json()
    update = Update.de_json(data, application.bot)
    await application.process_update(update)
    return Response(status_code=200)

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/set-webhook")
async def set_webhook(request: Request):
    base_url = str(request.base_url).rstrip("/")
    await application.bot.set_webhook(url=f"{base_url}/webhook/{BOT_TOKEN}")
    return {"status": "set", "webhook": f"{base_url}/webhook/{BOT_TOKEN}"}