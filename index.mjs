/**
 * llama.cpp provider for the DeepSeek Harness — the harness-side twin of
 * [pi-llama](https://github.com/huggingface/pi-llama).
 *
 * A running `llama-server` is the whole configuration. The plugin reads its
 * model catalog from `GET /v1/models` and its **context window** from
 * `GET /props` (`default_generation_settings.n_ctx`), so compaction, token
 * accounting, and the context meter all size themselves to whatever the server
 * actually loaded — swap the model behind the server and the next turn is
 * already correct. Only the base URL has to be written down, and only once:
 *
 * ```yaml
 * - insert:
 *     - id: llm-llamacpp
 *       name: ./dsh-llm-llamacpp/index.mjs
 *       config:
 *         baseURL: http://localhost:8080/v1
 * ```
 *
 * Everything else has a default: `baseURL` falls back to `LLAMA_BASE_URL`,
 * then to `http://localhost:8080/v1`, and the API key to `LLAMA_API_KEY`, then
 * to llama.cpp's own `no-key`. The same fields are also editable at runtime
 * from the Settings page under `llm-llamacpp`, because the row's config is
 * installed as that section's base layer.
 *
 * @module dsh-llm-llamacpp
 */

import { harnessModule, setHarnessRoot } from './lib/harness.mjs'
import { createAdapter } from './lib/adapter.mjs'

/** Provider route this plugin registers; the id a model selection names. */
export const PROVIDER_ID = 'llama-cpp'
/** Harness settings namespace that carries this provider's profile. */
export const SETTINGS_NS = 'llm-llamacpp'
/** Where a llama.cpp server is reachable when nothing says otherwise. */
export const DEFAULT_BASE_URL = 'http://localhost:8080/v1'
/** llama.cpp ignores the credential, but OpenAI-compatible clients insist on one. */
export const DEFAULT_API_KEY = 'no-key'

export const name = 'llm-llamacpp'
export const inject = ['llm']

/** Config schema, handed to the loader and to the settings section it installs. */
export const Config = await (async () => {
  const { default: Schema } = await harnessModule('@deepseek-ai/schemastery')
  return Schema.object({
    baseURL: Schema.string()
      .description('llama.cpp server API base, e.g. http://localhost:8080/v1'),
    apiKey: Schema.string()
      .description('Credential sent as a bearer token; llama.cpp itself ignores it unless --api-key is set'),
    headers: Schema.dict(Schema.string())
      .description('Extra request headers, for a proxy in front of the server'),
    displayName: Schema.string()
      .description('Name shown in provider selectors'),
    contextWindow: Schema.natural()
      .description('Pinned context size; when absent the server is asked and its answer is used'),
    discoverContext: Schema.boolean()
      .description('Ask GET /props for the context window (default true)'),
    harnessRoot: Schema.string()
      .description('Harness checkout to load the LLM seam from, when it is not the default build'),
    requestTimeoutMs: Schema.natural()
      .description('Reserved: bound on a whole streaming request'),
    logLevel: Schema.union(['silent', 'info', 'verbose'])
      .description('Startup diagnostics verbosity'),
  })
})()

/**
 * Register the adapter and its configuration surface.
 * @param {object} ctx - the plugin context.
 * @param {object} [rawConfig] - the row's config, already validated against {@link Config}.
 */
export function apply(ctx, rawConfig) {
  const base = normalizeConfig(rawConfig)
  // The profile is read per operation, so a settings edit reaches the next
  // request without a restart; `current` is what the settings section swaps.
  let current = () => base
  const profile = () => normalizeConfig(current())

  // The adapter extends the harness's own `LlmAdapter`, which is resolved at
  // import time from the default checkout. A row that names another checkout
  // re-registers the seam before the adapter is built.
  if (base.harnessRoot !== undefined) setHarnessRoot(base.harnessRoot)

  const log = loggerFor(ctx, base.logLevel)

  return ctx.inject(['llm'], (llmCtx) => {
    const adapter = createAdapter({ profile, log })

    llmCtx.llm.registerAdapter([PROVIDER_ID], adapter)
    llmCtx.llm.registerConfigurableProviders([
      { provider: PROVIDER_ID, displayName: base.displayName, settingsNs: SETTINGS_NS, settingsPath: [] },
    ])

    // Discovery is a configuration-time action over a draft: the Models page
    // sends the endpoint a user is still editing, and the answer populates the
    // form. It is registered before any route exists, which is the point.
    llmCtx.llm.registerModelDiscovery(SETTINGS_NS, async (request, signal) => {
      const draft = normalizeConfig({
        ...rawConfig,
        ...request.baseURL === undefined ? {} : { baseURL: request.baseURL },
        ...request.apiKey === undefined ? {} : { apiKey: request.apiKey },
      })
      return listRemoteModels(draft, signal)
    })

    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, SETTINGS_NS, Config, base, {
        setSource: (source) => {
          current = source
        },
        onChange: () => {
          log.info(`settings updated — endpoint ${profile().baseURL}`)
        },
      })
    })

    // Publish what was discovered, once, without delaying the mount: a boot
    // that cannot reach the server must still register the provider, because
    // the server may simply not be up yet.
    void prewarm(adapter, base, log)
  })
}

/**
 * Probe the configured endpoint and report what it holds.
 *
 * Runs in the background on purpose: llama.cpp is frequently started after the
 * harness, and a provider that refused to mount until its endpoint answered
 * would need a restart to pick the server up.
 * @param adapter - the registered adapter.
 * @param profile - the resolved base configuration.
 * @param log - diagnostic sink.
 */
async function prewarm(adapter, profile, log) {
  const found = await adapter.prewarm(PROVIDER_ID)
  if (found.error !== undefined) {
    log.warn(`endpoint ${profile.baseURL} unreachable: ${found.error}`)
    return
  }
  if (found.models === 0) {
    log.warn(`no models advertised by ${profile.baseURL}/models — is llama-server running?`)
    return
  }
  if (found.contextWindow === undefined) {
    log.info(`${found.models} model(s) available; no context window disclosed yet by ${profile.baseURL}`)
    return
  }
  log.info(
    `${found.model} ready on ${profile.baseURL} — context window ${found.contextWindow} tokens`
    + `${found.build === undefined ? '' : ` (build ${found.build})`}`,
  )
}

/**
 * Interrogate one endpoint for the models it serves.
 * @param profile - resolved profile naming the endpoint.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns discovered models in server order.
 */
async function listRemoteModels(profile, signal) {
  const url = `${profile.baseURL}/models`
  let response
  try {
    response = await fetch(url, {
      headers: {
        ...profile.apiKey.length === 0 ? {} : { authorization: `Bearer ${profile.apiKey}` },
        ...profile.headers,
      },
      signal: signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
  } catch (error) {
    throw new Error(`llama.cpp: cannot reach ${url} (${error.message})`)
  }
  if (!response.ok) throw new Error(`llama.cpp: ${url} returned HTTP ${response.status}`)
  const { readCatalog } = await import('./lib/wire.mjs')
  const entries = readCatalog(await response.json())
  if (entries.length === 0) throw new Error(`llama.cpp: ${url} advertised no models`)
  return entries.map(entry => ({
    id: entry.id,
    name: entry.name,
    ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
  }))
}

/**
 * Build the diagnostic sink used across the plugin.
 *
 * It is callable — `log('info', message)` — so the adapter can hand it one
 * message at the level that message deserves, and it carries `info`/`warn` for
 * the plugin's own unconditional reports. Plain startup chatter is suppressed
 * unless the row asks for it; a warning is always reported.
 * @param ctx - the plugin context, for its logger.
 * @param {'silent' | 'info' | 'verbose'} level - configured verbosity.
 * @returns the sink.
 */
function loggerFor(ctx, level) {
  const emit = (method, message) => {
    try {
      ctx.logger?.[method]?.(`llm-llamacpp: ${message}`)
    } catch {
      // A logger that throws must never take the provider down with it.
    }
  }
  const log = (method, message) => {
    if (method === 'warn') {
      emit('warn', message)
      return
    }
    if (level !== 'silent') emit('info', message)
  }
  log.info = message => log('info', message)
  log.warn = message => log('warn', message)
  log.verbose = message => {
    if (level === 'verbose') emit('info', message)
  }
  return log
}

/**
 * Resolve one profile from a row's config, the environment, and the defaults.
 *
 * `baseURL` is normalized the same way pi-llama treats `LLAMA_BASE_URL`: a
 * trailing slash is dropped, and `/v1` is appended when the value does not name
 * an API root already, so both `http://host:8080` and `http://host:8080/v1`
 * address the same server.
 * @param {object} [config] - validated row config.
 * @returns the resolved profile.
 */
export function normalizeConfig(config = {}) {
  const raw = firstNonEmpty(
    config.baseURL,
    process.env.LLAMA_BASE_URL,
    DEFAULT_BASE_URL,
  )
  return {
    provider: PROVIDER_ID,
    baseURL: normalizeBaseUrl(raw),
    apiKey: firstNonEmpty(config.apiKey, process.env.LLAMA_API_KEY, DEFAULT_API_KEY),
    headers: isPlainObject(config.headers) ? config.headers : {},
    displayName: firstNonEmpty(config.displayName, 'llama.cpp'),
    ...positiveInt(config.contextWindow) === undefined
      ? {}
      : { contextWindow: positiveInt(config.contextWindow) },
    discoverContext: config.discoverContext !== false,
    ...typeof config.harnessRoot === 'string' && config.harnessRoot.length > 0
      ? { harnessRoot: config.harnessRoot }
      : {},
    logLevel: config.logLevel === 'verbose' || config.logLevel === 'info' || config.logLevel === 'silent'
      ? config.logLevel
      : 'silent',
  }
}

/**
 * Normalize a configured endpoint into an API base URL.
 * @param {string} value - configured or environment value.
 * @returns the base URL without a trailing slash, with `/v1` appended when absent.
 */
export function normalizeBaseUrl(value) {
  const trimmed = String(value).trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return DEFAULT_BASE_URL
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/** First non-empty string among the candidates. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/** The value as a positive integer, or `undefined`. */
function positiveInt(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/** Whether a value is a plain object usable as a header map. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

