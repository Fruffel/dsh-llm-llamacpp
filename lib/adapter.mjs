/**
 * The llama.cpp `LlmAdapter`: model catalog, exact-model metadata, and the
 * streaming chat-completions call.
 *
 * A llama.cpp server is one process serving one loaded model, so the adapter is
 * deliberately dynamic rather than configured: the model catalog comes from
 * `GET /v1/models`, and the context window comes from the server itself
 * (`GET /props` → `default_generation_settings.n_ctx`), falling back to the
 * per-model `meta.n_ctx` the listing publishes. Nothing about a model has to be
 * declared up front, and a model swapped on the server reaches the next turn
 * without touching this deployment.
 *
 * @module dsh-llm-llamacpp/lib/adapter
 */

import { harnessModule, harnessRoot } from './harness.mjs'
import {
  chatBody, parseSse, readCatalog, readPropsBuild, readPropsContext, readTemplateThinking, serverRoot,
} from './wire.mjs'
import { translate } from './translate.mjs'

/**
 * The harness's own classes and helpers. Resolved from the checkout this
 * deployment runs, so an error raised here is the same `LlmError` the runtime
 * unloads, normalizes, and retries.
 */
const { LlmAdapter, LlmError, attributionHeaders } = await harnessModule('@deepseek-ai/dsh-llm')

/** Positive integer context sizes are the only ones the harness accepts. */
const MIN_CONTEXT_WINDOW = 256
/** Guard against a nonsense `n_ctx` from a chatty proxy. */
const MAX_CONTEXT_WINDOW = 100_000_000
/** Output cap sent for a model whose context cannot be discovered. */
const FALLBACK_MAX_TOKENS = 8192
/** Upper bound on the output cap derived from a discovered context window. */
const MAX_TOKENS_CEILING = 32_768
/** Serve a cached model catalog for this long before refreshing it. */
const CATALOG_TTL_MS = 5_000
/** Serve a cached context probe for this long before asking the server again. */
const CONTEXT_TTL_MS = 60_000
/** Bound on one `/props` probe inside a request path. */
const PROBE_TIMEOUT_MS = 1_500
/** Context sizes at or above this are assumed to leave room for the output cap. */
const ROOMY_CONTEXT_WINDOW = 32_768

/** The reasoning levels a template with `enable_thinking` can distinguish. */
const REASONING_EFFORTS = Object.freeze([
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
])

/** The level a thinking template uses when the caller expresses no preference. */
const DEFAULT_REASONING_EFFORT = 'off'

/**
 * Build the adapter for one llama.cpp endpoint.
 *
 * @param {object} options - resolved by the registering plugin.
 * @param {() => object} options.profile - the endpoint profile in force for this operation.
 * @param {(method: 'info' | 'warn', message: string) => void} [options.log] - diagnostic sink.
 * @returns {object} the adapter to register with `ctx.llm`.
 */
export function createAdapter({ profile, log }) {
  /** Model catalog cache, keyed by the endpoint it was read from. */
  let catalog = { base: undefined, at: 0, entries: [] }
  /** Context-window cache, keyed by endpoint and model. */
  let context = { key: undefined, at: 0, value: undefined, maxTokens: undefined, build: undefined }
  /**
   * Whether the served chat template reads `enable_thinking`.
   *
   * Kept apart from the context-window cache on purpose: the window goes stale
   * after {@link CONTEXT_TTL_MS} and is re-probed, but a template capability is
   * a property of the loaded model, and losing it on every expiry would drop the
   * thinking knob from requests that had it a minute earlier.
   */
  let templateCapability = { key: undefined, supported: false }

  const headersFor = (current) => ({
    'content-type': 'application/json',
    ...attributionHeaders(),
    ...current.apiKey === undefined || current.apiKey.length === 0
      ? {}
      : { authorization: `Bearer ${current.apiKey}` },
    ...current.headers,
  })

  /** Read a JSON response, or throw the adapter error that names why it failed. */
  const readJson = async (response, what, base) => {
    if (!response.ok) throw httpError(response.status, `${what} from ${base}`)
    try {
      return await response.json()
    } catch (error) {
      throw new LlmError(`${what} from ${base} was not valid JSON`, 'MALFORMED_RESPONSE', { cause: error })
    }
  }

  /** Read `GET /v1/models` for one profile. */
  const fetchCatalog = async (current, signal) => {
    const response = await fetch(`${current.baseURL}/models`, {
      headers: headersFor(current),
      ...combine(signal, 10_000) === undefined ? {} : { signal: combine(signal, 10_000) },
    })
    return readCatalog(await readJson(response, 'the model list', current.baseURL))
  }

  /**
   * Read `GET /props` for the server's current context size, and with it the
   * build string and whether the served template exposes `enable_thinking`.
   * Never throws: a server that does not answer `/props` still serves chat.
   * @returns the probe result, or `undefined` when the server discloses nothing.
   */
  const fetchProps = async (current, model, signal, autoload = false) => {
    const root = serverRoot(current.baseURL)
    const query = model === undefined
      ? ''
      : `?model=${encodeURIComponent(model)}${autoload ? '&autoload=true' : ''}`
    const deadline = combine(signal, PROBE_TIMEOUT_MS)
    let response
    try {
      response = await fetch(
        `${root}/props${query}`,
        { headers: headersFor(current), ...deadline === undefined ? {} : { signal: deadline } },
      )
    } catch {
      return undefined
    }
    if (!response.ok) return undefined
    let payload
    try {
      payload = await response.json()
    } catch {
      return undefined
    }
    const contextWindow = readPropsContext(payload)
    if (contextWindow === undefined) return undefined
    return {
      contextWindow: boundedContext(contextWindow),
      build: readPropsBuild(payload),
      thinking: readTemplateThinking(payload),
    }
  }

  /** The view of the context probe that costs no I/O, kept fresh for {@link CONTEXT_TTL_MS}. */
  const cachedContext = (current, model) => {
    if (context.key !== contextKey(current, model) || Date.now() - context.at > CONTEXT_TTL_MS) return undefined
    return context
  }

  /** Record one successful probe under the endpoint and model it described. */
  const rememberContext = (current, model, value) => {
    context = { key: contextKey(current, model), at: Date.now(), ...value }
    return context
  }

  /** Record the served template's thinking capability, which outlives the context cache. */
  const rememberTemplate = (current, model, supported) => {
    templateCapability = { key: contextKey(current, model), supported }
  }

  /** Whether the served template is known to read `enable_thinking` for this model. */
  const templateReadsThinking = (current, model) => (
    templateCapability.key === contextKey(current, model) && templateCapability.supported
  )

  /** The catalog for one profile, refreshed when the cache is cold, stale, or from another endpoint. */
  const modelsFor = async (current, signal, { force = false } = {}) => {
    if (!force && catalog.base === current.baseURL && Date.now() - catalog.at < CATALOG_TTL_MS) {
      return catalog.entries
    }
    const entries = await fetchCatalog(current, signal)
    catalog = { base: current.baseURL, at: Date.now(), entries }
    return entries
  }

  /** The listing entry for one model id, when the server currently advertises it. */
  const entryFor = async (current, model, signal) => {
    try {
      return (await modelsFor(current, signal)).find(entry => entry.id === model)
    } catch {
      // A catalog read that fails must not fail a chat call: the id the caller
      // holds may name a model the server has since unloaded.
      return undefined
    }
  }

  /**
   * Ask the server for its context window, but only for as long as the caller
   * is willing to wait.
   *
   * The probe is treated as part of resolving one model — not as a background
   * nicety — because whether a response is thinking and how much of the context
   * it may use both come from the same answer. Waiting the whole deadline on a
   * server that is unreachable would stall every turn, so the wait is bounded
   * and a late answer is left to the next call, which will find it cached.
   * @param current - the endpoint profile in force.
   * @param {string} model - exact model id.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {boolean} [autoload] - ask the router to load the model on demand.
   * @returns the probe result, or `undefined` when it did not land in time.
   */
  const probeContext = async (current, model, signal, autoload = false) => {
    const probed = await fetchProps(current, model, signal, autoload)
    if (probed === undefined) return undefined
    const remembered = rememberContext(current, model, {
      value: probed.contextWindow,
      maxTokens: outputCapFor(probed.contextWindow),
      build: probed.build,
    })
    rememberTemplate(current, model, probed.thinking)
    log?.(
      'info',
      `discovered a ${remembered.value} token context window for ${current.baseURL}`
      + ` (${probed.build ?? 'unknown build'})`,
    )
    return remembered
  }

  /**
   * Resolve the exact metadata for one model, discovering the context window
   * from the server when it can and from the listing when it cannot.
   * @param current - the endpoint profile in force.
   * @param {string} model - exact model id.
   * @param {boolean} allowProbe - whether a live `/props` read is permitted for this call.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns the resolved model facts, plus the adapter-private `thinking`/`loaded` flags.
   */
  const resolve = async (current, model, allowProbe, signal) => {
    const entry = await entryFor(current, model, signal)
    let contextWindow = current.contextWindow
    let maxTokens

    if (allowProbe) {
      const cached = cachedContext(current, model)
      if (cached !== undefined) {
        // A pinned window still takes the capability from the same probe: the
        // template is a property of the loaded model, not of the budget.
        if (contextWindow === undefined) {
          contextWindow = cached.value
          maxTokens = cached.maxTokens
        }
      } else {
        const probed = await probeContext(current, model, signal)
        if (probed !== undefined && contextWindow === undefined) {
          contextWindow = probed.value
          maxTokens = probed.maxTokens
        }
      }
    }

    // The listing's own `meta.n_ctx` is the last resort and stays authoritative
    // over any guess: a wrong context window corrupts compaction decisions.
    contextWindow ??= entry?.contextWindow
    return {
      provider: current.provider,
      id: model,
      name: entry?.name ?? model,
      description: entry === undefined ? undefined : describe(entry, contextWindow),
      inputModalities: entry?.multimodal === true ? ['text', 'image'] : ['text'],
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      defaultMaxTokens: maxTokens ?? (contextWindow === undefined
        ? FALLBACK_MAX_TOKENS
        : outputCapFor(contextWindow)),
      thinking: templateReadsThinking(current, model),
      loaded: entry?.loaded ?? false,
    }
  }

  /**
   * The reasoning levels to advertise for one resolved model.
   *
   * llama.cpp has no numeric effort ladder: a template either reads
   * `enable_thinking` or it does not. So a template that does gets the
   * harness's own levels mapped onto that one boolean — `off` sends false and
   * every other level sends true — and a template that does not is left without
   * a reasoning capability, which is what makes the runtime refuse an explicit
   * effort instead of silently ignoring the request.
   */

  const adapter = new LlmAdapter()

  /** Route display metadata; the plugin names itself through this. */
  adapter.providerInfo = (provider) => ({ id: provider, name: profile().displayName })

  /** The server's own catalog, which is what makes model browsing work with nothing declared. */
  adapter.listModels = async (provider) => {
    const current = { ...profile(), provider }
    const entries = await modelsFor(current, undefined)
    return entries.map(entry => ({
      provider,
      id: entry.id,
      name: entry.name,
      description: describe(entry, entry.contextWindow),
      inputModalities: entry.multimodal ? ['text', 'image'] : ['text'],
    }))
  }

  /** Exact-model metadata, including the context window discovered from the server. */
  adapter.resolveModel = async (provider, model, signal) => {
    const current = { ...profile(), provider }
    const resolved = await resolve(current, model, true, signal)
    return { ...publicFacts(resolved, provider, model), ...reasoningFacts(resolved) }
  }

  /**
   * Bind metadata and dispatch to one profile snapshot.
   *
   * One resolution runs here, then rides along to the stream, so the metadata a
   * caller sees, the context window the turn plans against, and the thinking
   * knob the request carries are all the same answer from the same moment —
   * rather than one resolution for the preflight and another for the wire. The
   * snapshot freezes with the resolution, so a settings change cannot pair one
   * generation's endpoint with another's metadata mid-call.
   */
  adapter.prepareCall = async (provider, model, signal) => {
    const current = { ...profile(), provider }
    const resolved = await resolve(current, model, true, signal)
    return {
      model: { ...publicFacts(resolved, provider, model), ...reasoningFacts(resolved) },
      stream: options => streamWith(withResolved(options, resolved), { profile: current, resolved }),
    }
  }

  /** Stream one call against the profile in force right now. */
  adapter.stream = (options) => {
    const current = { ...profile(), provider: options.provider }
    const carried = carriedResolved(options)
    if (carried !== undefined) return streamWith(options, { profile: current, resolved: carried })
    return (async function* () {
      const resolved = await resolve(current, options.model, true, options.signal)
      yield* streamWith(options, { profile: current, resolved })
    })()
  }

  /**
   * Discover the context window before any request needs it, so the first turn
   * already compacts against the right number instead of a fallback.
   *
   * The loaded model is the one the catalog marks `loaded`; `/props?model=…`
   * is asked for exactly that id, so the answer is cached under the key the
   * request path will look up. Probing an id the server has not loaded would
   * cache under a key nothing reads.
   * @param {string} [provider] - the route to report through.
   * @returns {{model?: string, contextWindow?: number, build?: string, models: number}} what was discovered.
   */
  adapter.prewarm = async (provider) => {
    const current = { ...profile(), provider: provider ?? 'llama-cpp' }
    let entries
    try {
      entries = await modelsFor(current, undefined, { force: true })
    } catch (error) {
      // An endpoint that is not up yet is a normal state, not a mount failure.
      return { models: 0, error: error.message }
    }
    const loaded = entries.find(entry => entry.loaded)
    if (loaded === undefined) return { models: entries.length }
    // `autoload=true` asks the router to bring the model up on demand, which is
    // what makes the first turn usable instead of a cold-start failure.
    const probed = await probeContext(current, loaded.id, undefined, true)
    if (probed === undefined) return { model: loaded.id, models: entries.length }
    return { model: loaded.id, contextWindow: probed.value, build: probed.build, models: entries.length }
  }

  /**
   * Perform one streaming request against the endpoint captured in `state`.
   * @param options - the assembled harness request.
   * @param state - the profile snapshot and model facts this call dispatches with.
   */
  async function* streamWith(options, state) {
    const { profile: current, resolved } = state
    const body = chatBody({
      model: options.model,
      messages: serializeMessages(options),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      stop: options.stop,
      tools: options.tools,
      // Sent only when the served template was observed to read the knob, so a
      // model whose template lacks it keeps that template's own default.
      thinking: thinkingKnob(options.reasoningEffort, templateReadsThinking(current, options.model)),
    })

    const response = await fetch(`${current.baseURL}/chat/completions`, {
      method: 'POST',
      headers: headersFor(current),
      body: JSON.stringify(body),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) throw await httpFailure(response, current.baseURL)

    yield* translate(parseSse(response.body), (message, code) => new LlmError(message, code))
  }

  return adapter
}

/** Whether an explicit reasoning-effort selection maps onto the template's thinking toggle. */
function thinkingKnob(effort, templateSupported) {
  if (effort === undefined || !templateSupported) return undefined
  if (effort === 'off' || effort === 'none' || effort === 'disabled') return false
  return true
}

/**
 * Where one resolution rides from `prepareCall` into the stream it bound.
 *
 * A symbol keeps it out of the request the adapter serializes and out of any
 * caller-visible shape: it is adapter-private bookkeeping on an object the
 * adapter itself receives back.
 */
const RESOLVED = Symbol('dsh-llm-llamacpp.resolved')

/** Attach one resolution to the request it was prepared for. */
function withResolved(options, resolved) {
  if (typeof options !== 'object' || options === null) return options
  Object.defineProperty(options, RESOLVED, { value: resolved, enumerable: false, configurable: true })
  return options
}

/** The resolution a prepared request carries, when it still has one. */
function carriedResolved(options) {
  return typeof options === 'object' && options !== null ? options[RESOLVED] : undefined
}

/** Cache key for one endpoint/model pair. */
function contextKey(current, model) {
  return `${current.baseURL}\u0000${model ?? ''}`
}

/** Keep only the facts the registry accepts on a resolved model. */
function publicFacts(resolved, provider, model) {
  return {
    provider,
    id: model,
    name: resolved.name,
    ...resolved.description === undefined ? {} : { description: resolved.description },
    inputModalities: resolved.inputModalities,
    ...resolved.context === undefined ? {} : { context: resolved.context },
    ...resolved.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: resolved.defaultMaxTokens },
  }
}

/** The reasoning capability for the same resolution, when the template has one. */
function reasoningFacts(resolved) {
  return resolved.thinking
    ? { reasoning: { efforts: REASONING_EFFORTS, defaultEffort: DEFAULT_REASONING_EFFORT } }
    : {}
}

/** One selector line for a catalog entry. */
function describe(entry, contextWindow) {
  const facts = []
  if (contextWindow !== undefined) facts.push(`${contextWindow} token context`)
  if (entry.loaded) facts.push('loaded')
  if (entry.multimodal) facts.push('vision')
  return facts.length === 0 ? undefined : facts.join(' · ')
}

/** Clamp a discovered context window into the range the harness accepts. */
function boundedContext(value) {
  return Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, Math.floor(value)))
}

/**
 * The output cap to advertise for a context window. It stays well under the
 * window so a long conversation still has room to answer, and under
 * {@link MAX_TOKENS_CEILING} so a large window does not become a large default
 * generation. llama.cpp clamps the value to the space left in context anyway.
 */
function outputCapFor(contextWindow) {
  if (contextWindow >= ROOMY_CONTEXT_WINDOW) return MAX_TOKENS_CEILING
  return Math.max(1, Math.floor(contextWindow / 4))
}

/** Combine a caller signal with a timeout, or `undefined` when neither applies. */
function combine(signal, timeoutMs) {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  if (timeout === undefined) return signal
  return AbortSignal.any([signal, timeout])
}

/**
 * Serialize the harness conversation into llama.cpp chat messages.
 * @param options - the assembled request.
 * @returns wire messages in conversation order.
 */
export function serializeMessages(options) {
  const messages = []
  // A one-shot caller passes `system` instead of a system-role history entry.
  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) messages.push(...serializeMessage(message))
  return messages
}

/** Serialize one harness message into one wire message. */
function serializeMessage(message) {
  if (message.source?.kind === 'tool') {
    return [{
      role: 'tool',
      tool_call_id: message.source.callId,
      content: serializeToolResult(message),
    }]
  }

  const text = []
  const toolCalls = []
  let attachments = 0

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        text.push(block.text)
        break
      case 'tool-call':
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        })
        break
      case 'reasoning':
        // Reasoning belongs to the turn that produced it; a chat template
        // re-derives its own thinking from the answer text.
        break
      case 'image':
      case 'file':
        attachments += 1
        break
      default:
        break
    }
  }

  if (attachments > 0) {
    throw new LlmError(
      'The llama.cpp adapter sends text only: this message carries an attachment the server cannot receive.'
      + ' Remove the attachment, or route image input through a vision-capable provider.',
      'UNSUPPORTED_CONTENT',
    )
  }

  const content = text.join('')
  if (toolCalls.length > 0) {
    return [{ role: 'assistant', content: content.length === 0 ? null : content, tool_calls: toolCalls }]
  }
  if (message.role === 'assistant') return [{ role: 'assistant', content }]
  if (message.role === 'system') return [{ role: 'system', content }]
  return [{ role: 'user', content }]
}

/** Flatten one tool-result message into the text a `role: "tool"` message carries. */
function serializeToolResult(message) {
  const parts = []
  for (const block of message.content) {
    if (block.type !== 'tool-result') continue
    if (block.isError === true) parts.push('[tool error]')
    for (const inner of block.content ?? []) {
      if (inner.type === 'text') parts.push(inner.text)
    }
  }
  return parts.join('\n')
}

/** Build the transport error for a non-2xx response status. */
function httpError(status, what) {
  const code = status === 429 ? 'RATE_LIMIT'
    : status === 401 || status === 403 ? 'AUTH'
      : status === 404 ? 'NOT_FOUND'
        : status >= 500 ? 'PROVIDER_HTTP_ERROR'
          : 'BAD_REQUEST'
  return new LlmError(`${what}: HTTP ${status}`, code, { status })
}

/**
 * Read one failed response body for the server's own message, then build the
 * adapter error. llama.cpp answers errors as `{error: {message, code}}` and on
 * some paths as `{error: "…"}`.
 */
async function httpFailure(response, base) {
  let detail = ''
  try {
    const text = await response.text()
    if (text.length > 0) {
      try {
        const payload = JSON.parse(text)
        const value = payload?.error?.message ?? payload?.error ?? payload?.message ?? text
        detail = typeof value === 'string' ? value : JSON.stringify(value)
      } catch {
        detail = text
      }
    }
  } catch {
    detail = ''
  }
  const error = httpError(response.status, `chat completion from ${base}`)
  if (detail.length === 0) return error
  return new LlmError(`${error.message}: ${detail.slice(0, 400)}`, error.code, { status: response.status })
}
