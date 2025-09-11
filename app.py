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

# ---------- توابع دیتابیس ----------
def add_trigger(chat_id, trigger, delay, message, type_="normal", related_trigger_word=None):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "INSERT INTO triggers (chat_id, trigger, delay, message, type, related_trigger_word) VALUES (?, ?, ?, ?, ?, ?)",
            (chat_id, trigger, delay, message, type_, related_trigger_word),
        )
        conn.commit()

def get_triggers(chat_id):
    with sqlite3.connect(DB_FILE) as conn:
        return conn.execute(
            "SELECT trigger, delay, message, type, related_trigger_word FROM triggers WHERE chat_id = ?", (chat_id,)
        ).fetchall()

def clear_triggers(chat_id):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))
        conn.commit()

def add_membership(user_id, chat_id):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("INSERT OR IGNORE INTO memberships (user_id, chat_id) VALUES (?, ?)", (user_id, chat_id))
        conn.commit()

def get_user_memberships_with_status(user_id):
    with sqlite3.connect(DB_FILE) as conn:
        return conn.execute(
            "SELECT chat_id, is_quarantined, quarantined_in_chat_id, awaiting_unban_trigger FROM memberships WHERE user_id = ?", (user_id,)
        ).fetchall()

def remove_membership(user_id, chat_id):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM memberships WHERE user_id = ? AND chat_id = ?", (user_id, chat_id))
        conn.commit()

def set_user_quarantine_status(user_id, is_quarantined, quarantined_in_chat_id=None, awaiting_unban_trigger=None):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "UPDATE memberships SET is_quarantined = ?, quarantined_in_chat_id = ?, awaiting_unban_trigger = ? WHERE user_id = ?",
            (1 if is_quarantined else 0, quarantined_in_chat_id, awaiting_unban_trigger, user_id),
        )
        conn.commit()

def get_user_global_quarantine_status(user_id):
    with sqlite3.connect(DB_FILE) as conn:
        result = conn.execute(
            "SELECT is_quarantined, quarantined_in_chat_id, awaiting_unban_trigger FROM memberships WHERE user_id = ? AND is_quarantined = 1 LIMIT 1",
            (user_id,)
        ).fetchone()
        return result if result else (0, None, None)

# ---------- هندلرها ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ ربات روشنه و فعاله")

async def set_trigger_normal(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # ... (مثل نسخه قبل، بدون تغییر)
    pass

async def set_trigger_quarantine(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # ... (مثل نسخه قبل، بدون تغییر)
    pass

async def set_trigger_unquarantine(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # ... (مثل نسخه قبل، بدون تغییر)
    pass

async def list_triggers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # ... (مثل نسخه قبل، بدون تغییر)
    pass

async def clear_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # ... (مثل نسخه قبل، بدون تغییر)
    pass

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # ... (مثل نسخه قبل، بدون تغییر)
    pass

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

# ---------- مدیریت lifecycle ----------
@app.on_event("startup")
async def on_startup():
    await application.initialize()
    await application.start()  # 🔥 اضافه شد
    logging.info("🚀 Bot initialized. Waiting for webhook events...")

@app.on_event("shutdown")
async def on_shutdown():
    await application.stop()     # 🔥 اضافه شد
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
        webhook_url = f"{base_url}/webhook/{BOT_TOKEN}"
        await application.bot.set_webhook(url=webhook_url)
        return {"status": "set", "webhook": webhook_url}
    except Exception as e:
        logging.error(f"خطا در set-webhook: {e}")
        return {"status": "error", "message": str(e)}
