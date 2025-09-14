import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { Low, JSONFile } from "lowdb";

const app = express();
app.use(express.json());

// ----- تنظیمات -----
const TOKEN = process.env.BOT_TOKEN;
const URL = process.env.RENDER_EXTERNAL_URL; // از Environment Variables توی Render میاد
const PORT = process.env.PORT || 3000;
const bot = new TelegramBot(TOKEN, { webHook: { port: PORT } });

// ست کردن وبهوک
const WEBHOOK_URL = `${URL}/webhook/${TOKEN}`;
await bot.setWebHook(WEBHOOK_URL);

// دیتابیس سبک JSON
const adapter = new JSONFile("db.json");
const db = new Low(adapter);
await db.read();
db.data ||= { users: [], calls: [] };

// ----- ثبت شماره -----
bot.onText(/\/register (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const number = match[1];

  db.data.users.push({ id: chatId, number });
  await db.write();

  bot.sendMessage(chatId, `✅ شماره شما ثبت شد: ${number}`);
});

// ----- تماس -----
bot.onText(/\/call (.+)/, async (msg, match) => {
  const fromId = msg.chat.id;
  const number = match[1];

  const target = db.data.users.find(u => u.number === number);
  if (!target) {
    return bot.sendMessage(fromId, "❌ کاربر با این شماره پیدا نشد.");
  }

  const callId = Date.now();
  db.data.calls.push({ id: callId, from: fromId, to: target.id, status: "ringing" });
  await db.write();

  // پیام به گیرنده
  bot.sendMessage(target.id, `📞 تماس از طرف ${fromId}`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ جواب بده", callback_data: `answer_${callId}` },
          { text: "❌ رد کن", callback_data: `reject_${callId}` }
        ]
      ]
    }
  });

  // تایمر ۶۰ ثانیه
  setTimeout(async () => {
    const call = db.data.calls.find(c => c.id === callId);
    if (call && call.status === "ringing") {
      call.status = "missed";
      await db.write();
      bot.sendMessage(fromId, "📵 کاربر جواب نداد.");
      bot.sendMessage(target.id, "⏱ تماس از دست رفت.");
    }
  }, 60000);
});

// ----- جواب/رد -----
bot.on("callback_query", async (query) => {
  const [action, callId] = query.data.split("_");
  const call = db.data.calls.find(c => c.id == callId);

  if (!call) return;

  if (action === "answer") {
    call.status = "active";
    await db.write();
    bot.sendMessage(call.from, "☎️ تماس وصل شد! حالا پیام‌ها خصوصی بین شما رد و بدل میشه.");
    bot.sendMessage(call.to, "☎️ تماس وصل شد! حالا پیام‌ها خصوصی بین شما رد و بدل میشه.");

    // حالت «هاید»
    bot.on("message", (msg) => {
      if (msg.chat.id === call.from) {
        bot.sendMessage(call.to, `🔒 ${msg.text}`);
      } else if (msg.chat.id === call.to) {
        bot.sendMessage(call.from, `🔒 ${msg.text}`);
      }
    });
  }

  if (action === "reject") {
    call.status = "rejected";
    await db.write();
    bot.sendMessage(call.from, "❌ کاربر تماس را رد کرد.");
    bot.sendMessage(call.to, "🚫 تماس رد شد.");
  }

  bot.answerCallbackQuery(query.id);
});

// ----- وبهوک -----
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log("Bot running on Render 🚀"));
