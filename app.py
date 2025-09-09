# app.py
import os
import logging
import sqlite3
import asyncio
from typing import List, Tuple, Optional, Dict, Any

from fastapi import FastAPI, Request, Response
from telegram import Update
from telegram.constants import ParseMode, ChatMemberStatus
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
    Defaults,
)

# ---------- config ----------
BOT_TOKEN = os.environ.get("BOT_TOKEN")  # حتما در Render/محیط ست کن
if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN environment variable is not set!")

WEBHOOK_PATH = f"/webhook/{BOT_TOKEN}"

DB_FILE = "bot_settings.db"

# ---------- logging ----------
logging.basicConfig(
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# ---------- DB (sync helpers run in thread) ----------
def _init_db_sync():
    conn = sqlite3.connect(DB_FILE, timeout=30)
    try:
        cur = conn.cursor()
        # triggers: each (chat_id, trigger_text) unique
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS triggers (
                chat_id INTEGER NOT NULL,
                trigger_text TEXT NOT NULL,
                response_text TEXT DEFAULT '',
                delay_seconds INTEGER NOT NULL,
                PRIMARY KEY (chat_id, trigger_text)
            )
            """
        )
        # members: one row per user -> which chat the user currently belongs to (our policy)
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS members (
                user_id INTEGER PRIMARY KEY,
                chat_id INTEGER NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()

async def init_db():
    await asyncio.to_thread(_init_db_sync)

async def _db_execute(query: str, params: tuple = (), fetch: Optional[str] = None):
    def _run():
        conn = sqlite3.connect(DB_FILE, timeout=30)
        try:
            cur = conn.cursor()
            cur.execute(query, params)
            if fetch == "one":
                r = cur.fetchone()
            elif fetch == "all":
                r = cur.fetchall()
            else:
                conn.commit()
                r = None
            return r
        finally:
            conn.close()
    return await asyncio.to_thread(_run)

# trigger helpers
async def add_trigger(chat_id: int, trigger_text: str, delay_seconds: int, response_text: str = ""):
    await _db_execute(
        "REPLACE INTO triggers (chat_id, trigger_text, response_text, delay_seconds) VALUES (?, ?, ?, ?)",
        (chat_id, trigger_text, response_text, delay_seconds),
    )

async def list_triggers(chat_id: int) -> List[Tuple[str, str, int]]:
    rows = await _db_execute(
        "SELECT trigger_text, response_text, delay_seconds FROM triggers WHERE chat_id = ?",
        (chat_id,),
        fetch="all",
    )
    return rows or []

async def remove_trigger(chat_id: int, trigger_text: str):
    await _db_execute(
        "DELETE FROM triggers WHERE chat_id = ? AND trigger_text = ?",
        (chat_id, trigger_text),
    )

async def clear_triggers(chat_id: int):
    await _db_execute("DELETE FROM triggers WHERE chat_id = ?", (chat_id,))

# member helpers
async def set_member(user_id: int, chat_id: int):
    await _db_execute(
        "REPLACE INTO members (user_id, chat_id) VALUES (?, ?)",
        (user_id, chat_id),
    )

async def get_member_chat(user_id: int) -> Optional[int]:
    row = await _db_execute("SELECT chat_id FROM members WHERE user_id = ?", (user_id,), fetch="one")
    return row[0] if row else None

async def remove_member(user_id: int):
    await _db_execute("DELETE FROM members WHERE user_id = ?", (user_id,))

# ---------- bot helper ----------
async def is_user_admin(chat_id: int, user_id: int, context: ContextTypes.DEFAULT_TYPE) -> bool:
    try:
        member = await context.bot.get_chat_member(chat_id, user_id)
        return member.status in (ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER, ChatMemberStatus.CREATOR)
    except Exception as e:
        logger.exception("is_user_admin error: %s", e)
        return False

async def kick_user_once(chat_id: int, user_id: int, context: ContextTypes.DEFAULT_TYPE):
    """
    Kick a user (use ban+unban to simulate kick so they can rejoin).
    """
    try:
        # Ban then unban immediately -> acts like a kick.
        await context.bot.ban_chat_member(chat_id=chat_id, user_id=user_id)
        await context.bot.unban_chat_member(chat_id=chat_id, user_id=user_id)
        logger.info("Kicked user %s from chat %s", user_id, chat_id)
    except Exception as e:
        logger.exception("Failed to kick user %s from chat %s: %s", user_id, chat_id, e)

# ---------- job callback ----------
async def send_delayed_message(context: ContextTypes.DEFAULT_TYPE):
    data: Dict[str, Any] = context.job.data
    try:
        await context.bot.send_message(
            chat_id=data["chat_id"],
            text=data["text"],
            reply_to_message_id=data.get("reply_to_message_id"),
            parse_mode=ParseMode.HTML,
            disable_web_page_preview=True,
        )
        logger.info("Sent delayed message to chat %s", data["chat_id"])
    except Exception as e:
        logger.exception("Failed to send delayed message: %s", e)

# ---------- handlers ----------
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🤖 ربات آنلاین است (وبهوک).")

async def cmd_set(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat.type not in ("group", "supergroup"):
        await update.message.reply_text("این دستور فقط در گروه‌ها قابل استفاده است.")
        return
    if len(context.args) < 2:
        await update.message.reply_text("فرمت: /set <trigger> <delay_seconds> [response_text(optional)]")
        return
    trigger_text = context.args[0]
    try:
        delay_seconds = int(context.args[1])
    except ValueError:
        await update.message.reply_text("delay_seconds باید عدد صحیح باشد.")
        return
    response_text = " ".join(context.args[2:]) if len(context.args) > 2 else ""
    await add_trigger(update.effective_chat.id, trigger_text, delay_seconds, response_text)
    await update.message.reply_html(f"✅ ثبت شد: <code>{trigger_text}</code> — <b>{delay_seconds}s</b>\n{response_text}")

async def cmd_list(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat.type not in ("group", "supergroup"):
        return
    rows = await list_triggers(update.effective_chat.id)
    if not rows:
        await update.message.reply_text("هیچ تریگری ثبت نشده.")
        return
    lines = []
    for t, resp, d in rows:
        if resp:
            lines.append(f"• <code>{t}</code> — {d}s — {resp}")
        else:
            lines.append(f"• <code>{t}</code> — {d}s")
    await update.message.reply_html("📋 تریگرها:\n" + "\n".join(lines))

async def cmd_remove(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat.type not in ("group", "supergroup"):
        return
    if len(context.args) != 1:
        await update.message.reply_text("فرمت: /remove <trigger>")
        return
    await remove_trigger(update.effective_chat.id, context.args[0])
    await update.message.reply_text("✅ حذف شد (اگر وجود داشت).")

async def cmd_clearall(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat.type not in ("group", "supergroup"):
        return
    await clear_triggers(update.effective_chat.id)
    await update.message.reply_text("🧹 تمام تریگرها پاک شدند.")

# handle new chat members (when someone joins)
async def member_join_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # This handler is attached to filters.StatusUpdate.NEW_CHAT_MEMBERS
    if not update.message or not update.message.new_chat_members:
        return
    chat_id = update.effective_chat.id
    for member in update.message.new_chat_members:
        if member.is_bot:
            continue
        uid = member.id
        # if admin in this chat, ignore
        is_admin = await is_user_admin(chat_id, uid, context)
        if is_admin:
            # do not record admins
            continue
        existing_chat = await get_member_chat(uid)
        if existing_chat is None:
            await set_member(uid, chat_id)
            logger.info("Recorded member %s -> chat %s", uid, chat_id)
        elif existing_chat != chat_id:
            # user already belongs to another chat where bot is present -> remove from this one
            try:
                await kick_user_once(chat_id, uid, context)
                await context.bot.send_message(chat_id=chat_id, text=f"⛔ کاربر <b>{member.full_name}</b> امکان حضور همزمان در دو گروه را ندارد.", parse_mode=ParseMode.HTML)
            except Exception as e:
                logger.exception("Error removing user on join: %s", e)

# handle all text messages (triggers + #خروج logic)
async def message_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.text:
        return
    text = update.message.text
    chat_id = update.effective_chat.id
    user = update.effective_user
    uid = user.id
    name = user.full_name
    group_name = update.effective_chat.title or "Private"

    # if contains #خروج anywhere -> remove membership record so user can join elsewhere
    if "#خروج" in text:
        await remove_member(uid)
        await update.message.reply_text("✅ شما از لیست گروه‌های فعال حذف شدید. اکنون می‌توانید گروه دیگری را جوین کنید.")
        return

    # check admin status
    if await is_user_admin(chat_id, uid, context):
        # admins are exempt from membership check and triggers apply normally
        pass
    else:
        existing_chat = await get_member_chat(uid)
        if existing_chat is None:
            # first time seen -> record membership
            await set_member(uid, chat_id)
        elif existing_chat != chat_id:
            # user is recorded in another chat -> remove from this chat (kick), don't process further
            try:
                await kick_user_once(chat_id, uid, context)
                await update.message.reply_text(f"⛔️ {name} نمی‌تواند هم‌زمان در چند گروه باشد. از گروه حذف شد.")
            except Exception as e:
                logger.exception("Error kicking user on message: %s", e)
            return

    # triggers (match anywhere in message, case-insensitive)
    rows = await list_triggers(chat_id)
    for trigger_text, response_text, delay_seconds in rows:
        if trigger_text.lower() in text.lower():
            # build reply text: if admin provided response_text use it, otherwise default welcome/time message
            if response_text and response_text.strip():
                reply = response_text
            else:
                reply = f"👤 پلیر <b>{name}</b> به منطقه <b>{group_name}</b> وارد شد.\n\n⏱ مدت زمان سفر شما <b>{delay_seconds}</b> ثانیه می‌باشد."

            job_data = {
                "chat_id": chat_id,
                "text": reply,
                "reply_to_message_id": update.message.message_id,
            }

            # schedule delayed reply
            try:
                context.job_queue.run_once(send_delayed_message, delay_seconds, data=job_data)
                # immediate confirmation
                await update.message.reply_text(f"✅ پیام پس از {delay_seconds} ثانیه به عنوان ریپلای ارسال خواهد شد.")
            except Exception as e:
                logger.exception("Failed to schedule job: %s", e)
