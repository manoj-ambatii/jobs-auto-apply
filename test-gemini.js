require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function testGemini() {
    console.log('🔍 Testing Gemini API Key integration...');
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey || apiKey.includes('your_gemini_api_key_here')) {
            console.error('❌ ERROR: GEMINI_API_KEY is missing or still set to the placeholder in .env');
            return;
        }
        console.log('✅ Found GEMINI_API_KEY in .env (Length: ' + apiKey.length + ')');
        
        const targetModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: targetModel });
        
        console.log(`🤖 Sending a test ping to ${targetModel}...`);
        const result = await model.generateContent("Reply with exactly one word: 'READY'");
        const responseText = result.response.text().trim();
        
        console.log(`✅ Success! Gemini responded with: "${responseText}"`);
        console.log('🚀 The Live AI Vision Agent is fully operational and ready to run.');
    } catch (err) {
        console.error('❌ ERROR connecting to Gemini API:');
        console.error(err.message);
    }
}

testGemini();
