/**
 * HTTP vocabulary shared by the llama.cpp adapter: endpoint derivation, the
 * `/models` and `/props` payload readers, the OpenAI chat-completions request
 * body, and SSE framing.
 *
 * Everything here is pure: it takes plain data and returns plain data, so the
 * adapter and the test suite exercise the same code without a harness.
 *
 * @module dsh-llm-llamacpp/lib/wire
 */

/** Terminal SSE payload OpenAI-compatible servers send after the last chunk. */
export const DONE = '[DONE]'

/**
 * The blank line that terminates one SSE event, in each line-ending spelling
 * the spec allows. Matching the delimiter itself (never a bare `\n+`) is what
 * keeps a `\r\n\r\n` event from shedding a stray `\n` into the next one.
 */
const BLANK_LINE = /\r\n\r\n|\n\n|\r\n\n|\n\r\n/

/**
 * Join a base URL and a path without doubling or dropping the separator.
 * @param base - base URL, already normalized (no trailing slash).
 * @param path - path beginning with `/`.
 * @returns the absolute URL.
 */
export function urlFor(base, path) {
  return `${base}${path}`
}

/**
 * The server root that owns a `/v1` base URL — the address `/props` and
 * `/models/sse` live on. llama.cpp serves both beside the API root, and
 * pi-llama derives the root the same way.
 * @param base - normalized API base URL, e.g. `http://host:8080/v1`.
 * @returns the same address with a trailing `/v1` stripped.
 */
export function serverRoot(base) {
  return base.replace(/\/v1$/, '')
}

/**
 * Read one finite, non-negative number out of a payload, accepting the numeric
 * strings some proxies emit in place of JSON numbers.
 * @param value - candidate value from a parsed payload.
 * @returns the number, or `undefined` when absent or unusable.
 */
export function numberFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * First usable positive integer among several spellings of the same fact.
 * llama.cpp's context size has moved between `default_generation_settings.n_ctx`,
 * `n_ctx`, and the per-model `meta.n_ctx` across server versions, and any of the
 * three may carry a numeric string, so every known spelling is tried.
 * @param candidates - payload values in preference order.
 * @returns the first positive integer found, else `undefined`.
 */
export function positiveIntFrom(...candidates) {
  for (const candidate of candidates) {
    const value = numberFrom(candidate)
    if (value !== undefined && Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * The product of one entry of `GET /v1/models`.
 * @typedef {object} CatalogEntry
 * @property {string} id - model id the endpoint accepts.
 * @property {string} name - selector label.
 * @property {number} [contextWindow] - context size the entry advertises.
 * @property {boolean} loaded - whether the server reports this model as loaded.
 * @property {boolean} multimodal - whether the entry accepts image input.
 */

/**
 * Read `GET /v1/models` into catalog entries.
 *
 * llama.cpp answers with an OpenAI-shaped `data` array whose entries may carry
 * router metadata (`aliases`, `status.value`, `architecture.input_modalities`,
 * `meta.n_ctx`); it also answers with a legacy `models` array of
 * `{name, model, capabilities}` on some builds. Both shapes are accepted, and
 * the legacy list contributes the capability hints keyed by the ids it names.
 * @param payload - parsed JSON body.
 * @returns every usable entry, in response order, with the loaded model first.
 */
export function readCatalog(payload) {
  if (typeof payload !== 'object' || payload === null) return []
  const data = Array.isArray(payload.data) ? payload.data : []
  const legacy = Array.isArray(payload.models) ? payload.models : []

  /** Capability hints keyed by every name the legacy listing uses for one model. */
  const capabilities = new Map()
  for (const entry of legacy) {
    if (typeof entry !== 'object' || entry === null) continue
    const listed = Array.isArray(entry.capabilities) ? entry.capabilities : []
    for (const key of [entry.model, entry.name]) {
      if (typeof key === 'string' && key.length > 0) capabilities.set(key, listed)
    }
  }

  const entries = []
  const seen = new Set()
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const alias = Array.isArray(raw.aliases)
      ? raw.aliases.find(value => typeof value === 'string' && value.length > 0)
      : undefined
    const capabilitiesForId = capabilities.get(id) ?? []
    const modalities = Array.isArray(raw.architecture?.input_modalities)
      ? raw.architecture.input_modalities
      : capabilitiesForId.includes('multimodal') ? ['text', 'image'] : []
    entries.push({
      id,
      name: typeof alias === 'string' && alias.length > 0 ? alias : id,
      ...raw.meta?.n_ctx === undefined ? {} : { contextWindow: positiveIntFrom(raw.meta.n_ctx) },
      loaded: raw.status?.value === 'loaded',
      multimodal: modalities.includes('image'),
    })
  }
  // The loaded model is the one a request without an explicit load will reach,
  // so it leads the selector.
  return [...entries.filter(entry => entry.loaded), ...entries.filter(entry => !entry.loaded)]
}

/**
 * Read the context size out of a `GET /props` body.
 * @param payload - parsed JSON body.
 * @returns the server's current context size, or `undefined` when it discloses none.
 */
export function readPropsContext(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  return positiveIntFrom(
    payload.default_generation_settings?.n_ctx,
    payload.n_ctx,
    payload.default_generation_settings?.n_ctx_train,
  )
}

/**
 * Read the server build string out of a `GET /props` body.
 * @param payload - parsed JSON body.
 * @returns the build info, or `undefined`.
 */
export function readPropsBuild(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  return typeof payload.build_info === 'string' && payload.build_info.length > 0
    ? payload.build_info
    : undefined
}

/**
 * Whether a `/props` body declares llama.cpp's `enable_thinking` chat-template
 * knob, which is how a template exposes its reasoning toggle.
 * @param payload - parsed JSON body.
 * @returns true when the served template supports the knob.
 */
export function readTemplateThinking(payload) {
  if (typeof payload !== 'object' || payload === null) return false
  return typeof payload.chat_template === 'string'
    && payload.chat_template.includes('enable_thinking')
}

/**
 * Build one OpenAI chat-completions request body for llama.cpp.
 *
 * `max_tokens: -1` is llama.cpp's own "no cap" spelling: generation stops at
 * the context bound the same way pi-llama lets it. `stream_options` asks for
 * the trailing usage chunk, and `cache_prompt` keeps the server's prompt cache
 * explicit so multi-turn sessions reuse the prefix.
 * @param options - harness request plus the wire messages already serialized.
 * @returns the JSON body to POST to `/v1/chat/completions`.
 */
export function chatBody(options) {
  return {
    model: options.model,
    messages: options.messages,
    stream: true,
    stream_options: { include_usage: true },
    cache_prompt: true,
    max_tokens: options.maxTokens ?? -1,
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop: options.stop },
    ...options.tools === undefined || options.tools.length === 0 ? {} : { tools: options.tools },
    ...options.thinking === undefined
      ? {}
      : { chat_template_kwargs: { enable_thinking: options.thinking } },
  }
}

/**
 * Parse an OpenAI-compatible SSE byte stream into `data:` payloads.
 *
 * Framing is minimal but spec-compliant where it matters: events dispatch on a
 * blank line, several `data:` lines in one event join with newlines, comments
 * and other fields are skipped, and a UTF-8 sequence split across two reads is
 * reassembled by the decoder rather than mis-decoded per read. A stream that
 * ends without `[DONE]` is reported by the caller, which knows whether the
 * provider already declared a finish reason.
 * @param body - response body stream.
 * @returns each event's data payload in arrival order.
 */
export async function* parseSse(body) {
  if (body === null || body === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = boundaryOf(buffer)
    while (boundary !== undefined) {
      const event = buffer.slice(0, boundary.index)
      const payload = dataOf(event)
      buffer = buffer.slice(boundary.index + boundary.length)
      if (payload !== undefined) yield payload
      boundary = boundaryOf(buffer)
    }
  }
  buffer += decoder.decode()
  const tail = dataOf(buffer)
  if (tail !== undefined) yield tail
}

/**
 * Locate the blank line that terminates one SSE event.
 * @param buffer - the undecoded stream tail.
 * @returns the terminator's index and length, or `undefined` while the event is incomplete.
 */
function boundaryOf(buffer) {
  const match = BLANK_LINE.exec(buffer)
  return match === null ? undefined : { index: match.index, length: match[0].length }
}

/** Join one event's `data:` lines, or `undefined` when it carries none. */
function dataOf(event) {
  const lines = []
  for (const line of event.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!trimmed.startsWith('data:')) continue
    lines.push(trimmed.slice(5).replace(/^ /, ''))
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}
