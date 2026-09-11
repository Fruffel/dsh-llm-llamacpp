#!/usr/bin/env node
/**
 * Stand-in llama.cpp server, for verifying this provider without a model.
 *
 * It answers the three endpoints llama-server exposes, with the shapes the real
 * one uses, and it deliberately disagrees with itself the way a real server can:
 * the catalog advertises `meta.n_ctx` 8192 while `/props` reports 40960 for the
 * loaded model. A provider that reads `/props` resolves 40960; one that reads
 * only the listing resolves 8192 — which is exactly the difference this plugin
 * exists to make.
 *
 *   node test/mock-llamacpp-server.mjs --port 18080
 *   curl -s localhost:18080/props
 *
 * Then point the plugin's `baseURL` at it and reload the profile.
 */

import { createServer } from 'node:http'

/** What `/props` reports for the loaded model. */
const CONTEXT_WINDOW = 40960
/** What the catalog advertises, on purpose lower than the server's real window. */
const ADVERTISED_CONTEXT = 8192
/** The one model this stand-in serves. */
const MODEL = 'mock-qwen3-8b'

const portArg = process.argv.indexOf('--port')
const port = portArg === -1 ? 18080 : Number(process.argv[portArg + 1])

createServer((request, response) => {
  const send = (status, payload, type = 'application/json') => {
    response.writeHead(status, { 'content-type': type })
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  }

  if (request.url.startsWith('/v1/models')) {
    send(200, {
      data: [{
        id: MODEL,
        aliases: ['Mock Qwen3 8B'],
        status: { value: 'loaded' },
        meta: { n_ctx: ADVERTISED_CONTEXT },
      }],
    })
    return
  }

  if (request.url.startsWith('/props')) {
    send(200, {
      default_generation_settings: { n_ctx: CONTEXT_WINDOW },
      build_info: 'b9999-mock0',
      chat_template: '{% if enable_thinking %}{% endif %}',
    })
    return
  }

  if (request.url.startsWith('/v1/chat/completions')) {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const asked = JSON.parse(body)
      process.stdout.write(
        `chat: model=${asked.model} messages=${asked.messages?.length} max_tokens=${asked.max_tokens}\n`,
      )
      const chunk = payload => `data: ${JSON.stringify(payload)}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(chunk({ choices: [{ delta: { role: 'assistant', content: '' } }] }))
      response.write(chunk({ choices: [{ delta: { content: 'pong' } }] }))
      response.write(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      response.write(chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 1 } }))
      response.end('data: [DONE]\n\n')
    })
    return
  }

  send(404, { error: { message: 'not found' } })
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock llama.cpp on http://127.0.0.1:${port}/v1 (ctx ${CONTEXT_WINDOW})\n`)
})
