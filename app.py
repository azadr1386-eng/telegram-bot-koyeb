import os
import logging
import aiosqlite
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
logger = logging.getLogger(__name__)

DB_FILE = "bot_settings.db"

# ---------- دیتابیس (نسخه Async) ----------
async def init_db():
    async with aiosqlite.connect(DB_FILE) as conn:
        await conn.execute("""CREATE TABLE IF NOT EXISTS triggers (
                chat_id INTEGER,
                trigger TEXT,
                delay INTEGER,
                message TEXT,
                type TEXT,
                PRIMARY KEY (chat_id, trigger)
            )""")
        await conn.execute("""CREATE TABLE IF NOT EXISTS memberships (
                user_id INTEGER,
                chat_id INTEGER,
                is_quarantined INTEGER DEFAULT 0,
                quarantined_in_chat_id INTEGER,
                PRIMARY KEY (user_id, chat_id)
            )""")
        await conn.commit()

async def add_trigger(chat_id: int, trigger: str, delay: int, message: str, type_: str = "normal"):
    async with aiosqlite.connect(DB_FILE) as conn:
        await conn.execute(
            "INSERT OR REPLACE INTO triggers (chat_id, trigger, delay, message, type) VALUES (?, ?, ?, ?, ?)",
            (chat_id, trigger, delay, message, type_),
        )
        await conn.commit()

async def get_triggers(chat_id: int):
    async with aiosqlite.connect(DB_FILE) as conn:
        cursor = await conn.execute(
            "SELECT trigger, delay, message, type FROM triggers WHERE chat_id = ?", (chat_id,)
        )
        return await cursor.fetchall()

async def clear_triggers(chat_id: int):
    async with aiosqlite.connect(DB_FILE) as conn:
        await conn.execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))
        await conn.commit()

async def add_membership(user_id: int, chat_id: int):
    async with aiosqlite.connect(DB_FILE) as conn:
        await conn.execute(
            "INSERT OR IGNORE INTO memberships (user_id, chat_id) VALUES (?, ?)",
            (user_id, chat_id),
        )
        await conn.commit()

async def get_memberships(user_id: int):
    async with aiosqlite.connect(DB_FILE) as conn:
        cursor = await conn.execute(
            "SELECT chat_id FROM memberships WHERE user_id = ?", (user_id,)
        )
        rows = await cursor.fetchall()
        return [row[0] for row in rows]

async def remove_membership(user_id: int, chat_id: int):
    async with aiosqlite.connect(DB_FILE) as conn:
        await conn.execute(
            "DELETE FROM memberships WHERE user_id = ? AND chat_id = ?",
            (user_id, chat_id),
        )
        await conn.commit()

async def set_user_quarantine_status(user_id: int, is_quarantined: bool, quarantined_in_chat_id: int = None):
    async with aiosqlite.connect(DB_FILE) as conn:
        if is_quarantined:
            await conn.execute(
                "UPDATE memberships SET is_quarantined = 1, quarantined_in_chat_id = ? WHERE user_id = ?",
                (quarantined_in_chat_id, user_id),
            )
        else:
            await conn.execute(
                "UPDATE memberships SET is_quarantined = 0, quarantined_in_chat_id = NULL WHERE user_id = ?",
                (user_id,),
            )
        await conn.commit()

async def get_user_quarantine_status(user_id: int):
    async with aiosqlite.connect(DB_FILE) as conn:
        cursor = await conn.execute(
            "SELECT is_quarantined, quarantined_in_chat_id FROM memberships WHERE user_id = ? AND is_quarantined = 1",
            (user_id,)
        )
        result = await cursor.fetchone()
        return result if result else (0, None)

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

    if len(context.args) < 3:
        await update.message.reply_text("❌ استفاده: /set <کلمه> <زمان> <پیام>")
        return

    trigger = context.args[0]
    try:
        delay = int(context.args[1])
    except ValueError:
        await update.message.reply_text("⏱ زمان باید عدد باشه")
        return

    message = " ".join(context.args[2:])
    await add_trigger(update.effective_chat.id, trigger, delay, message, "normal")

    await update.message.reply_text(
        f"✅ تریگر «{trigger}» (عادی) با تأخیر {delay} ثانیه ثبت شد.\n"
        f"📩 پیام ذخیره‌شده: {message}",
        parse_mode="HTML",
    )

async def set_trigger_ban(update: Update, context: ContextTypes.DEFAULT_TYPE):
    member = await context.bot.get_chat_member(
        update.effective_chat.id, update.effective_user.id
    )
    if member.status not in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
        await update.message.reply_text("❌ فقط ادمین‌ها میتونن تریگر ثبت کنن")
        return

    if len(context.args) < 3:
        await update.message.reply_text("❌ استفاده: /setban <کلمه> <زمان> <پیام>")
        return

    trigger = context.args[0]
    try:
        delay = int(context.args[1])
    except ValueError:
        await update.message.reply_text("⏱ زمان باید عدد باشه")
        return

    message = " ".join(context.args[2:])
    await add_trigger(update.effective_chat.id, trigger, delay, message, "ban")

    await update.message.reply_text(
        f"✅ تریگر «{trigger}» (بن) با تأخیر {delay} ثانیه ثبت شد.\n"
        f"📩 پیام ذخیره‌شده: {message}",
        parse_mode="HTML",
    )

async def list_triggers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    triggers = await get_triggers(update.effective_chat.id)
    if not triggers:
        await update.message.reply_text("📭 هیچ تریگری ثبت نشده.")
        return

    msg = "📋 تریگرهای این گروه:\n\n"
    for t, d, m, type_ in triggers:
        kind = "🔹عادی" if type_ == "normal" else "🔸بن"
        msg += f"• {t} ({kind}) → {d} ثانیه → «{m}»\n"

    await update.message.reply_text(msg, parse_mode="HTML")

async def clear_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await clear_triggers(update.effective_chat.id)
    await update.message.reply_text("🗑 تمام تریگرهای این گروه پاک شدند.")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.text:
        return

    text = update.message.text.lower()
    user_id = update.effective_user.id
    user_name = update.effective_user.full_name
    chat_id = update.effective_chat.id
    group_name = update.effective_chat.title or "Private"

    # بررسی وضعیت قرنطینه کاربر
    is_quarantined, quarantined_in_chat_id = await get_user_quarantine_status(user_id)

    # اگر کاربر #خروج بزند و در قرنطینه باشد
    if "#خروج" in text and is_quarantined:
        await set_user_quarantine_status(user_id, False)
        await update.message.reply_text(
            f"🎉 {user_name}، شما از قرنطینه خارج شدید و می‌توانید به گروه‌های دیگر بروید.",
            parse_mode="HTML",
        )
        return

    # اگر کاربر در قرنطینه است و در گروه دیگری پیام می‌دهد
    if is_quarantined and chat_id != quarantined_in_chat_id:
        try:
            # بررسی اینکه ربات ادمین است
            bot_member = await context.bot.get_chat_member(chat_id, context.bot.id)
            if bot_member.status in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
                await context.bot.ban_chat_member(chat_id, user_id)
                await context.bot.unban_chat_member(chat_id, user_id)
                await remove_membership(user_id, chat_id)
                await update.message.reply_text(
                    f"⛔ شما در وضعیت قرنطینه هستید و اجازه فعالیت در این گروه را ندارید. لطفاً از تریگر #خروج در گروه اصلی استفاده کنید.",
                    parse_mode="HTML"
                )
            else:
                logger.warning(f"⚠️ بات توی گروه {chat_id} ادمین نیست، نمی‌تونه کاربر قرنطینه رو حذف کنه")
        except Exception as e:
            logger.error(f"❌ خطا در حذف کاربر قرنطینه: {e}")
        return

    # ثبت عضویت در گروه
    await add_membership(user_id, chat_id)

    # بررسی تریگرها
    triggers = await get_triggers(chat_id)
    for trigger, delay, message, type_ in triggers:
        if trigger.lower() in text:
            # پیام فوری
            info_text = (
                f"👤 پلیر <b>{user_name}</b> به منطقه <b>{group_name}</b> وارد شد.\n\n"
                f"⏱ مدت زمان سفر شما <b>{delay} ثانیه</b> می‌باشد."
            )
            await update.message.reply_text(
                info_text,
                parse_mode="HTML",
                reply_to_message_id=update.message.message_id,
            )

            # اگر نوع = بن → کاربر رو از بقیه گروه‌ها حذف کن و قرنطینه کن
            if type_ == "ban":
                await set_user_quarantine_status(user_id, True, chat_id)
                
                groups = await get_memberships(user_id)
                logger.info(f"📌 کاربر {user_name} در گروه���های: {groups}")
                for g in groups:
                    if g != chat_id:
                        try:
                            # بررسی اینکه ربات در گروه ادمین است
                            bot_member = await context.bot.get_chat_member(g, context.bot.id)
                            if bot_member.status in [ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
                                await context.bot.ban_chat_member(g, user_id)
                                await context.bot.unban_chat_member(g, user_id)
                                await remove_membership(user_id, g)
                                logger.info(f"✅ کاربر {user_name} از گروه {g} حذف شد")
                            else:
                                logger.warning(f"⚠️ بات توی گروه {g} ادمین نیست، نمی‌تونه {user_name} رو حذف کنه")
                        except Exception as e:
                            logger.error(f"❌ خطا در حذف {user_name} از {g}: {e}")

            # پیام نهایی بعد از تاخیر
            async def delayed_reply():
                try:
                    await asyncio.sleep(delay)
                    await update.message.reply_text(
                        message,
                        parse_mode="HTML",
                        reply_to_message_id=update.message.message_id,
                    )
                except Exception as e:
                    logger.error(f"❌ خطا در ارسال پیام تأخیری: {e}")

            # ذخیره task برای مدیریت بهتر
            task = asyncio.create_task(delayed_reply())
            context.job_queue.run_once(lambda ctx: task, 0)  # اضافه کردن task به job_queue برای مدیریت بهتر

# ---------- اجرای ربات روی Render ----------
app = FastAPI()
application = (
    Application.builder()
    .token(BOT_TOKEN)
    .build()
)

# ذخیره tasks برای مدیریت بهتر
background_tasks = set()

application.add_handler(CommandHandler("start", start))
application.add_handler(CommandHandler("set", set_trigger))
application.add_handler(CommandHandler("setban", set_trigger_ban))
application.add_handler(CommandHandler("list", list_triggers))
application.add_handler(CommandHandler("clear", clear_all))
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

@app.on_event("startup")
async def on_startup():
    # راه‌اندازی دیتابیس
    await init_db()
    
    # راه‌اندازی ربات
    await application.initialize()
    await application.start()
    
    # تنظیم وب‌هوک
    webhook_url = f"https://{os.environ.get('RENDER_EXTERNAL_HOSTNAME')}/webhook/{BOT_TOKEN}"
    await application.bot.set_webhook(webhook_url)
    
    logger.info(f"🚀 Bot initialized. Webhook set to: {webhook_url}")

@app.on_event("shutdown")
async def on_shutdown():
    # لغو همه tasksهای در حال اجرا
    for task in background_tasks:
        task.cancel()
    
    # متوقف کردن ربات
    await application.stop()
    await application.shutdown()
    
    logger.info("🛑 Bot stopped.")

@app.post(f"/webhook/{BOT_TOKEN}")
async def telegram_webhook(request: Request):
    data = await request.json()
    update = Update.de_json(data, application.bot)
    
    # ایجاد task برای پردازش آپدیت
    task = asyncio.create_task(application.process_update(update))
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)
    
    return Response(status_code=200)

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/set-webhook")
async def set_webhook(request: Request):
    base_url = str(request.base_url).rstrip("/")
    webhook_url = f"{base_url}/webhook/{BOT_TOKEN}"
    await application.bot.set_webhook(webhook_url)
    return {"status": "set", "webhook": webhook_url}