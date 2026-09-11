/**
 * Mount smoke test: drives the plugin's real `apply()` against a stub of the
 * two services it consumes, so the registration path itself is verified without
 * a harness process.
 *
 * This catches what unit tests cannot: a schema that the loader would reject, a
 * service call with the wrong shape, a disposer that never runs, and discovery
 * wired to the wrong namespace.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { apply, Config, PROVIDER_ID, SETTINGS_NS } from '../index.mjs'
import { setHarnessRoot } from '../lib/harness.mjs'

// `apply` re-points the harness root before the adapter module is evaluated;
// this test imports the adapter eagerly, so the default checkout is in force.
setHarnessRoot(process.env.DSH_HARNESS_ROOT ?? '/home/fruffel/Documents/dsh-ops/harness/builds/dsh-v0.1.5-rc.2')

/** A minimal stand-in for the harness `llm` service, recording every call. */
function stubLlm() {
  return {
    adapters: [],
    directory: [],
    discoveries: new Map(),
    registerAdapter(routes, adapter) {
      this.adapters.push({ routes, adapter })
    },
    registerConfigurableProviders(entries) {
      this.directory.push(...entries)
    },
    registerModelDiscovery(ns, discover) {
      this.discoveries.set(ns, discover)
    },
  }
}

/** A minimal stand-in for the harness `settings` service. */
function stubSettings() {
  return {
    installations: [],
    installSection(owner, ns, schema, entry, hooks) {
      this.installations.push({ ns, schema, entry, hooks })
    },
  }
}

/** A context that resolves `inject` synchronously, like cordis does for live services. */
function stubContext({ llm, settings, logs }) {
  const services = { llm, settings }
  const ctx = {
    logger: {
      info: message => logs.push(['info', message]),
      warn: message => logs.push(['warn', message]),
    },
    /**
     * The real `ctx.inject(names, cb)` starts a child fiber that waits for the
     * named services and then calls back with a context carrying them as
     * properties; with live services that is immediate and synchronous.
     */
    inject(names, callback) {
      const resolved = names.map(name => services[name])
      if (resolved.some(service => service === undefined)) return undefined
      for (const [index, name] of names.entries()) ctx[name] = resolved[index]
      return callback(ctx)
    },
  }
  return ctx
}

test('apply registers the route, the settings section, and discovery', async () => {
  const server = createServer((request, response) => {
    if (request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'mock-7b', status: { value: 'loaded' } }] }))
      return
    }
    if (request.url.startsWith('/props')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ default_generation_settings: { n_ctx: 20480 }, build_info: 'b7-mock' }))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const llm = stubLlm()
  const settings = stubSettings()
  const logs = []
  const ctx = stubContext({ llm, settings, logs })

  try {
    apply(ctx, {
      baseURL: `http://127.0.0.1:${port}`,
      displayName: 'Local llama.cpp',
      logLevel: 'info',
    })

    // One route, under the id a model selection names.
    assert.equal(llm.adapters.length, 1)
    assert.deepEqual(llm.adapters[0].routes, [PROVIDER_ID])
    assert.equal(llm.adapters[0].adapter.providerInfo(PROVIDER_ID).name, 'Local llama.cpp')

    // The Models page can offer and edit this route before it holds any model.
    assert.deepEqual(llm.directory, [{
      provider: PROVIDER_ID,
      displayName: 'Local llama.cpp',
      settingsNs: SETTINGS_NS,
      settingsPath: [],
    }])

    // The composition row is the settings section's base layer, so the same
    // fields are editable at runtime without touching the composition.
    assert.equal(settings.installations.length, 1)
    const installation = settings.installations[0]
    assert.equal(installation.ns, SETTINGS_NS)
    assert.equal(installation.entry.baseURL, `http://127.0.0.1:${port}/v1`)
    assert.equal(installation.entry.displayName, 'Local llama.cpp')
    assert.equal(typeof installation.schema?.['~standard']?.validate, 'function')

    // Discovery answers for the namespace a draft provider is being added to.
    assert.ok(llm.discoveries.has(SETTINGS_NS))
    const discovered = await llm.discoveries.get(SETTINGS_NS)({ baseURL: `http://127.0.0.1:${port}/v1` })
    assert.deepEqual(discovered, [{ id: 'mock-7b', name: 'mock-7b' }])

    // And the adapter resolves the context window it discovered at startup.
    const resolved = await llm.adapters[0].adapter.resolveModel(PROVIDER_ID, 'mock-7b')
    assert.deepEqual(resolved.context, { contextWindow: 20480 })

    // The background warm-up reports what it found, at info level.
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(
      logs.some(([, message]) => /context window 20480 tokens/.test(message)),
      `expected a context discovery log, got ${JSON.stringify(logs)}`,
    )
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('a row config reaches discovery when a draft names no endpoint of its own', async () => {
  const llm = stubLlm()
  const ctx = stubContext({ llm, settings: stubSettings(), logs: [] })
  apply(ctx, { baseURL: 'http://127.0.0.1:1', logLevel: 'silent' })
  // Port 1 refuses connections: discovery must reject with a readable reason,
  // which is what the Models page shows beside the field.
  await assert.rejects(
    llm.discoveries.get(SETTINGS_NS)({}),
    error => /cannot reach/.test(error.message),
  )
})

test('Config validates the row shape and keeps unknown fields out', () => {
  const validate = value => Config['~standard'].validate(value)
  const good = validate({ baseURL: 'http://localhost:8080/v1', discoverContext: false, logLevel: 'info' })
  assert.equal(good.issues, undefined)
  assert.equal(good.value.baseURL, 'http://localhost:8080/v1')
  assert.equal(good.value.discoverContext, false)

  const bad = validate({ contextWindow: -5 })
  assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0)
})
