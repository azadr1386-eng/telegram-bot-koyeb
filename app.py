import os
import logging
import sqlite3
from fastapi import FastAPI, Request
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
WEBHOOK_PATH = f"/webhook/{BOT_TOKEN}"
WEBHOOK_URL = os.environ.get("WEBHOOK_URL")  # مثل https://your-app.onrender.com/webhook/<BOT_TOKEN>

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
def get_triggers(chat_id):
    with sqlite3.connect(DB_FILE) as conn:
        return conn.execute(
            "SELECT trigger, delay, message, type, related_trigger_word FROM triggers WHERE chat_id = ?", (chat_id,)
        ).fetchall()

def clear_triggers(chat_id):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))
        conn.commit()

# ---------------- هندلرها ----------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ ربات با وبهوک روی Render فعاله")

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
telegram_app = (
    Application.builder()
    .token(BOT_TOKEN)
    .build()
)

telegram_app.add_handler(CommandHandler("start", start))
telegram_app.add_handler(CommandHandler("list", list_triggers))
telegram_app.add_handler(CommandHandler("clear", clear_all))
telegram_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

# ---------------- اپلیکیشن FastAPI ----------------
app = FastAPI()

@app.get("/")
async def root():
    return {"status": "ok", "message": "Bot is running on Render with Webhook"}

@app.post(WEBHOOK_PATH)
async def telegram_webhook(req: Request):
    data = await req.json()
    update = Update.de_json(data, telegram_app.bot)
    await telegram_app.process_update(update)
    return {"ok": True}

# ---------------- استارتاپ ----------------
@app.on_event("startup")
async def on_startup():
    # تنظیم وبهوک روی تلگرام
    if WEBHOOK_URL:
        await telegram_app.bot.set_webhook(url=WEBHOOK_URL + WEBHOOK_PATH)
        logging.info(f"Webhook set to {WEBHOOK_URL}{WEBHOOK_PATH}")
