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

    const targetModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: targetModel,
        generationConfig: {
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
        
        console.log(`  [AI] 🤔 Asking ${targetModel} to analyze the entire screen...`);
        
        let result;
        let retries = 3;
        while (retries > 0) {
            try {
                result = await model.generateContent([
                    prompt, 
                    { inlineData: { data: screenshotBase64, mimeType: 'image/jpeg' } }
                ]);
                break; // success
            } catch (apiErr) {
                if (apiErr.message.includes('503') || apiErr.message.includes('429')) {
                    retries--;
                    if (retries === 0) throw apiErr;
                    console.log(`  [AI] ⚠️ Gemini API Overloaded (503/429). Retrying in 10 seconds... (${retries} retries left)`);
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    throw apiErr;
                }
            }
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
