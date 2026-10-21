// Recognises the streaming chunk formats of common LLM APIs. Anything else
// returns null, so an ordinary SSE or NDJSON stream is measured as events.

export function extract(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return anthropic(obj) ?? openaiResponses(obj) ?? openaiChat(obj) ?? gemini(obj) ?? ollama(obj) ?? streamError(obj);
}

function anthropic(o) {
  switch (o.type) {
    case 'message_start':
      return usage({ provider: 'anthropic', text: '' }, o.message?.usage?.input_tokens, o.message?.usage?.output_tokens);
    case 'content_block_delta':
      return { provider: 'anthropic', text: str(o.delta?.text) + str(o.delta?.thinking) + str(o.delta?.partial_json) };
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
  } else if (o.type === 'response.completed' || o.type === 'response.incomplete') {
    d.done = true;
    usage(d, o.response?.usage?.input_tokens, o.response?.usage?.output_tokens);
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
  let finished = false;
  for (const choice of o.choices) {
    const delta = choice.delta ?? {};
    text += str(delta.content) + str(delta.reasoning_content) + str(delta.reasoning) + str(choice.text);
    for (const call of delta.tool_calls ?? []) text += str(call.function?.arguments);
    if (choice.finish_reason) finished = true;
  }
  const d = usage({ provider: 'openai', text }, o.usage?.prompt_tokens, o.usage?.completion_tokens);
  if (finished) d.done = true;
  return d;
}

// Gemini has no end-of-stream event; the last chunk carries a finishReason.
function gemini(o) {
  if (!Array.isArray(o.candidates)) return null;
  const parts = o.candidates[0]?.content?.parts ?? [];
  const meta = o.usageMetadata;
  const output = meta?.candidatesTokenCount === undefined
    ? undefined
    : meta.candidatesTokenCount + (meta.thoughtsTokenCount ?? 0);
  const d = usage({ provider: 'gemini', text: parts.map((p) => str(p.text)).join('') }, meta?.promptTokenCount, output);
  if (o.candidates[0]?.finishReason) d.done = true;
  return d;
}

function ollama(o) {
  if (typeof o.model !== 'string' || typeof o.done !== 'boolean') return null;
  const text = str(o.message?.content) + str(o.message?.thinking) + str(o.response) + str(o.thinking);
  if (!o.done) return { provider: 'ollama', text };
  return usage({ provider: 'ollama', text, done: true }, o.prompt_eval_count, o.eval_count);
}

// {"error": {...}} mid-stream, as OpenAI-compatible servers send it.
function streamError(o) {
  const message = typeof o.error === 'string' ? o.error : str(o.error?.message);
  return message ? { provider: null, text: '', error: message } : null;
}

function usage(delta, input, output) {
  if (Number.isFinite(input)) delta.inputTokens = input;
  if (Number.isFinite(output)) delta.outputTokens = output;
  return delta;
}

function str(value) {
  return typeof value === 'string' ? value : '';
}
