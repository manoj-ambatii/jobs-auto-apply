const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const config = require('../../config');

/**
 * Pure Live AI Vision Agent using Google Gemini 3.8 Flash
 * Analyzes the entire page and returns a list of actions to perform.
 */

async function askAiForNextAction(page, contextStr = '') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
        console.log('  [AI] ⚠️ GEMINI_API_KEY is not set in .env! Cannot run AI Agent.');
        return null;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Base configuration for structured JSON output
    const generationConfig = {
        responseMimeType: "application/json",
        responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
                reasoning: { 
                    type: SchemaType.STRING,
                    description: "Explain what this screen is and your overall plan for it"
                },
                actions: {
                    type: SchemaType.ARRAY,
                    description: "List of actions to perform on this screen in order",
                    items: {
                        type: SchemaType.OBJECT,
                        properties: {
                            action: { 
                                type: SchemaType.STRING, 
                                description: "One of: 'click', 'fill', 'upload_resume', 'fetch_otp', 'done', 'error'" 
                            },
                            target_id: { 
                                type: SchemaType.STRING,
                                description: "The data-ai-id of the target element (e.g. ai-node-3). Required for click and fill."
                            },
                            value: { 
                                type: SchemaType.STRING,
                                description: "If action is 'fill', the exact text to type into the element"
                            }
                        },
                        required: ["action"]
                    }
                }
            },
            required: ["reasoning", "actions"]
        }
    };

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
        }

        // 2. Take a screenshot to give the AI spatial awareness
        const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 50 });
        const screenshotBase64 = screenshotBuffer.toString('base64');

        // 3. Construct the precise prompt
        const prompt = `
You are an autonomous Job Application Assistant navigating a company career site.
Your goal is to process the CURRENT SCREEN by providing an array of actions to fill out fields, click buttons, or handle dialogs.

Candidate Profile: 
- First Name: ${config.candidate.identity.firstName || 'Manoj'}
- Last Name: ${config.candidate.identity.lastName || 'Ambati'}
- Full Name: ${config.candidate.identity.name || 'Manoj Ambati'}
- Email: ${config.candidate.identity.email}
- Phone: ${config.candidate.identity.phone}
- Location: ${config.candidate.identity.city}, ${config.candidate.identity.country}
- Experience: ${config.candidate.currentEmployment.totalExperienceYears || 2.5} years in Java/Spring Boot
- Notice Period: ${config.candidate.compensationAndNotice.noticePeriodDays} days
- Current CTC: ${config.candidate.compensationAndNotice.currentCtcLakhs} LPA
- Expected CTC: ${config.candidate.compensationAndNotice.expectedCtcLakhs} LPA
- Education: ${config.candidate.education.degree} in ${config.candidate.education.branch} from ${config.candidate.education.institution}

Visible Interactive Elements:
${JSON.stringify(interactiveDom, null, 2)}

Context/Previous State: ${contextStr || 'Fresh page'}

IMPORTANT RULES:
1. You can return MULTIPLE actions in the 'actions' array to fill out an entire form at once.
2. If the screen has a file input for a Resume/CV, include {"action": "upload_resume"}.
3. If the screen asks for an OTP/Verification code sent to email/phone, include {"action": "fetch_otp"}.
4. Always prefer clicking "Continue with Google" or "Sign in with Google" if available over creating manual accounts.
5. If the application is confirmed as successfully submitted, include {"action": "done"}.
6. Ensure the 'target_id' exactly matches an 'id' from the list above.

Evaluate the screenshot and the DOM. Return your reasoning and the array of actions to perform.
`;
        
        const fallbackModels = [
            'gemini-3.8-flash',
            'gemini-3.7-flash',
            'gemini-3.5-flash',
            'gemini-3.5-flash-lite',
            'gemini-3.1-pro-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'gemini-pro-vision'
        ];
        const userModel = process.env.GEMINI_MODEL;
        const modelsToTry = userModel ? [userModel, ...fallbackModels] : fallbackModels;
        const uniqueModels = [...new Set(modelsToTry)];
        
        let result;
        let success = false;
        let finalErr = null;

        for (const currentModel of uniqueModels) {
            console.log(`  [AI] 🤔 Asking ${currentModel} to analyze the entire screen...`);
            const model = genAI.getGenerativeModel({ model: currentModel, generationConfig });
            
            let retries = 2; // Overload retries per model
            while (retries > 0) {
                try {
                    result = await model.generateContent([
                        prompt, 
                        { inlineData: { data: screenshotBase64, mimeType: 'image/jpeg' } }
                    ]);
                    success = true;
                    break;
                } catch (apiErr) {
                    finalErr = apiErr;
                    if (apiErr.message.includes('404')) {
                        console.log(`  [AI] ⚠️ Model ${currentModel} is unavailable/deprecated (404). Cascading to next model...`);
                        break; // Break retry loop to switch model
                    } else if (apiErr.message.includes('503') || apiErr.message.includes('429')) {
                        retries--;
                        if (retries === 0) {
                            console.log(`  [AI] ⚠️ Model ${currentModel} is severely overloaded. Cascading to next model...`);
                            break; 
                        }
                        console.log(`  [AI] ⚠️ ${currentModel} Overloaded (503/429). Retrying in 5 seconds...`);
                        await new Promise(r => setTimeout(r, 5000));
                    } else {
                        console.log(`  [AI] ❌ Unexpected error with ${currentModel}: ${apiErr.message}. Cascading to next model...`);
                        break;
                    }
                }
            }
            if (success) break;
        }

        if (!success) {
            throw new Error(`All Gemini models failed or were unavailable. Last error: ${finalErr?.message}`);
        }

        const responseData = JSON.parse(result.response.text());
        console.log(`  [AI] 🧠 Reasoning: ${responseData.reasoning}`);
        console.log(`  [AI] ⚡ Planned Actions: ${responseData.actions.length}`);
        
        return responseData;

    } catch (e) {
        console.error('  [AI] ❌ Error communicating with Gemini:', e.message);
        return null;
    }
}

/**
 * Executes a single AI action via Playwright
 */
async function executeAiAction(page, actionObj) {
    if (!actionObj) return false;
    
    if (actionObj.target_id) {
        try {
            const locator = page.locator(`[data-ai-id="${actionObj.target_id}"]`).first();
            if (await locator.isVisible().catch(() => false)) {
                
                if (actionObj.action === 'click') {
                    await locator.click({ force: true });
                    console.log(`  [AI] ✅ Clicked element: ${actionObj.target_id}`);
                    return true;
                } 
                
                else if (actionObj.action === 'fill') {
                    // Bypass react event issues
                    await locator.click({ force: true }).catch(()=>{});
                    await locator.fill(actionObj.value || '');
                    console.log(`  [AI] ✅ Filled element ${actionObj.target_id} with: "${actionObj.value}"`);
                    return true;
                }
            } else {
                console.log(`  [AI] ⚠️ Element ${actionObj.target_id} is not visible.`);
            }
        } catch (err) {
            console.log(`  [AI] ❌ Failed to execute action on ${actionObj.target_id}:`, err.message);
        }
    }
    
    return false;
}

module.exports = { askAiForNextAction, executeAiAction };
