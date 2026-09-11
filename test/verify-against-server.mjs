#!/usr/bin/env node
/**
 * Talk to a real llama-server through the adapter, with no harness involved.
 *
 * This is the check to run after any change to the adapter, against the actual
 * server a deployment points at: it prints the discovered context window, the
 * reasoning levels on offer, and one real turn per thinking mode.
 *
 *   node test/verify-against-server.mjs http://desktop:8080/v1
 *
 * It costs real generation, so it is not part of `npm test`.
 */

import { createAdapter } from '../lib/adapter.mjs'

const baseURL = process.argv[2] ?? 'http://localhost:18080/v1'
const effortList = process.argv.slice(3)
const efforts = effortList.length === 0 ? ['off', 'high'] : effortList
const prompt = 'Reply with exactly: pong'

const profile = {
  provider: 'llama-cpp',
  displayName: 'llama.cpp',
  baseURL,
  apiKey: 'no-key',
  headers: {},
}
const adapter = createAdapter({
  profile: () => profile,
  log: (method, message) => process.stdout.write(`[${method}] ${message}\n`),
})

const models = await adapter.listModels('llama-cpp')
if (models.length === 0) {
  process.stderr.write(`no models advertised by ${baseURL}\n`)
  process.exit(1)
}
process.stdout.write(`catalog: ${models.map(m => m.id).join(', ')}\n`)

const model = models[0].id
const resolved = await adapter.resolveModel('llama-cpp', model)
process.stdout.write(
  `resolved: context=${resolved.context?.contextWindow ?? 'unknown'}`
  + ` defaultMaxTokens=${resolved.defaultMaxTokens}`
  + ` thinking=${resolved.reasoning === undefined ? 'no' : 'yes'}\n`,
)

for (const effort of efforts) {
  const request = {
    provider: 'llama-cpp',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    reasoningEffort: effort,
    maxTokens: 64,
  }
  const prepared = await adapter.prepareCall('llama-cpp', model)
  let text = ''
  let reasoning = ''
  let usage
  let finish
  const started = Date.now()
  for await (const chunk of prepared.stream(request)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  process.stdout.write(
    `effort=${effort}: text=${JSON.stringify(text)} reasoningChars=${reasoning.length}`
    + ` outputTokens=${usage?.outputTokens ?? '?'} finish=${JSON.stringify(finish)}`
    + ` (${Date.now() - started}ms)\n`,
  )
}
