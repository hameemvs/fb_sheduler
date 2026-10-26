import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { AppError } from './service.js';

// Models that accept server-side refusal fallbacks (fallbacks: "default").
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

let client = null;
function getClient() {
  if (!config.ai.enabled) throw new AppError(400, 'AI drafting is off. Set ANTHROPIC_API_KEY and restart Dispatch to turn it on.');
  client ??= new Anthropic();
  return client;
}

const SYSTEM = `You write social media posts for a small business or creator.
Write in a natural, human voice. No hashtag spam: use at most two hashtags, and only when they help discovery on that network.
Never invent facts, prices, dates, statistics or quotes that the user didn't give you.
Return only the post text itself, with no preamble, no quotation marks around it, and no explanation.`;

async function complete(userPrompt) {
  const params = {
    model: config.ai.model,
    max_tokens: 2048,
    system: SYSTEM,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: userPrompt }],
  };
  if (FALLBACK_MODELS.has(config.ai.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let response;
  try {
    response = await getClient().beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AppError(502, 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.');
    if (err instanceof Anthropic.RateLimitError) throw new AppError(429, 'The AI service is rate limiting requests. Try again in a minute.');
    if (err instanceof Anthropic.BadRequestError) throw new AppError(400, `The AI request was rejected: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new AppError(502, 'Could not reach the AI service. Check the server has internet access.');
    if (err instanceof Anthropic.APIError) throw new AppError(502, `The AI service returned an error (${err.status}). Try again.`);
    throw err;
  }
  if (response.stop_reason === 'refusal') {
    throw new AppError(422, 'The AI declined to write this post. Try rewording your request.');
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new AppError(502, 'The AI returned an empty draft. Try again.');
  return text;
}

export async function draftPost({ prompt, network, limit }) {
  if (!String(prompt ?? '').trim()) throw new AppError(400, 'Describe what the post should say');
  const target = network ? ` for ${network}` : '';
  const max = limit ? ` It must be at most ${limit} characters.` : '';
  return complete(`Write one social media post${target}.${max}\n\nWhat it should say:\n${prompt}`);
}

export async function rewritePost({ text, network, limit, instruction }) {
  if (!String(text ?? '').trim()) throw new AppError(400, 'There is no text to rewrite');
  const target = network ? ` for ${network}` : '';
  const max = limit ? ` Keep it within ${limit} characters.` : '';
  const how = instruction ? ` ${instruction}.` : ' Keep the meaning and any links, and make it read naturally on that network.';
  return complete(`Rewrite this social media post${target}.${max}${how}\n\nPost:\n${text}`);
}
