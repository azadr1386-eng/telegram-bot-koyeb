import os
import logging
import sqlite3
import asyncio
from fastapi import FastAPI, Request, Response
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# ---------------- تنظیمات ----------------
BOT_TOKEN = os.environ.get("BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")
DB_FILE = "bot_settings.db"

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)

# ---------------- دیتابیس ----------------
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

# ---------------- توابع دیتابیس ----------------
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

# ---------------- هندلرها ----------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ ربات روشن و فعاله")

async def set_trigger_normal(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # TODO: پرکردن مثل نسخه‌ی قبلی
    await update.message.reply_text("📌 دستور set_trigger_normal اجرا شد")

async def set_trigger_quarantine(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # TODO: پرکردن مثل نسخه‌ی قبلی
    await update.message.reply_text("📌 دستور set_trigger_quarantine اجرا شد")

async def set_trigger_unquarantine(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # TODO: پرکردن مثل نسخه‌ی قبلی
    await update.message.reply_text("📌 دستور set_trigger_unquarantine اجرا شد")

async def list_triggers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    triggers = get_triggers(update.effective_chat.id)
    if not triggers:
        await update.message.reply_text("⛔️ هیچ تریگری ثبت نشده")
    else:
        text = "\n".join([f"{t[0]} → {t[2]}s → {t[1]}" for t in triggers])
        await update.message.reply_text(f"📋 لیست تریگرها:\n{text}")

async def clear_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    clear_triggers(update.effective_chat.id)
    await update.message.reply_text("✅ همه تریگرها پاک شد")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(f"پیامت دریافت شد: {update.message.text}")

# ---------------- اپلیکیشن تلگرام ----------------
def create_application():
    application = Application.builder().token(BOT_TOKEN).build()

    # اضافه کردن هندلرها
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("set", set_trigger_normal))
    application.add_handler(CommandHandler("setquarantine", set_trigger_quarantine))
    application.add_handler(CommandHandler("setunquarantine", set_trigger_unquarantine))
    application.add_handler(CommandHandler("list", list_triggers))
    application.add_handler(CommandHandler("clear", clear_all))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    return application

telegram_app = create_application()

# ---------------- اپلیکیشن FastAPI ----------------
app = FastAPI()

@app.get("/")
async def root():
    return {"status": "ok", "message": "Bot is running on Render"}

# ---------------- اجرای همزمان ----------------
async def run_bot():
    await telegram_app.run_polling(close_loop=False)

@app.on_event("startup")
async def on_startup():
    asyncio.create_task(run_bot())
