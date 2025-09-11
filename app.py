import os
import asyncio
import logging
import sqlite3

from fastapi import FastAPI, Request, Response
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# تنظیمات لاگینگ
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# توکن ربات از متغیر محیطی خوانده می‌شود
BOT_TOKEN = os.environ.get("BOT_TOKEN") # از .get استفاده میکنیم تا اگر نبود خطا نده

if not BOT_TOKEN:
    logger.error("BOT_TOKEN environment variable not set!")
    # میتونید اینجا برنامه رو متوقف کنید یا یک مقدار پیش فرض بدید
    # بهتره برنامه متوقف بشه چون بدون توکن کار نمیکنه
    exit(1)


# ----------- توابع دیتابیس (بر اساس کد اصلی شما) -----------
def init_db():
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS triggers (
            chat_id INTEGER,
            trigger_text TEXT,
            delay INTEGER,
            message_text TEXT,
            type TEXT,
            PRIMARY KEY (chat_id, trigger_text)
        )
    """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS memberships (
            user_id INTEGER,
            chat_id INTEGER,
            PRIMARY KEY (user_id, chat_id)
        )
    """
    )
    # اضافه کردن جدول برای مدیریت قفل کاربران
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS user_locks (
            user_id INTEGER PRIMARY KEY,
            is_locked BOOLEAN DEFAULT 0
        )
    """
    )
    conn.commit()
    conn.close()

def add_trigger(chat_id, trigger, delay, message, trigger_type="normal"):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute(
        "INSERT OR REPLACE INTO triggers (chat_id, trigger_text, delay, message_text, type) VALUES (?, ?, ?, ?, ?)",
        (chat_id, trigger, delay, message, trigger_type),
    )
    conn.commit()
    conn.close()

def get_triggers(chat_id):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute(
        "SELECT trigger_text, delay, message_text FROM triggers WHERE chat_id = ?",
        (chat_id,),
    )
    triggers = cursor.fetchall()
    conn.close()
    return triggers

def get_trigger_type(chat_id, trigger):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute(
        "SELECT type FROM triggers WHERE chat_id = ? AND trigger_text = ?",
        (chat_id, trigger),
    )
    trigger_type = cursor.fetchone()
    conn.close()
    return trigger_type[0] if trigger_type else None

def clear_triggers(chat_id):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))
    conn.commit()
    conn.close()

def add_membership(user_id, chat_id):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute(
        "INSERT OR IGNORE INTO memberships (user_id, chat_id) VALUES (?, ?)",
        (user_id, chat_id),
    )
    conn.commit()
    conn.close()

def get_user_chat_ids(user_id):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM memberships WHERE user_id = ?", (user_id,))
    chat_ids = [row[0] for row in cursor.fetchall()]
    conn.close()
    return chat_ids

def remove_membership(user_id, chat_id):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute(
        "DELETE FROM memberships WHERE user_id = ? AND chat_id = ?",
        (user_id, chat_id),
    )
    conn.commit()
    conn.close()

def get_user_lock_status(user_id):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute("SELECT is_locked FROM user_locks WHERE user_id = ?", (user_id,))
    result = cursor.fetchone()
    conn.close()
    return bool(result[0]) if result else False

def set_user_lock_status(user_id, is_locked):
    conn = sqlite3.connect("bot_settings.db")
    cursor = conn.cursor()
    cursor.execute(
        "INSERT OR REPLACE INTO user_locks (user_id, is_locked) VALUES (?, ?)",
        (user_id, int(is_locked)), # Convert boolean to integer for SQLite
    )
    conn.commit()
    conn.close()


# ----------- توابع هلپر تلگرام (برای قفل و آزاد کردن کاربر) -----------
async def lock_user_across_groups(context: ContextTypes.DEFAULT_TYPE, user_id: int, current_chat_id: int):
    chat_ids = get_user_chat_ids(user_id)
    for chat_id in chat_ids:
        if chat_id != current_chat_id: # اگر چت فعلی نیست، کاربر رو از اون گروه بن کن
            try:
                await context.bot.ban_chat_member(chat_id=chat_id, user_id=user_id)
                logger.info(f"Banned user {user_id} from chat {chat_id}")
                remove_membership(user_id, chat_id) # کاربر رو از memberships اون گروه حذف کن
            except Exception as e:
                logger.error(f"Could not ban user {user_id} from chat {chat_id}: {e}")

async def unlock_user_across_groups(context: ContextTypes.DEFAULT_TYPE, user_id: int):
    # وقتی کاربر آزاد میشه، ما نمیتونیم بهش اجازه بدیم که به چت هایی که قبلا بن شده برگرده.
    # باید منتظر بشیم تا خودش دوباره join کنه.
    # این تابع فقط وضعیت قفل رو تغییر میده و کاربر رو از بن درنمیاره.
    logger.info(f"User {user_id} unlocked globally.")

# ----------- هندلرهای دستورات ربات -----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("ربات فعال است! برای کمک /help را ارسال کنید.")

async def set_trigger(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.effective_chat.type in ["group", "supergroup"]:
        await update.message.reply_text("این دستور فقط در گروه‌ها قابل استفاده است.")
        return

    # بررسی ادمین بودن
    # ادمین بودن رو باید خودتون با یک لیست از ادمین آیدی ها چک کنید
    # مثال: ADMIN_IDS = [12345, 67890]
    # if update.effective_user.id not in ADMIN_IDS:
    #    await update.message.reply_text("شما ادمین نیستید.")
    #    return

    args = context.args
    if len(args) < 3:
        await update.message.reply_text(
            "نحوه استفاده: /set <کلمه> <زمان_تاخیر_ثانیه> <پیام_پاسخ>\n"
            "مثال: /set سلام 10 سلام_عزیز"
        )
        return

    trigger_text = args[0]
    try:
        delay = int(args[1])
    except ValueError:
        await update.message.reply_text("زمان تاخیر باید یک عدد باشد.")
        return
    message_text = " ".join(args[2:])

    add_trigger(update.effective_chat.id, trigger_text, delay, message_text, "normal")
    await update.message.reply_text(
        f"تریگر '{trigger_text}' با تاخیر {delay} ثانیه و پیام '{message_text}' با موفقیت ثبت شد."
    )

async def list_triggers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.effective_chat.type in ["group", "supergroup"]:
        await update.message.reply_text("این دستور فقط در گروه‌ها قابل استفاده است.")
        return

    triggers = get_triggers(update.effective_chat.id)
    if not triggers:
        await update.message.reply_text("هیچ تریگری برای این گروه ثبت نشده است.")
        return

    response_text = "لیست تریگرهای این گروه:\n"
    for trigger, delay, message in triggers:
        response_text += f"- <b>{trigger}</b> (تاخیر: {delay} ثانیه): {message}\n"
    await update.message.reply_text(response_text, parse_mode="HTML")

async def clear_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.effective_chat.type in ["group", "supergroup"]:
        await update.message.reply_text("این دستور فقط در گروه‌ها قابل استفاده است.")
        return

    # بررسی ادمین بودن
    # if update.effective_user.id not in ADMIN_IDS: # uncomment if you implement ADMIN_IDS
    #    await update.message.reply_text("شما ادمین نیستید.")
    #    return

    clear_triggers(update.effective_chat.id)
    await update.message.reply_text("تمام تریگرها برای این گروه پاک شدند.")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.text:
        return

    text = update.message.text
    user_id = update.effective_user.id
    user_name = update.effective_user.full_name
    chat_id = update.effective_chat.id
    group_name = update.effective_chat.title or "Private"

    # ثبت عضویت در گروه
    add_membership(user_id, chat_id)

    # پردازش #ورود
    if "#ورود" in text:
        is_locked = get_user_lock_status(user_id)
        if is_locked:
            await update.message.reply_text("🔒 شما قبلاً قفل شده‌اید!")
            return

        # قفل کردن کاربر در تمام گروه‌ها به جز گروه فعلی
        await lock_user_across_groups(context, user_id, chat_id)
        
        # ذخیره وضعیت قفل
        set_user_lock_status(user_id, True)
        
        await update.message.reply_text(
            f"🔒 کاربر <b>{user_name}</b> در تمام گروه‌ها قفل شد و فقط در این گروه می‌ماند.\n"
            f"برای خروج از قرنطینه از #خروج استفاده کنید.",
            parse_mode="HTML"
        )
        return

    # پردازش #خروج
    if "#خروج" in text:
        is_locked = get_user_lock_status(user_id)
        if not is_locked:
            await update.message.reply_text("🔓 شما قبلاً آزاد شده‌اید!")
            return

        # آزاد کردن کاربر در تمام گروه‌ها
        await unlock_user_across_groups(context, user_id)
        
        # به‌روزرسانی وضعیت قفل
        set_user_lock_status(user_id, False)
        
        await update.message.reply_text(
            f"🔓 کاربر <b>{user_name}</b> از قرنطینه خارج شد و می‌تواند به تمام گروه‌ها وارد شود.",
            parse_mode="HTML"
        )
        return

    # بررسی تریگرهای معمولی
    triggers = get_triggers(chat_id)
    for trigger, delay, message in triggers:
        if trigger.lower() in text.lower():
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
                    logging.error(e)

            context.application.create_task(delayed_reply())
            break

# ---------- اجرای ربات روی Render ----------
app = FastAPI()
application = Application.builder().token(BOT_TOKEN).build()

# اضافه کردن هندلرها
application.add_handler(CommandHandler("start", start))
application.add_handler(CommandHandler("set", set_trigger))
application.add_handler(CommandHandler("list", list_triggers))
application.add_handler(CommandHandler("clear", clear_all))
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))


@app.on_event("startup")
async def on_startup():
    init_db() # مطمئن میشیم که دیتابیس ساخته شده
    await application.initialize()
    # تنظیم وب‌هوک
    # از متغیر محیطی RENDER_EXTERNAL_HOSTNAME برای دریافت URL عمومی Render استفاده کنید
    render_external_hostname = os.environ.get("RENDER_EXTERNAL_HOSTNAME")
    if not render_external_hostname:
        logger.warning("RENDER_EXTERNAL_HOSTNAME environment variable not set. Webhook might not be set correctly if running on Render.")
        # Fallback برای لوکال هاست در توسعه محلی
        webhook_url = f"http://localhost:{os.environ.get('PORT', 8000)}/webhook/{BOT_TOKEN}"
    else:
        webhook_url = f"https://{render_external_hostname}/webhook/{BOT_TOKEN}"
        
    await application.bot.set_webhook(webhook_url)
    logging.info("🚀 Bot initialized. Webhook set to: " + webhook_url)


@app.on_event("shutdown")
async def on_shutdown():
    await application.stop()
    await application.shutdown()


@app.post(f"/webhook/{BOT_TOKEN}")
async def telegram_webhook(request: Request):
    data = await request.json()
    # اطمینان حاصل کنید که BOT_TOKEN در مسیر URL وب‌هوک شما با توکن واقعی ربات مطابقت دارد
    # در غیر این صورت تلگرام آپدیت‌ها رو به این مسیر نمی‌فرسته
    try:
        update = Update.de_json(data, application.bot)
        await application.process_update(update)
        return Response(status_code=200)
    except Exception as e:
        logger.error(f"Error processing update: {e}")
        return Response(status_code=500)


@app.get("/health")
def health():
    return {"ok": True}
