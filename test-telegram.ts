import { Bot } from 'grammy';
import dns from 'dns';

dns.setDefaultResultOrder('ipv4first');
const token = "REDACTED_TOKEN";
const bot = new Bot(token);

console.log("Starting test bot...");

bot.command("start", (ctx) => ctx.reply("Test started!"));
bot.on("message", (ctx) => {
    console.log("Received message:", ctx.message.text);
    ctx.reply("I hear you!");
});

bot.start({
    onStart: (botInfo) => {
        console.log("Bot started as", botInfo.username);
    }
}).catch(err => {
    console.error("Bot failed to start:", err);
});
