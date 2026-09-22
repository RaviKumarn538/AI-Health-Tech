const fs = require('fs');
const path = require('path');
require('dotenv').config();
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('Set OPENROUTER_API_KEY in .env before running this diagnostic.');
const imgPath = path.join(__dirname, '..', 'sample_files', 'sample_prescription_cardiology.png');
const imgBytes = fs.readFileSync(imgPath);
const dataUrl = `data:image/png;base64,${imgBytes.toString('base64')}`;

async function testMultimodal(model) {
  console.log(`\nTesting OpenRouter image extraction with model: ${model}`);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:8080',
        'X-Title': 'CuraClinic AI'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extract patient name, date, and list of medications from this clinical document image as JSON. Output only valid JSON.' },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1
      })
    });

    console.log(`Status for ${model}:`, res.status, res.statusText);
    const data = await res.json();
    if (res.ok) {
      console.log(`SUCCESS! Response:`);
      console.log(data.choices?.[0]?.message?.content?.substring(0, 400));
      return true;
    } else {
      console.log(`Error:`, JSON.stringify(data));
      return false;
    }
  } catch (err) {
    console.error(`Fetch exception:`, err.message);
    return false;
  }
}

async function run() {
  const models = [
    'openrouter/auto',
    'google/gemma-4-26b-a4b-it:free',
    'qwen/qwen3.8-27b:free',
    'inclusionai/ling-3.0-flash-vl:free'
  ];
  for (const m of models) {
    const ok = await testMultimodal(m);
    if (ok) {
      console.log(`Working model found: ${m}`);
      break;
    }
  }
}

run();
