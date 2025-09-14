const TelegramBot = require('node-telegram-bot-api');
const config = require('./config.json');

const bot = new TelegramBot(config.botToken);

async function setWebhook() {
  try {
    // حذف وب‌هاک قبلی (اختیاری)
    await bot.deleteWebHook();
    
    // تنظیم وب‌هاک جدید
    const result = await bot.setWebHook(config.webhookUrl, {
      certificate: {
        source: config.sslCertPath
      }
    });
    
    console.log('Webhook set successfully:', result);
    
    // دریافت اطلاعات وب‌هاک
    const webhookInfo = await bot.getWebHookInfo();
    console.log('Webhook info:', webhookInfo);
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
}

setWebhook();