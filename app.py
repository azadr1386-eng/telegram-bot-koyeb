import os
import asyncio
import logging
from fastapi import FastAPI
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

# ---------------- تنظیمات ----------------
BOT_TOKEN = os.environ.get("BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")

logging.basicConfig(level=logging.INFO)

# ---------------- هندلرهای ربات ----------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ ربات روشن و فعال است!")

# ساخت اپلیکیشن تلگرام
telegram_app = Application.builder().token(BOT_TOKEN).build()
telegram_app.add_handler(CommandHandler("start", start))

# ---------------- اپلیکیشن FastAPI ----------------
app = FastAPI()

@app.get("/")
async def root():
    return {"status": "ok", "message": "Bot is running on Render"}

# اجرای ربات در بک‌گراند
async def run_bot():
    await telegram_app.run_polling(close_loop=False)

@app.on_event("startup")
async def on_startup():
    asyncio.create_task(run_bot())
