// Recognises the streaming chunk formats of common LLM APIs. Anything else
// returns null, so an ordinary SSE or NDJSON stream is measured as events.
// outputTokens counts the answer; reasoningTokens is thinking a provider
// reports on its own (OpenAI's reasoning_tokens, Gemini's thoughtsTokenCount),
// and `reasoning` marks a delta whose text is that thinking.

export function extract(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return anthropic(obj) ?? openaiResponses(obj) ?? openaiChat(obj) ?? gemini(obj) ?? ollama(obj) ?? streamError(obj);
}

function anthropic(o) {
  switch (o.type) {
    case 'message_start':
      return usage({ provider: 'anthropic', text: '' }, o.message?.usage?.input_tokens, o.message?.usage?.output_tokens);
    case 'content_block_delta': {
      const thinking = str(o.delta?.thinking);
      return { provider: 'anthropic', text: str(o.delta?.text) + thinking + str(o.delta?.partial_json), reasoning: thinking !== '' };
    }
    case 'message_delta':
      return usage({ provider: 'anthropic', text: '' }, undefined, o.usage?.output_tokens);
    case 'message_stop':
      return { provider: 'anthropic', text: '', done: true };
    case 'error':
      return o.error ? { provider: 'anthropic', text: '', error: str(o.error.message) || str(o.error.type) } : null;
    default:
      return null;
  }
}

function openaiResponses(o) {
  if (typeof o.type !== 'string' || !o.type.startsWith('response.')) return null;
  const d = { provider: 'openai-responses', text: '' };
  if (o.type.endsWith('.delta')) {
    d.text = str(o.delta);
    d.reasoning = o.type.includes('reasoning');
  } else if (o.type === 'response.completed' || o.type === 'response.incomplete') {
    d.done = true;
    const u = o.response?.usage;
    const thinking = u?.output_tokens_details?.reasoning_tokens;
    usage(d, u?.input_tokens, minus(u?.output_tokens, thinking), thinking);
  } else if (o.type === 'response.failed') {
    d.error = str(o.response?.error?.message) || 'response failed';
  }
  return d;
}

// Some OpenAI-compatible servers never send [DONE]; a finish_reason also
// marks the end.
function openaiChat(o) {
  if (!Array.isArray(o.choices)) return null;
  let text = '';
  let thinking = '';
  let finished = false;
  for (const choice of o.choices) {
    const delta = choice.delta ?? {};
    text += str(delta.content) + str(choice.text);
    thinking += str(delta.reasoning_content) + str(delta.reasoning);
    for (const call of delta.tool_calls ?? []) text += str(call.function?.arguments);
    if (choice.finish_reason) finished = true;
  }
  const u = o.usage;
  const hidden = u?.completion_tokens_details?.reasoning_tokens;
  const d = usage({ provider: 'openai', text: text + thinking, reasoning: thinking !== '' }, u?.prompt_tokens, minus(u?.completion_tokens, hidden), hidden);
  if (finished) d.done = true;
  return d;
}

// Gemini has no end-of-stream event; the last chunk carries a finishReason.
function gemini(o) {
  if (!Array.isArray(o.candidates)) return null;
  const parts = o.candidates[0]?.content?.parts ?? [];
  const meta = o.usageMetadata;
  const text = parts.map((p) => str(p.text)).join('');
  const reasoning = parts.some((p) => p.thought && str(p.text) !== '');
  const d = usage({ provider: 'gemini', text, reasoning }, meta?.promptTokenCount, meta?.candidatesTokenCount, meta?.thoughtsTokenCount);
  if (o.candidates[0]?.finishReason) d.done = true;
  return d;
}

function ollama(o) {
  if (typeof o.model !== 'string' || typeof o.done !== 'boolean') return null;
  const thinking = str(o.message?.thinking) + str(o.thinking);
  const d = { provider: 'ollama', text: str(o.message?.content) + str(o.response) + thinking, reasoning: thinking !== '' };
  if (!o.done) return d;
  d.done = true;
  return usage(d, o.prompt_eval_count, o.eval_count);
}

// {"error": {...}} mid-stream, as OpenAI-compatible servers send it.
function streamError(o) {
  const message = typeof o.error === 'string' ? o.error : str(o.error?.message);
  return message ? { provider: null, text: '', error: message } : null;
}

function usage(delta, input, output, reasoning) {
  if (Number.isFinite(input)) delta.inputTokens = input;
  if (Number.isFinite(output)) delta.outputTokens = output;
  if (Number.isFinite(reasoning)) delta.reasoningTokens = reasoning;
  return delta;
}

function minus(total, part) {
  return Number.isFinite(total) ? total - (Number.isFinite(part) ? part : 0) : undefined;
}

function str(value) {
  return typeof value === 'string' ? value : '';
}
