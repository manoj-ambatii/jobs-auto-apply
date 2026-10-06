const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const config = require('../../config');

/**
 * Live AI Vision Agent using Google Gemini
 * Analyzes the current page (DOM + Screenshot) and dictates the exact next action.
 */

async function askAiForNextAction(page, contextStr = '') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
        console.log('  [AI] ⚠️ GEMINI_API_KEY is not set in .env! Skipping Live AI Assistance.');
        return null;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: SchemaType.OBJECT,
                properties: {
                    action: { 
                        type: SchemaType.STRING, 
                        description: "One of: 'click', 'fill', 'wait', 'done', 'error'" 
                    },
                    target_id: { 
                        type: SchemaType.STRING,
                        description: "The data-ai-id of the target element from the provided DOM list"
                    },
                    value: { 
                        type: SchemaType.STRING,
                        description: "If action is 'fill', the text to type into the element"
                    },
                    reasoning: { 
                        type: SchemaType.STRING,
                        description: "Brief explanation of why this action was chosen"
                    }
                },
                required: ["action", "reasoning"]
            }
        }
    });

    try {
        // 1. Extract simplified interactive DOM and annotate it for the AI
        const interactiveDom = await page.evaluate(() => {
            let result = [];
            let id = 1;
            
            // Clean up any old AI attributes
            document.querySelectorAll('[data-ai-id]').forEach(el => el.removeAttribute('data-ai-id'));

            const elements = document.querySelectorAll('button, a, input, select, textarea, [role="button"]');
            for (const el of elements) {
                const rect = el.getBoundingClientRect();
                // Skip invisible elements
                if (rect.width === 0 || rect.height === 0 || el.disabled || getComputedStyle(el).visibility === 'hidden') {
                    continue;
                }
                
                // Assign a unique ID for the AI to reference
                const aiId = `ai-node-${id++}`;
                el.setAttribute('data-ai-id', aiId);

                const tag = el.tagName.toLowerCase();
                const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().substring(0, 100);
                
                result.push({ id: aiId, tag, text: text.replace(/\n/g, ' '), type: el.type || '' });
            }
            return result;
        });

        if (interactiveDom.length === 0) {
            console.log('  [AI] No interactive elements found on the page.');
            return null;
        }

        // 2. Take a screenshot to give the AI spatial awareness
        const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 50 });
        const screenshotBase64 = screenshotBuffer.toString('base64');

        // 3. Construct the precise prompt
        const prompt = `
You are an autonomous Job Application Assistant.
Your goal is to navigate the screen and advance the job application.

Candidate Profile: 
- Name: ${config.candidate.identity.name || 'Manoj Ambati'}
- Email: ${config.candidate.identity.email}
- Phone: ${config.candidate.identity.phone}
- Location: ${config.candidate.identity.city}, ${config.candidate.identity.country}
- Experience: ${config.candidate.currentEmployment.totalExperienceYears || 2.5} years in Java/Spring Boot
- Notice Period: ${config.candidate.compensationAndNotice.noticePeriodDays} days

Here is a list of interactive elements currently visible on the screen:
${JSON.stringify(interactiveDom, null, 2)}

Context/Previous State: ${contextStr || 'Fresh page'}

Look at the screenshot and the list of elements. Determine the single most important next action to take to advance the application (e.g., clicking a login button, selecting "Continue with Google", filling an email field). 

IMPORTANT RULES:
1. Always prefer clicking "Continue with Google" or "Sign in with Google" if it is available over entering emails/passwords.
2. If it is asking for an OTP, return action: "wait" (so our background script can fetch it).
3. Ensure the 'target_id' exactly matches an 'id' from the list above.

Return the JSON payload.
`;
        
        console.log('  [AI] 🤔 Asking Gemini 2.5 Flash what to do next...');
        const result = await model.generateContent([
            prompt, 
            { inlineData: { data: screenshotBase64, mimeType: 'image/jpeg' } }
        ]);

        const responseData = JSON.parse(result.response.text());
        console.log(`  [AI] 💡 Decision: [${responseData.action.toUpperCase()}] on target ${responseData.target_id || 'N/A'}`);
        console.log(`  [AI] 🧠 Reasoning: ${responseData.reasoning}`);
        
        return responseData;

    } catch (e) {
        console.error('  [AI] ❌ Error communicating with Gemini:', e.message);
        return null;
    }
}

/**
 * Executes the JSON instruction returned by Gemini via Playwright
 */
async function executeAiAction(page, actionObj) {
    if (!actionObj) return false;

    if (actionObj.action === 'wait') {
        console.log('  [AI] Action is "wait". Pausing for 5 seconds...');
        await new Promise(r => setTimeout(r, 5000));
        return true;
    }
    
    if (actionObj.action === 'done' || actionObj.action === 'error') {
        return false;
    }

    if (actionObj.target_id) {
        try {
            const locator = page.locator(`[data-ai-id="${actionObj.target_id}"]`).first();
            if (await locator.isVisible().catch(() => false)) {
                
                if (actionObj.action === 'click') {
                    // Force click in case it's covered by a label
                    await locator.click({ force: true });
                    console.log(`  [AI] ✅ Clicked element: ${actionObj.target_id}`);
                    return true;
                } 
                
                else if (actionObj.action === 'fill') {
                    await locator.fill(actionObj.value || '');
                    console.log(`  [AI] ✅ Filled element ${actionObj.target_id} with: "${actionObj.value}"`);
                    return true;
                }
            } else {
                console.log(`  [AI] ⚠️ Element ${actionObj.target_id} is no longer visible.`);
            }
        } catch (err) {
            console.log(`  [AI] ❌ Failed to execute action on ${actionObj.target_id}:`, err.message);
        }
    }
    
    return false;
}

module.exports = { askAiForNextAction, executeAiAction };
