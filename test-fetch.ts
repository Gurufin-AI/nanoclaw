import dns from 'dns';
import fetch from 'node-fetch';

dns.setDefaultResultOrder('ipv4first');

async function test() {
    console.log("Testing direct fetch to Telegram API...");
    try {
        const res = await fetch("https://api.telegram.org/botREDACTED_TOKEN/getMe");
        console.log("Status:", res.status);
        const data = await res.json();
        console.log("Data:", JSON.stringify(data));
    } catch (err) {
        console.error("Fetch failed:", err);
    }
}

test();
