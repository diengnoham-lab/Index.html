// ============================================================
// DisputeShield API — Rate Limited + Sanitized + Cost Protected
// ============================================================

// In-memory rate limiter (resets on cold start, but provides protection)
const dailyRequests = { count: 0, date: '' };
const ipTracker = new Map(); // IP -> { count, firstRequest }

const DAILY_LIMIT = 100;        // Max 100 requests/day total
const IP_FREE_LIMIT = 3;        // 3 free generations per IP
const IP_WINDOW_MS = 365 * 24 * 60 * 60 * 1000; // Effectively permanent per cold start

// Input sanitization
function sanitize(str, maxLen = 500) {
  if (!str || typeof str !== 'string') return '';
  return str
    .slice(0, maxLen)
    .replace(/<[^>]*>/g, '')                    // Strip HTML tags
    .replace(/[{}[\]]/g, '')                     // Strip brackets that could break JSON
    .replace(/\\/g, '')                          // Strip backslashes
    .replace(/\n{3,}/g, '\n\n')                 // Collapse excessive newlines
    .trim();
}

// Anti prompt-injection: strip any attempts to override system instructions
function sanitizePromptInput(str, maxLen = 500) {
  let clean = sanitize(str, maxLen);
  // Remove common prompt injection patterns
  const injectionPatterns = [
    /ignore (all |any )?(previous |prior |above )?instructions/gi,
    /disregard (all |any )?(previous |prior |above )?instructions/gi,
    /forget (all |any )?(previous |prior |above )?instructions/gi,
    /you are now/gi,
    /new instructions?:/gi,
    /system ?prompt/gi,
    /\[INST\]/gi,
    /\[SYSTEM\]/gi,
    /<\|im_start\|>/gi,
    /\bhuman:\s/gi,
    /\bassistant:\s/gi,
  ];
  for (const pattern of injectionPatterns) {
    clean = clean.replace(pattern, '[removed]');
  }
  return clean;
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

export default async function handler(req, res) {
  // CORS and method check
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // === DAILY GLOBAL RATE LIMIT (100/day) ===
  const today = getTodayStr();
  if (dailyRequests.date !== today) {
    dailyRequests.count = 0;
    dailyRequests.date = today;
  }
  if (dailyRequests.count >= DAILY_LIMIT) {
    return res.status(429).json({
      error: 'Daily limit reached. Service will reset at midnight UTC.',
      code: 'DAILY_LIMIT'
    });
  }

  // === PER-IP RATE LIMIT (3 free, then paywall) ===
  const clientIP = getClientIP(req);
  const isPro = req.headers['x-ds-token'] === 'pro_active'; // Simple pro check

  if (!isPro) {
    const ipData = ipTracker.get(clientIP) || { count: 0, firstRequest: Date.now() };
    if (ipData.count >= IP_FREE_LIMIT) {
      return res.status(402).json({
        error: 'Free limit reached. Upgrade to Pro for unlimited defenses.',
        code: 'FREE_LIMIT',
        used: ipData.count,
        limit: IP_FREE_LIMIT
      });
    }
    ipData.count++;
    ipTracker.set(clientIP, ipData);
  }

  // === REQUEST VALIDATION ===
  if (!req.body || !req.body.disputeData) {
    return res.status(400).json({ error: 'Missing dispute data' });
  }

  const raw = req.body.disputeData;

  // Validate required fields
  if (!raw.orderId || !raw.amount) {
    return res.status(400).json({ error: 'Order ID and amount are required' });
  }

  // Validate amount is numeric
  if (isNaN(parseFloat(raw.amount))) {
    return res.status(400).json({ error: 'Amount must be a valid number' });
  }

  // === SANITIZE ALL INPUTS ===
  const d = {
    processor: sanitize(raw.processor, 50),
    disputeType: sanitize(raw.disputeType, 50),
    orderId: sanitize(raw.orderId, 100),
    amount: parseFloat(raw.amount).toFixed(2),
    businessName: sanitizePromptInput(raw.businessName, 200),
    productDescription: sanitizePromptInput(raw.productDescription, 500),
    orderDate: sanitize(raw.orderDate, 20),
    customerName: sanitize(raw.customerName, 100),
    customerEmail: sanitize(raw.customerEmail, 100),
    shippingCarrier: sanitize(raw.shippingCarrier, 50),
    trackingNumber: sanitize(raw.trackingNumber, 100),
    shippingDate: sanitize(raw.shippingDate, 20),
    deliveryDate: sanitize(raw.deliveryDate, 20),
    refundPolicyURL: sanitize(raw.refundPolicyURL, 200),
    avsResult: sanitize(raw.avsResult, 20),
    cvvMatch: sanitize(raw.cvvMatch, 20),
    addressMatch: sanitize(raw.addressMatch, 10),
    customerIP: sanitize(raw.customerIP, 100),
    previousOrders: sanitizePromptInput(raw.previousOrders, 300),
    customerMessage: sanitizePromptInput(raw.customerMessage, 1000),
    extraInfo: sanitizePromptInput(raw.extraInfo, 1000)
  };

  // Validate dispute type
  const reasonCodes = {
    'Item Not Received': { visa: '13.1', mc: '4855', label: 'Merchandise/Services Not Received' },
    'Item Not as Described': { visa: '13.3', mc: '4853', label: 'Not as Described or Defective' },
    'Unauthorized Transaction': { visa: '10.4', mc: '4837', label: 'Fraud / Card-Absent Environment' },
    'Credit Not Processed': { visa: '13.6', mc: '4860', label: 'Credit Not Processed' }
  };

  const rc = reasonCodes[d.disputeType] || reasonCodes['Item Not Received'];

  // === BUILD PROMPT ===
  const prompt = `You are a senior chargeback defense analyst with 15+ years of experience winning disputes for e-commerce merchants against Visa, Mastercard, and all major payment processors. You have an expert-level understanding of Visa Claims Resolution (VCR), Mastercard Dispute Resolution, and the compelling evidence requirements for each reason code.

YOUR TASK: Generate a COMPLETE, PROFESSIONAL chargeback defense package that will WIN this dispute. This must follow the exact structure and legal standards that banks use to evaluate disputes.

=== DISPUTE INFORMATION ===
Payment Processor: ${d.processor}
Dispute Type: ${d.disputeType}
Visa Reason Code: ${rc.visa} (${rc.label})
Mastercard Reason Code: ${rc.mc}
Order ID: ${d.orderId}
Dispute Amount: $${d.amount}
Transaction/Order Date: ${d.orderDate || 'Not provided'}
Merchant Business Name: ${d.businessName || 'Not provided'}
Product/Service Description: ${d.productDescription || 'Not provided'}
Shipping Carrier: ${d.shippingCarrier || 'Not provided'}
Tracking Number: ${d.trackingNumber || 'Not provided'}
Shipping Date: ${d.shippingDate || 'Not provided'}
Delivery/Confirmation Date: ${d.deliveryDate || 'Not provided'}
Customer Name: ${d.customerName || 'Not provided'}
Customer Email: ${d.customerEmail || 'Not provided'}
Customer IP / Location: ${d.customerIP || 'Not provided'}
Billing Address matches Shipping: ${d.addressMatch || 'Not specified'}
AVS (Address Verification) Result: ${d.avsResult || 'Not provided'}
CVV/CVC Match: ${d.cvvMatch || 'Not provided'}
Customer's Claim: ${d.customerMessage || 'Not provided'}
Refund/Return Policy URL: ${d.refundPolicyURL || 'Not provided'}
Previous Orders by Same Customer: ${d.previousOrders || 'Not provided'}
Additional Merchant Notes: ${d.extraInfo || 'None'}

=== INSTRUCTIONS ===
Generate a JSON response with this EXACT structure. The defense letter MUST follow the formal structure below.

DEFENSE LETTER STRUCTURE (this is critical - banks evaluate based on this format):

1. HEADER: "MERCHANT CHARGEBACK REPRESENTMENT" with date, merchant name, case reference
2. RE: line with order ID, amount, reason code
3. OPENING: Formal statement that merchant is contesting the chargeback with reference to the specific reason code
4. TRANSACTION SUMMARY: Date, amount, product, customer info - proving the transaction was legitimate
5. REBUTTAL OF CARDHOLDER'S CLAIM: Point-by-point refutation using facts and evidence. Reference the specific Visa reason code ${rc.visa} requirements.
6. COMPELLING EVIDENCE PRESENTATION: Numbered list of each piece of evidence with explanation of what it proves. For reason code ${rc.visa}, the following evidence is particularly compelling:
${d.disputeType === 'Item Not Received' ? `   - Carrier tracking showing delivery confirmation with date/time
   - Proof delivery address matches billing/shipping address on file
   - Signed delivery confirmation (if available)
   - GPS delivery confirmation from carrier
   - Screenshot of tracking page showing "Delivered" status
   - Any post-delivery communication with customer` : ''}
${d.disputeType === 'Item Not as Described' ? `   - Original product listing/description matching what was sent
   - Photos of actual item shipped (if available)
   - Proof customer did not attempt return per merchant's return policy
   - Return policy that was disclosed at time of purchase
   - Any customer communication showing satisfaction or lack of return request
   - Quality control records or supplier certificates` : ''}
${d.disputeType === 'Unauthorized Transaction' ? `   - AVS (Address Verification System) match result
   - CVV/CVC verification match
   - 3D Secure authentication result (if applicable)
   - IP address and geolocation matching cardholder's known location
   - Device fingerprint or browser information
   - Previous successful orders from same card/email/device
   - Delivery to cardholder's verified address
   - Customer account login history` : ''}
${d.disputeType === 'Credit Not Processed' ? `   - Proof that refund was already processed with transaction ID and date
   - Refund policy clearly stating processing timeframes
   - Communication showing refund was acknowledged
   - Bank settlement records showing the credit
   - If no refund was due: proof that return conditions were not met` : ''}
7. POLICY REFERENCES: Merchant's return/refund policy, terms of service
8. LEGAL NOTICE: Reference to Visa Core Rules (specifically for ${rc.visa}) or Mastercard Chargeback Guide
9. CONCLUSION: Formal request to reverse the chargeback in merchant's favor
10. SIGNATURE BLOCK: Merchant name, title, date, contact

The letter must be 500-800 words, use formal legal/business tone, be specific (not generic), and reference actual evidence provided.

FOR THE EVIDENCE CHECKLIST: List SPECIFIC documents the merchant should gather and attach. Be precise - e.g., "Screenshot of carrier tracking page showing delivery on [date] to [address]" not just "delivery proof". Include exactly what ${d.processor} needs in their dispute portal.

FOR KEY ARGUMENTS: These should be the 4-5 strongest legal/factual points, each one referencing specific evidence. Frame them as "The cardholder claims X, however evidence shows Y."

FOR PRO TIPS: Give specific, actionable advice for this exact dispute type on ${d.processor}. Include submission deadlines, formatting tips, and what NOT to do.

FOR THE STRIPE/PAYPAL-SPECIFIC FIELDS: Generate the exact text that should go into each field of ${d.processor}'s dispute response form.

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "subject": "Merchant Representment - Order #${d.orderId} - $${d.amount} - Reason Code ${rc.visa}",
  "winProbability": <number 1-99 based on evidence strength>,
  "reasonCode": "${rc.visa}",
  "reasonCodeLabel": "${rc.label}",
  "letter": "<the full formal defense letter as described above, 500-800 words>",
  "keyArguments": ["<argument 1 with evidence reference>", "<argument 2>", "<argument 3>", "<argument 4>"],
  "evidenceChecklist": ["<specific document 1>", "<specific document 2>", "<specific document 3>", "<specific document 4>", "<specific document 5>", "<specific document 6>"],
  "tips": ["<specific tip 1 for ${d.processor}>", "<specific tip 2>", "<specific tip 3>"],
  "processorFields": {
    "product_description": "<text for product description field>",
    "customer_communication": "<summary of customer communications to paste>",
    "shipping_documentation": "<shipping evidence summary>",
    "refund_policy": "<refund policy text to paste>",
    "additional_evidence": "<any additional evidence text>"
  },
  "deadlineWarning": "<specific deadline info for ${d.processor} dispute response>"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    // Increment daily counter on success
    dailyRequests.count++;

    // Return remaining uses for free users
    const ipData = ipTracker.get(clientIP);
    const remaining = isPro ? 'unlimited' : (IP_FREE_LIMIT - (ipData ? ipData.count : 0));

    res.status(200).json({
      ...data,
      _meta: { remaining, isPro: !!isPro }
    });
  } catch (error) {
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
}
