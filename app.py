import os
import logging
import sqlite3
from fastapi import FastAPI, Request, Response
from telegram import Update
from telegram.constants import ParseMode, ChatMemberStatus
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# -------- تنظیمات --------
BOT_TOKEN = os.environ["BOT_TOKEN"]
WEBHOOK_PATH = f"/webhook/{BOT_TOKEN}"

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)

DB_FILE = "bot_settings.db"


# -------- دیتابیس --------
def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """CREATE TABLE IF NOT EXISTS triggers (
                chat_id INTEGER,
                trigger TEXT,
                delay INTEGER
            )"""
        )
        cursor.execute(
            """CREATE TABLE IF NOT EXISTS exits (
                user_id INTEGER PRIMARY KEY
            )"""
        )
        cursor.execute(
            """CREATE TABLE IF NOT EXISTS memberships (
                user_id INTEGER,
                chat_id INTEGER,
                UNIQUE(user_id, chat_id)
            )"""
        )
        conn.commit()


init_db()


def add_trigger(chat_id: int, trigger: str, delay: int):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO triggers (chat_id, trigger, delay) VALUES (?, ?, ?)",
            (chat_id, trigger, delay),
        )
        conn.commit()


def get_triggers(chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT trigger, delay FROM triggers WHERE chat_id = ?", (chat_id,))
        return cursor.fetchall()


def clear_triggers(chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))
        conn.commit()


def add_exit(user_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO exits (user_id) VALUES (?)", (user_id,))
        conn.commit()


def has_exit(user_id: int) -> bool:
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM exits WHERE user_id = ?", (user_id,))
        return cursor.fetchone() is not None


def add_membership(user_id: int, chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR IGNORE INTO memberships (user_id, chat_id) VALUES (?, ?)",
            (user_id, chat_id),
        )
        conn.commit()


def get_memberships(user_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT chat_id FROM memberships WHERE user_id = ?", (user_id,))
        return [row[0] for row in cursor.fetchall()]


def clear_membership(user_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM memberships WHERE user_id = ?", (user_id,))
        conn.commit()


# -------- هندلرها --------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ ربات روشنه و روی وبهوک فعاله.")


async def set_trigger(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) < 2:
        await update.message.reply_text("❌ استفاده: /set <کلمه> <زمان>")
        return
    trigger = context.args[0]
    try:
        delay = int(context.args[1])
    except ValueError:
        await update.message.reply_text("⏱ زمان باید عدد باشه")
        return

    add_trigger(update.effective_chat.id, trigger, delay)
    await update.message.reply_text(f"✅ تریگر «{trigger}» با تأخیر {delay} ثانیه ثبت شد.")


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

    # --- ذخیره عضویت کاربر در گروه ---
    add_membership(user_id, chat_id)

    # --- اگر توی متن #خروج باشه ---
    if "#خروج" in text:
        add_exit(user_id)
        clear_membership(user_id)
        await update.message.reply_text(f"👋 {user_name} از محدودیت خارج شد.")
        return

    # --- بررسی همزمانی در چند گروه ---
    if not has_exit(user_id):
        memberships = get_memberships(user_id)
        if len(memberships) > 1:
            member_status = await context.bot.get_chat_member(chat_id, user_id)
            if member_status.status not in [
                ChatMemberStatus.ADMINISTRATOR,
                ChatMemberStatus.OWNER,
            ]:
                try:
                    await context.bot.ban_chat_member(chat_id, user_id)
                    await context.bot.unban_chat_member(chat_id, user_id)  # ✅ فقط کیک
                    clear_membership(user_id)
                    await update.message.reply_text(f"🚫 {user_name} به خاطر حضور در چند گروه ریموو شد.")
                except Exception as e:
                    logging.error(e)
            return

    # --- تریگرها ---
    triggers = get_triggers(chat_id)
    for trigger, delay in triggers:
        if trigger.lower() in text.lower():
            reply_text = (
                f"👤 پلیر <b>{user_name}</b> به منطقه <b>{group_name}</b> وارد شد.\n\n"
                f"⏱ مدت زمان سفر شما <b>{delay} ثانیه</b> می‌باشد."
            )

            async def delayed_reply(ctx: ContextTypes.DEFAULT_TYPE):
                await update.message.reply_text(
                    reply_text,
                    parse_mode=ParseMode.HTML,
                    reply_to_message_id=update.message.message_id,
                )

            context.job_queue.run_once(delayed_reply, delay)


# -------- اپ تلگرام --------
application = Application.builder().token(BOT_TOKEN).build()
application.add_handler(CommandHandler("start", start))
application.add_handler(CommandHandler("set", set_trigger))
application.add_handler(CommandHandler("clear", clear_all))
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

# -------- اپ FastAPI --------
app = FastAPI()


@app.on_event("startup")
async def on_startup():
    await application.initialize()
    await application.start()


@app.on_event("shutdown")
async def on_shutdown():
    await application.stop()
    await application.shutdown()


@app.post(WEBHOOK_PATH)
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
    await application.bot.set_webhook(url=f"{base_url}{WEBHOOK_PATH}")
    return {"status": "set", "webhook": f"{base_url}{WEBHOOK_PATH}"}
