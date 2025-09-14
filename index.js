const { Telegraf } = require('telegraf');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// بررسی وجود توکن ربات
if (!process.env.BOT_TOKEN) {
  console.error('❌ خطا: توکن ربات (BOT_TOKEN) در متغیرهای محیطی تنظیم نشده است');
  process.exit(1);
}

// ایجاد نمونه ربات
const bot = new Telegraf(process.env.BOT_TOKEN);

// هندلر دستور /start
bot.start((ctx) => {
  const firstName = ctx.from.first_name || 'کاربر';
  ctx.reply(`سلام ${firstName} ربات ارتباط لاین اکلیس فعاله ✅`);
});

// هندلر برای پیام‌های متنی معمولی
bot.on('text', (ctx) => {
  ctx.reply('دستور نامعتبر است. لطفا از /start استفاده کنید.');
});

// راه‌اندازی ربات
bot.launch()
  .then(() => {
    console.log('🤖 ربات تلگرام با موفقیت راه‌اندازی شد');
  })
  .catch((error) => {
    console.error('❌ خطا در راه‌اندازی ربات:', error);
  });

// راه‌اندازی سرور اکسپرس برای Render
app.get('/', (req, res) => {
  res.send('🤖 ربات تلگرام در حال اجراست!');
});

app.listen(PORT, () => {
  console.log(`🚀 سرور در حال اجرا روی پورت ${PORT}`);
});

// مدیریت خروج تمیز
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));