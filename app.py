import os
import logging
import sqlite3
import asyncio
import json
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
                entities TEXT
            )""")
        cursor.execute("""CREATE TABLE IF NOT EXISTS memberships (
                user_id INTEGER,
                chat_id INTEGER,
                PRIMARY KEY (user_id, chat_id)
            )""")
        conn.commit()

init_db()

def add_trigger(chat_id: int, trigger: str, delay: int, message: str, entities):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "INSERT INTO triggers (chat_id, trigger, delay, message, entities) VALUES (?, ?, ?, ?, ?)",
            (chat_id, trigger, delay, message, json.dumps(entities) if entities else None),
        )
        conn.commit()

def get_triggers(chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        return conn.execute(
            "SELECT trigger, delay, message, entities FROM triggers WHERE chat_id = ?", (chat_id,)
        ).fetchall()

def clear_triggers(chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))
        conn.commit()

def add_membership(user_id: int, chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO memberships (user_id, chat_id) VALUES (?, ?)",
            (user_id, chat_id),
        )
        conn.commit()

def get_memberships(user_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        return [
            row[0]
            for row in conn.execute(
                "SELECT chat_id FROM memberships WHERE user_id = ?", (user_id,)
            ).fetchall()
        ]

def remove_membership(user_id: int, chat_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "DELETE FROM memberships WHERE user_id = ? AND chat_id = ?",
            (user_id, chat_id),
        )
        conn.commit()

# ---------- هندلرها ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ ربات روشنه و روی Render فعاله")

async def set_trigger(update: Update, context: ContextTypes.DEFAULT_TYPE):
    member = await context.bot.get_chat_member(
        update.effective_chat.id, update.effective_user.id
    )
    if member.status not in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
        await update.message.reply_text("❌ فقط ادمین‌ها میتونن تریگر ثبت کنن")
        return

    if len(context.args) < 2:
        await update.message.reply_text("❌ استفاده: /set <کلمه> <زمان>")
        return

    trigger = context.args[0]
    try:
        delay = int(context.args[1])
    except ValueError:
        await update.message.reply_text("⏱ زمان باید عدد باشه")
        return

    # متن و entities از خود پیام
    if update.message.reply_to_message:
        msg_obj = update.message.reply_to_message
    else:
        msg_obj = update.message

    message = " ".join(context.args[2:]) if len(context.args) > 2 else msg_obj.text_html or ""
    entities = msg_obj.to_dict().get("entities") or msg_obj.to_dict().get("caption_entities")

    add_trigger(update.effective_chat.id, trigger, delay, message, entities)
    await update.message.reply_text(
        f"✅ تریگر «{trigger}» با تأخیر {delay} ثانیه ثبت شد.\n"
        f"📩 پیام ذخیره‌شده: {message}"
    )

async def list_triggers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    triggers = get_triggers(update.effective_chat.id)
    if not triggers:
        await update.message.reply_text("📭 هیچ تریگری ثبت نشده.")
        return

    msg = "📋 تریگرهای این گروه:\n"
    for t, d, m, _ in triggers:
        msg += f"• {t} → {d} ثانیه → «{m}»\n"
    await update.message.reply_text(msg)

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

    # خروج
    if "#خروج" in text:
        await update.message.reply_text(f"👋 سفر به سلامت {user_name}")
        return

    # ثبت عضویت در گروه
    add_membership(user_id, chat_id)

    # بررسی تریگرها
    triggers = get_triggers(chat_id)
    for trigger, delay, message, entities in triggers:
        if trigger.lower() in text.lower():
            # پیام فوری
            info_text = (
                f"👤 پلیر <b>{user_name}</b> به منطقه <b>{group_name}</b> وارد شد.\n\n"
                f"⏱ مدت زمان سفر شما <b>{delay} ثانیه</b> می‌باشد."
            )
            await update.message.reply_text(
                info_text,
                parse_mode=ParseMode.HTML,
                reply_to_message_id=update.message.message_id,
            )

            # کاربر رو از بقیه گروه‌ها بنداز بیرون (به جز همین گروه)
            groups = get_memberships(user_id)
            for g in groups:
                if g != chat_id:
                    try:
                        await context.bot.ban_chat_member(g, user_id)
                        await context.bot.unban_chat_member(g, user_id)
                        remove_membership(user_id, g)
                    except Exception as e:
                        logging.error(e)

            # پیام نهایی بعد از تاخیر
            async def delayed_reply():
                try:
                    await asyncio.sleep(delay)
                    await update.message.reply_text(
                        message,
                        parse_mode=ParseMode.HTML,
                        entities=json.loads(entities) if entities else None,
                        reply_to_message_id=update.message.message_id,
                    )
                except Exception as e:
                    logging.error(e)

            asyncio.create_task(delayed_reply())

# ---------- اجرای ربات روی Render ----------
app = FastAPI()
application = Application.builder().token(BOT_TOKEN).build()

application.add_handler(CommandHandler("start", start))
application.add_handler(CommandHandler("set", set_trigger))
application.add_handler(CommandHandler("list", list_triggers))
application.add_handler(CommandHandler("clear", clear_all))
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

@app.on_event("startup")
async def on_startup():
    await application.initialize()
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
