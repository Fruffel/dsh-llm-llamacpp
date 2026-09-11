/**
 * Verification for the llama.cpp provider.
 *
 * Pure wire helpers are tested directly; everything that talks to a server is
 * tested against a mock llama.cpp endpoint that answers `/v1/models`, `/props`,
 * and `/v1/chat/completions` with the real shapes those endpoints use, so the
 * adapter is exercised through the same code path the harness runs.
 *
 * Run with `npm test` (node --test).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { readCatalog, readPropsContext, readTemplateThinking, chatBody, parseSse, serverRoot } from '../lib/wire.mjs'
import { translate, mapFinishReason, mapUsage } from '../lib/translate.mjs'
import { createAdapter, serializeMessages } from '../lib/adapter.mjs'
import { normalizeBaseUrl, normalizeConfig } from '../index.mjs'

/** Collect every chunk one adapter stream emits. */
async function drain(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** The chunk kinds, in order, which is what the protocol contract is about. */
const kinds = chunks => chunks.map(chunk => chunk.type)

/**
 * Start a mock llama.cpp server.
 * @param {object} [options] - overrides for each endpoint's answer.
 * @returns the server plus its base URL and a request log.
 */
async function startServer(options = {}) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ url: request.url, method: request.method, headers: request.headers, body })
      const send = (status, payload, contentType = 'application/json') => {
        response.writeHead(status, { 'content-type': contentType })
        response.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
      }

      if (request.url.startsWith('/v1/models')) {
        send(200, options.models ?? {
          data: [
            { id: 'qwen3-4b', aliases: ['Qwen3 4B'], status: { value: 'loaded' }, meta: { n_ctx: 4096 } },
            { id: 'llama-3.2-1b', aliases: ['Llama 3.2 1B'], status: { value: 'unloaded' } },
          ],
        })
        return
      }
      if (request.url.startsWith('/props')) {
        if (options.propsStatus !== undefined && options.propsStatus !== 200) {
          send(options.propsStatus, { error: 'nope' })
          return
        }
        if (options.props === null) {
          response.writeHead(500)
          response.end('no props here')
          return
        }
        send(200, options.props ?? {
          default_generation_settings: { n_ctx: 32768 },
          build_info: 'b6789-abcdef0',
          chat_template: '{% if enable_thinking %}…{% endif %}',
        })
        return
      }
      if (request.url.startsWith('/v1/chat/completions')) {
        if (options.chatStatus !== undefined && options.chatStatus !== 200) {
          send(options.chatStatus, options.chatError ?? { error: { message: 'boom', code: 500 } })
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(options.sse ?? '')
        return
      }
      send(404, { error: { message: 'not found' } })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/** Build an adapter bound to one profile, the way the plugin does. */
function adapterFor(baseURL, extra = {}) {
  const profile = {
    provider: 'llama-cpp',
    displayName: 'llama.cpp',
    apiKey: 'no-key',
    headers: {},
    ...extra,
    baseURL,
  }
  return createAdapter({ profile: () => profile, log: () => {} })
}

/** Frame one SSE payload the way llama.cpp does. */
const sse = payloads => payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('')

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

test('readCatalog accepts the router shape, then the legacy shape', () => {
  const entries = readCatalog({
    data: [
      {
        id: 'qwen3-4b',
        aliases: ['Qwen3 4B'],
        status: { value: 'loaded' },
        architecture: { input_modalities: ['text', 'image'] },
        meta: { n_ctx: 32768, n_params: 4e9 },
      },
      { id: 'llama-3.2-1b', status: { value: 'unloaded' } },
    ],
    models: [{ name: 'Qwen3 4B', model: 'qwen3-4b', capabilities: ['multimodal'] }],
  })
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], {
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    contextWindow: 32768,
    loaded: true,
    multimodal: true,
  })
  // No alias, no metadata: the id is the label and nothing is claimed about it.
  assert.equal(entries[1].name, 'llama-3.2-1b')
  assert.equal(entries[1].contextWindow, undefined)
  assert.equal(entries[1].loaded, false)
  assert.equal(entries[1].multimodal, false)
})

test('readCatalog tolerates an empty or hostile payload', () => {
  assert.deepEqual(readCatalog(null), [])
  assert.deepEqual(readCatalog({}), [])
  assert.deepEqual(readCatalog({ data: 'nope' }), [])
  assert.deepEqual(readCatalog({ data: [{ no: 'id' }, 'string', 7] }), [])
})

test('readCatalog accepts a legacy-only listing', () => {
  const entries = readCatalog({ models: [{ name: 'local-model', model: 'local', capabilities: ['multimodal'] }] })
  // A legacy listing names models without an id per entry; the modern list is
  // what carries ids, so a legacy-only payload contributes nothing to it.
  assert.deepEqual(entries, [])
})

test('readPropsContext reads every spelling llama.cpp builds use', () => {
  assert.equal(readPropsContext({ default_generation_settings: { n_ctx: 4096 } }), 4096)
  assert.equal(readPropsContext({ n_ctx: 8192 }), 8192)
  assert.equal(readPropsContext({ default_generation_settings: { n_ctx: '16384' } }), 16384)
  assert.equal(readPropsContext({ default_generation_settings: { n_ctx: 0 } }), undefined)
  assert.equal(readPropsContext({}), undefined)
  assert.equal(readPropsContext(null), undefined)
})

test('readTemplateThinking detects the enable_thinking knob', () => {
  assert.equal(readTemplateThinking({ chat_template: '{% if enable_thinking %}x{% endif %}' }), true)
  assert.equal(readTemplateThinking({ chat_template: 'plain' }), false)
  assert.equal(readTemplateThinking({}), false)
})

test('serverRoot strips the API root from a base URL', () => {
  assert.equal(serverRoot('http://host:8080/v1'), 'http://host:8080')
  assert.equal(serverRoot('http://host:8080/api/v1'), 'http://host:8080/api')
})

test('chatBody states llama.cpp own no-cap default and asks for usage', () => {
  const body = chatBody({ model: 'm', messages: [], maxTokens: undefined })
  assert.equal(body.max_tokens, -1)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.stream, true)
  assert.equal(body.temperature, undefined)
  assert.equal(body.chat_template_kwargs, undefined)
})

test('chatBody carries an explicit thinking knob and generation parameters', () => {
  const body = chatBody({
    model: 'm',
    messages: [],
    maxTokens: 256,
    temperature: 0.2,
    stop: ['</s>'],
    tools: [{ name: 'bash', description: 'run', parameters: {} }],
    thinking: false,
  })
  assert.equal(body.max_tokens, 256)
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.stop, ['</s>'])
  assert.equal(body.tools.length, 1)
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
})

test('parseSse frames events across read boundaries and line endings', async () => {
  const encoder = new TextEncoder()
  const bytes = encoder.encode('data: {"a":1}\n\ndata: {"b":2}\r\n\r\n: ping\ndata: [DONE]\n\n')
  // Split mid-payload and mid-delimiter: framing must reassemble both.
  const cuts = [7, 13, 20, 28]
  const stream = new ReadableStream({
    start(controller) {
      let from = 0
      for (const cut of cuts) {
        controller.enqueue(bytes.slice(from, cut))
        from = cut
      }
      controller.enqueue(bytes.slice(from))
      controller.close()
    },
  })
  const payloads = []
  for await (const payload of parseSse(stream)) payloads.push(payload)
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}', '[DONE]'])
})

test('parseSse reassembles a multi-byte character split across reads', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"héllo wörld"}\n\ndata: [DONE]\n\n')
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    },
  })
  const payloads = []
  for await (const payload of parseSse(stream)) payloads.push(payload)
  assert.deepEqual(payloads, ['{"text":"héllo wörld"}', '[DONE]'])
})

// ---------------------------------------------------------------------------
// Chunk translation
// ---------------------------------------------------------------------------

test('translate emits interleaved reasoning, text, tool calls, usage, then finish', async () => {
  const payloads = [
    '{"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
    '{"choices":[{"delta":{"content":"Hel"}}]}',
    '{"choices":[{"delta":{"content":"lo"}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"a\\""}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":6}}}',
    '[DONE]',
  ]
  const chunks = await drain(translate(payloads, (message, code) => Object.assign(new Error(message), { code })))

  assert.deepEqual(kinds(chunks), [
    'block-start', 'reasoning-delta',
    'block-start', 'text-delta', 'text-delta',
    'block-start', 'tool-call-delta', 'tool-call-delta',
    'block-end', 'block-end', 'block-end',
    'usage', 'finish',
  ])
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(blocks[0], { type: 'reasoning', text: 'thinking' })
  assert.deepEqual(blocks[1], { type: 'text', text: 'Hello' })
  assert.deepEqual(blocks[2], { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"a":1}' })
  // Disjoint counts: prompt 10 minus 6 cached is 4 input tokens.
  const usage = chunks.find(chunk => chunk.type === 'usage').usage
  assert.equal(usage.inputTokens, 4)
  assert.equal(usage.outputTokens, 4)
  assert.equal(usage.cacheReadTokens, 6)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('translate reports an empty completion as the harness empty-response failure', async () => {
  const chunks = await drain(translate(
    ['{"choices":[{"delta":{},"finish_reason":"stop"}]}', '[DONE]'],
    (message, code) => Object.assign(new Error(message), { code }),
  ))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

test('translate accepts a stream that closes after a declared finish reason', async () => {
  const chunks = await drain(translate(
    ['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}'],
    (message, code) => Object.assign(new Error(message), { code }),
  ))
  assert.deepEqual(kinds(chunks), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('translate refuses a truncated stream and a malformed payload', async () => {
  const fail = (message, code) => Object.assign(new Error(message), { code })
  await assert.rejects(
    drain(translate(['{"choices":[{"delta":{"content":"hi"}}]}'], fail)),
    error => error.code === 'STREAM_CLOSED',
  )
  await assert.rejects(
    drain(translate(['not json'], fail)),
    error => error.code === 'MALFORMED_RESPONSE',
  )
})

test('mapFinishReason and mapUsage cover the vocabulary', () => {
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  assert.equal(mapFinishReason('content_filter').kind, 'error')
  assert.equal(mapUsage(undefined), undefined)
  assert.deepEqual(mapUsage({ prompt_tokens: 5, completion_tokens: 2 }), {
    inputTokens: 5, outputTokens: 2, totalTokens: 7,
  })
})

// ---------------------------------------------------------------------------
// Message serialization
// ---------------------------------------------------------------------------

test('serializeMessages maps roles, tool calls, and tool results', () => {
  const messages = serializeMessages({
    system: 'be brief',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', text: 'running' },
          { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      },
      {
        role: 'user',
        source: { kind: 'tool', callId: 'call_1' },
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] }],
      },
    ],
  })

  assert.deepEqual(messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'running',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
  ])
})

test('serializeMessages sends null content on a tool-call-only assistant turn', () => {
  const messages = serializeMessages({
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_9', name: 'read', arguments: '{}' }],
    }],
  })
  assert.equal(messages[0].content, null)
  assert.equal(messages[0].tool_calls.length, 1)
})

test('serializeMessages marks a failed tool result and refuses attachments', () => {
  const failed = serializeMessages({
    messages: [{
      role: 'user',
      source: { kind: 'tool', callId: 'c1' },
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        isError: true,
        content: [{ type: 'text', text: 'exit 1' }],
      }],
    }],
  })
  assert.equal(failed[0].content, '[tool error]\nexit 1')

  assert.throws(
    () => serializeMessages({
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
    }),
    error => error.code === 'UNSUPPORTED_CONTENT',
  )
})

// ---------------------------------------------------------------------------
// Against a mock llama.cpp server
// ---------------------------------------------------------------------------

test('context window is discovered from /props, not declared', async () => {
  const server = await startServer({ props: { default_generation_settings: { n_ctx: 65536 }, build_info: 'b1-x' } })
  try {
    const adapter = adapterFor(server.baseURL)
    const resolved = await adapter.resolveModel('llama-cpp', 'qwen3-4b')
    assert.deepEqual(resolved.context, { contextWindow: 65536 })
    // The output cap is the ceiling for a roomy window, and never the window.
    assert.equal(resolved.defaultMaxTokens, 32768)
    assert.equal(resolved.name, 'Qwen3 4B')
    assert.equal(resolved.provider, 'llama-cpp')
    assert.equal(resolved.id, 'qwen3-4b')
    // /props is asked for the exact model, so the answer is cached per model.
    assert.ok(server.requests.some(request => request.url === '/props?model=qwen3-4b'))
  } finally {
    await server.close()
  }
})

test('a server without /props falls back to the listing meta.n_ctx', async () => {
  const server = await startServer({ props: null })
  try {
    const adapter = adapterFor(server.baseURL)
    const resolved = await adapter.resolveModel('llama-cpp', 'qwen3-4b')
    assert.deepEqual(resolved.context, { contextWindow: 4096 })
    // 4096/4, because a small window must keep most of itself for the prompt.
    assert.equal(resolved.defaultMaxTokens, 1024)
  } finally {
    await server.close()
  }
})

test('an unknown model on a server that discloses nothing still resolves', async () => {
  const server = await startServer({ props: null })
  try {
    const adapter = adapterFor(server.baseURL)
    const resolved = await adapter.resolveModel('llama-cpp', 'never-listed')
    assert.equal(resolved.id, 'never-listed')
    assert.equal(resolved.context, undefined)
    assert.equal(resolved.defaultMaxTokens, 8192)
  } finally {
    await server.close()
  }
})

test('a pinned context window wins over the server answer', async () => {
  const server = await startServer({ props: { default_generation_settings: { n_ctx: 131072 } } })
  try {
    const adapter = adapterFor(server.baseURL, { contextWindow: 8192 })
    const resolved = await adapter.resolveModel('llama-cpp', 'qwen3-4b')
    assert.deepEqual(resolved.context, { contextWindow: 8192 })
    // The pinned window wins over what the server reports, and it is asked once
    // — for the template capability, which a pinned window does not supply.
    const probes = server.requests.filter(request => request.url.startsWith('/props')).length
    assert.equal(probes, 1)
    await adapter.resolveModel('llama-cpp', 'qwen3-4b')
    assert.equal(server.requests.filter(request => request.url.startsWith('/props')).length, 1)
  } finally {
    await server.close()
  }
})

test('listModels exposes the server catalog with its context sizes', async () => {
  const server = await startServer()
  try {
    const adapter = adapterFor(server.baseURL)
    const models = await adapter.listModels('llama-cpp')
    assert.equal(models.length, 2)
    assert.equal(models[0].id, 'qwen3-4b')
    assert.deepEqual(models[0].inputModalities, ['text'])
    assert.match(models[0].description, /4096/)
  } finally {
    await server.close()
  }
})

test('streaming a turn yields the harness chunk protocol end to end', async () => {
  const server = await startServer({
    props: { default_generation_settings: { n_ctx: 32768 }, chat_template: '{% if enable_thinking %}{% endif %}' },
    sse: sse([
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { reasoning_content: 'let me think' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' there' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]) + 'data: [DONE]\n\n',
  })
  try {
    const adapter = adapterFor(server.baseURL)
    const chunks = await drain(adapter.stream({
      provider: 'llama-cpp',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'high',
    }))

    assert.deepEqual(kinds(chunks), [
      'block-start', 'reasoning-delta',
      'block-start', 'text-delta', 'text-delta',
      'block-end', 'block-end', 'usage', 'finish',
    ])
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })

    const request = server.requests.find(entry => entry.url.startsWith('/v1/chat/completions'))
    const body = JSON.parse(request.body)
    assert.equal(body.model, 'qwen3-4b')
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
    // The template advertises enable_thinking, so an explicit effort reaches it.
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true })
    assert.equal(request.headers.authorization, 'Bearer no-key')
    assert.match(request.headers['user-agent'], /deepseek-harness/)
  } finally {
    await server.close()
  }
})

test('the thinking knob stays off a template that does not read it', async () => {
  const server = await startServer({
    props: { default_generation_settings: { n_ctx: 8192 }, chat_template: 'no knob here' },
    sse: sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, { choices: [], usage: {} }])
      + 'data: [DONE]\n\n',
  })
  try {
    const adapter = adapterFor(server.baseURL)
    await drain(adapter.stream({
      provider: 'llama-cpp',
      model: 'qwen3-4b',
      messages: [],
      reasoningEffort: 'high',
    }))
    const body = JSON.parse(server.requests.find(entry => entry.url.startsWith('/v1/chat/completions')).body)
    assert.equal(body.chat_template_kwargs, undefined)
  } finally {
    await server.close()
  }
})

test('a thinking template advertises reasoning levels, a plain template does not', async () => {
  const thinking = await startServer({
    props: { default_generation_settings: { n_ctx: 32768 }, chat_template: '{% if enable_thinking %}{% endif %}' },
  })
  const plain = await startServer({
    props: { default_generation_settings: { n_ctx: 32768 }, chat_template: 'no knob here' },
  })
  try {
    const withKnob = await adapterFor(thinking.baseURL).resolveModel('llama-cpp', 'qwen3-4b')
    // The harness refuses an explicit effort for a model that advertises none,
    // so a template that reads the knob has to say so.
    assert.deepEqual(withKnob.reasoning?.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high', 'max'])
    assert.equal(withKnob.reasoning?.defaultEffort, 'off')

    const withoutKnob = await adapterFor(plain.baseURL).resolveModel('llama-cpp', 'qwen3-4b')
    assert.equal(withoutKnob.reasoning, undefined)
  } finally {
    await thinking.close()
    await plain.close()
  }
})

test('a pinned context window still learns the template capability', async () => {
  const server = await startServer({
    props: { default_generation_settings: { n_ctx: 4096 }, chat_template: '{% if enable_thinking %}{% endif %}' },
  })
  try {
    const resolved = await adapterFor(server.baseURL, { contextWindow: 32768 })
      .resolveModel('llama-cpp', 'qwen3-4b')
    assert.deepEqual(resolved.context, { contextWindow: 32768 })
    assert.equal(resolved.reasoning?.efforts.length, 5)
  } finally {
    await server.close()
  }
})

test('the thinking knob reaches a cold first request, not just a warmed one', async () => {
  // The regression this guards: resolving for a request that then dispatches
  // without the resolution it just made leaves `enable_thinking` off the very
  // first call against a fresh adapter — the call that decides whether the turn
  // thinks or answers.
  const server = await startServer({
    props: { default_generation_settings: { n_ctx: 32768 }, chat_template: '{% if enable_thinking %}{% endif %}' },
    sse: sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]) + 'data: [DONE]\n\n',
  })
  try {
    const adapter = adapterFor(server.baseURL)
    const prepared = await adapter.prepareCall('llama-cpp', 'qwen3-4b')
    // The preflight already carries the discovered window, from the same answer
    // the request will use.
    assert.deepEqual(prepared.model.context, { contextWindow: 32768 })
    await drain(prepared.stream({
      provider: 'llama-cpp',
      model: 'qwen3-4b',
      messages: [],
      reasoningEffort: 'off',
    }))
    const body = JSON.parse(server.requests.find(entry => entry.url.startsWith('/v1/chat/completions')).body)
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
  } finally {
    await server.close()
  }
})

test('an HTTP failure surfaces as an LlmError carrying status and provider text', async () => {
  const server = await startServer({ chatStatus: 503, chatError: { error: { message: 'model not loaded' } } })
  try {
    const adapter = adapterFor(server.baseURL)
    await assert.rejects(
      drain(adapter.stream({ provider: 'llama-cpp', model: 'qwen3-4b', messages: [] })),
      (error) => {
        assert.equal(error.name, 'LlmError')
        assert.equal(error.code, 'PROVIDER_HTTP_ERROR')
        assert.equal(error.failure.status, 503)
        assert.match(error.message, /model not loaded/)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('prewarm probes the loaded model and reports what it found', async () => {
  const server = await startServer({ props: { default_generation_settings: { n_ctx: 16384 }, build_info: 'b42-abc' } })
  try {
    const adapter = adapterFor(server.baseURL)
    const found = await adapter.prewarm('llama-cpp')
    assert.equal(found.model, 'qwen3-4b')
    assert.equal(found.contextWindow, 16384)
    assert.equal(found.build, 'b42-abc')
    assert.equal(found.models, 2)
    // The loaded model is the one asked for, and it is asked to autoload.
    assert.ok(server.requests.some(request => request.url === '/props?model=qwen3-4b&autoload=true'))
    // Which is exactly the key a later request looks up: no second probe.
    const before = server.requests.filter(request => request.url.startsWith('/props')).length
    await adapter.resolveModel('llama-cpp', 'qwen3-4b')
    const after = server.requests.filter(request => request.url.startsWith('/props')).length
    assert.equal(after, before)
  } finally {
    await server.close()
  }
})

test('the profile supplies request defaults the request itself does not', async () => {
  const server = await startServer({
    props: { default_generation_settings: { n_ctx: 8192 } },
    sse: sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]) + 'data: [DONE]\n\n',
  })
  try {
    const adapter = adapterFor(server.baseURL, { maxTokens: 1024, temperature: 0.25 })
    const resolved = await adapter.resolveModel('llama-cpp', 'qwen3-4b')
    // A configured cap wins over the one derived from the context window.
    assert.equal(resolved.defaultMaxTokens, 1024)

    await drain(adapter.stream({
      provider: 'llama-cpp',
      model: 'qwen3-4b',
      messages: [],
      temperature: 0.9,
    }))
    const body = JSON.parse(server.requests.find(entry => entry.url.startsWith('/v1/chat/completions')).body)
    // The request's own temperature wins; maxTokens is left to the caller here.
    assert.equal(body.temperature, 0.9)

    server.requests.length = 0
    await drain(adapter.stream({ provider: 'llama-cpp', model: 'qwen3-4b', messages: [] }))
    const fallback = JSON.parse(server.requests.find(entry => entry.url.startsWith('/v1/chat/completions')).body)
    assert.equal(fallback.temperature, 0.25)
  } finally {
    await server.close()
  }
})

test('prewarm against a dead endpoint reports it instead of rejecting', async () => {
  const adapter = adapterFor('http://127.0.0.1:1/v1')
  const found = await adapter.prewarm('llama-cpp')
  assert.equal(found.models, 0)
  assert.match(found.error, /fetch failed/)
})

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('base URL normalization mirrors pi-llama LLAMA_BASE_URL handling', () => {
  assert.equal(normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080/v1')
  assert.equal(normalizeBaseUrl('http://localhost:8080/'), 'http://localhost:8080/v1')
  assert.equal(normalizeBaseUrl('http://localhost:8080/v1'), 'http://localhost:8080/v1')
  assert.equal(normalizeBaseUrl('https://llama.example.com/v1/'), 'https://llama.example.com/v1')
  assert.equal(normalizeBaseUrl('  http://127.0.0.1:9000  '), 'http://127.0.0.1:9000/v1')
})

test('a row config wins, then the environment, then the default', () => {
  const previous = { url: process.env.LLAMA_BASE_URL, key: process.env.LLAMA_API_KEY }
  try {
    delete process.env.LLAMA_BASE_URL
    delete process.env.LLAMA_API_KEY
    const bare = normalizeConfig({})
    assert.equal(bare.baseURL, 'http://localhost:8080/v1')
    assert.equal(bare.apiKey, 'no-key')
    assert.equal(bare.displayName, 'llama.cpp')
    assert.equal(bare.discoverContext, true)
    assert.equal(bare.logLevel, 'silent')

    process.env.LLAMA_BASE_URL = 'https://llama.example.com/v1'
    process.env.LLAMA_API_KEY = 'from-env'
    const fromEnv = normalizeConfig({})
    assert.equal(fromEnv.baseURL, 'https://llama.example.com/v1')
    assert.equal(fromEnv.apiKey, 'from-env')

    const explicit = normalizeConfig({
      baseURL: 'http://192.168.1.9:8080/v1',
      apiKey: 'from-row',
      displayName: 'Workstation 4090',
      contextWindow: 32768,
      headers: { 'x-team': 'local' },
      logLevel: 'info',
    })
    assert.equal(explicit.baseURL, 'http://192.168.1.9:8080/v1')
    assert.equal(explicit.apiKey, 'from-row')
    assert.equal(explicit.displayName, 'Workstation 4090')
    assert.equal(explicit.contextWindow, 32768)
    assert.deepEqual(explicit.headers, { 'x-team': 'local' })
    assert.equal(explicit.logLevel, 'info')

    // A pinned window is a positive integer or nothing at all.
    assert.equal(normalizeConfig({ contextWindow: 0 }).contextWindow, undefined)
    assert.equal(normalizeConfig({ contextWindow: 'nonsense' }).contextWindow, undefined)
  } finally {
    if (previous.url === undefined) delete process.env.LLAMA_BASE_URL
    else process.env.LLAMA_BASE_URL = previous.url
    if (previous.key === undefined) delete process.env.LLAMA_API_KEY
    else process.env.LLAMA_API_KEY = previous.key
  }
})
