/**
 * Browser-half verification for the llama.cpp provider card.
 *
 * The card is a React component that otherwise only ever runs inside the web
 * GUI, so it is rendered here in jsdom against stubbed remotes: no server, no
 * browser, no deployment. React and jsdom come from the harness checkout for
 * the same reason the Host-side tests do — the plugin has no dependencies of
 * its own — and the card is loaded through the same `__ModuleLoader__` seam
 * the page uses, so what is asserted is the module the browser will get.
 *
 * What is asserted is the shape the page and the reader depend on: closed until
 * asked, one status line carrying the endpoint's own dot, the fields only once
 * opened, and every probe answered through the Host's discovery seam — the one
 * remote call that actually reaches a llama.cpp server.
 *
 * Run with `npm test` (node --test).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { harnessRoot } from '../lib/harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = harnessRoot()

/**
 * Packages that link the client dependencies the card needs. jsdom is a root
 * dependency of the harness checkout; React is linked into the packages that
 * render with it, and the client test runtime is the one guaranteed to hold
 * both halves.
 */
const ANCHORS = [
  'packages/test-support/client-runtime/package.json',
  'packages/client/web/package.json',
  'packages/client/ui-theme/package.json',
  'package.json',
]

/** Resolve and load one module out of the harness checkout. */
function harnessRequire(specifier) {
  const tried = []
  for (const anchor of ANCHORS) {
    const path = join(ROOT, anchor)
    if (!existsSync(path)) continue
    const require = createRequire(path)
    try {
      return require(specifier)
    } catch (error) {
      tried.push(`${anchor} (${error.code ?? error.message})`)
    }
  }
  throw new Error(`card test: cannot resolve "${specifier}" from ${ROOT} — tried ${tried.join('; ')}`)
}

// The card is a browser module: it reads `window` and `document` at import
// time, so the DOM stands in for the page before it is loaded.
const { JSDOM } = harnessRequire('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = harnessRequire('react')
const { createRoot } = harnessRequire('react-dom/client')
const act = React.act

/** The card module, captured from the loader the page would call. */
let loaded
globalThis.window.__ModuleLoader__ = {
  load: (entry) => { loaded = entry },
}
await import(pathToFileURL(join(HERE, '..', 'client.mjs')).href)

const client = loaded.factory(specifier => harnessRequire(specifier))
const Card = client.LlamaCppCard

/** The settings row every render starts from, unless a test says otherwise. */
const CONFIGURED = {
  ns: 'llm-llamacpp',
  value: {
    baseURL: 'http://desktop:8080/v1',
    apiKey: 'no-key',
    contextWindow: null,
    maxTokens: null,
    temperature: null,
    probeTimeoutMs: null,
    discoverContext: true,
    logLevel: 'silent',
  },
  revision: 3,
  user: {},
  secrets: [],
}

/** Two models, the shape `llm/discoverModels` answers with. */
const MODELS = [
  { id: 'Qwen3.8-27B', name: 'Qwen3.8-27B', contextWindow: 113920 },
  { id: 'qwen3-4b', name: 'Qwen3 4B', contextWindow: 40960 },
]

/**
 * The client remote seam, recording every call.
 * @param {object} [answers] - overrides for the two namespaces.
 * @returns the stub plus its call log.
 */
function stubRemote(answers = {}) {
  const calls = { describe: 0, discover: [], replace: 0, mutate: 0 }
  const remote = {
    settings: {
      describe: async () => {
        calls.describe += 1
        return answers.describe === undefined
          ? { ok: true, value: { namespaces: [CONFIGURED] } }
          : answers.describe
      },
      replace: async (ns, section, revision) => {
        calls.replace += 1
        return { ok: true, value: { ...CONFIGURED, revision: revision + 1, value: { ...CONFIGURED.value, ...section } } }
      },
      mutate: async () => {
        calls.mutate += 1
        return { ok: true, value: { ...CONFIGURED, revision: CONFIGURED.revision + 1, user: {} } }
      },
    },
    llm: {
      discoverModels: async (ns, request) => {
        calls.discover.push({ ns, ...request })
        return answers.discover === undefined
          ? { ok: true, value: MODELS }
          : answers.discover
      },
    },
  }
  return { remote, calls }
}

/** Render one card into a fresh container and let its mount effects settle. */
async function mount(remote) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(Card, {
      provider: { provider: 'llama-cpp', displayName: 'llama.cpp', settingsNs: 'llm-llamacpp' },
      configured: true,
      keyConfigured: false,
      remote,
    }))
  })
  // One turn for `describe`, one for the probe it names.
  await act(async () => {})
  await act(async () => {})
  return {
    container,
    /** The summary line, which is the card's whole closed surface. */
    summary: () => container.querySelector('.dsh-llamacpp-summary'),
    dot: () => container.querySelector('.dsh-llamacpp-dot'),
    detail: () => container.querySelector('.dsh-llamacpp-summary-detail')?.textContent ?? '',
    inputs: () => [...container.querySelectorAll('input,select,textarea')].map(node => node.id),
    click: async (node) => { await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }) },
    button: label => [...container.querySelectorAll('button')].find(node => node.textContent.trim() === label),
    /** Type into a controlled React input, the way the browser would. */
    type: async (node, value) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(node, value)
        node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    },
    close: async () => { await act(async () => { root.unmount() }); container.remove() },
  }
}

test('the card is closed until asked, and says whether its endpoint answers', async () => {
  const { remote, calls } = stubRemote()
  const card = await mount(remote)
  try {
    assert.equal(card.summary()?.getAttribute('aria-expanded'), 'false')
    // Closed means closed: no field is on the page to be read or tabbed into.
    assert.deepEqual(card.inputs(), [])
    assert.equal(card.dot()?.className.includes('dsh-llamacpp-dot-connected'), true)
    assert.equal(card.summary()?.textContent.includes('Connected'), true)
    // The line names its own action; the page's Edit button is a different door.
    assert.equal(card.summary()?.querySelector('.dsh-llamacpp-summary-action')?.textContent, 'Configure')
    assert.equal(card.detail(), 'http://desktop:8080/v1 · 2 models')
    // The endpoint probed is the resolved one, not a placeholder.
    assert.deepEqual(calls.discover, [{ ns: 'llm-llamacpp', baseURL: 'http://desktop:8080/v1' }])
  } finally {
    await card.close()
  }
})

test('opening the card reveals every field, and closing it takes them away', async () => {
  const { remote } = stubRemote()
  const card = await mount(remote)
  try {
    await card.click(card.summary())
    assert.equal(card.summary()?.getAttribute('aria-expanded'), 'true')
    assert.equal(card.summary()?.querySelector('.dsh-llamacpp-summary-action')?.textContent, 'Collapse')
    assert.deepEqual(card.inputs(), [
      'llm-llamacpp-baseURL', 'llm-llamacpp-apiKey', 'llm-llamacpp-headers', 'llm-llamacpp-maxTokens',
      'llm-llamacpp-discoverContext', 'llm-llamacpp-probeTimeoutMs', 'llm-llamacpp-temperature',
      'llm-llamacpp-logLevel',
    ])
    assert.equal(card.container.querySelectorAll('details.dsh-llamacpp-details').length, 1)
    await card.click(card.summary())
    assert.deepEqual(card.inputs(), [])
  } finally {
    await card.close()
  }
})

test('an endpoint that does not answer is reported on the same line', async () => {
  const { remote } = stubRemote({
    discover: { ok: false, error: { message: 'llama.cpp: cannot reach http://desktop:8080/v1/models (fetch failed)' } },
  })
  const card = await mount(remote)
  try {
    assert.equal(card.dot()?.className.includes('dsh-llamacpp-dot-unreachable'), true)
    assert.equal(card.summary()?.textContent.includes('Not reachable'), true)
    // The reason names the endpoint already, so the line does not say it twice.
    assert.equal(card.detail(), 'llama.cpp: cannot reach http://desktop:8080/v1/models (fetch failed)')
    assert.equal(card.detail().split('http://desktop:8080/v1').length - 1, 1)
    // The failure is the card's own report, not a form error: the form is closed.
    assert.deepEqual(card.inputs(), [])
  } finally {
    await card.close()
  }
})

test('an endpoint that advertises nothing is not called connected', async () => {
  const { remote } = stubRemote({ discover: { ok: true, value: [] } })
  const card = await mount(remote)
  try {
    assert.equal(card.dot()?.className.includes('dsh-llamacpp-dot-unreachable'), true)
    assert.equal(card.detail().includes('advertised no models'), true)
  } finally {
    await card.close()
  }
})

test('Test connection probes the endpoint as typed and lists what it served', async () => {
  const { remote, calls } = stubRemote()
  const card = await mount(remote)
  try {
    await card.click(card.summary())
    await card.type(card.container.querySelector('#llm-llamacpp-baseURL'), 'http://other:9999')
    await card.click(card.button('Test connection'))
    assert.deepEqual(calls.discover.at(-1), { ns: 'llm-llamacpp', baseURL: 'http://other:9999' })
    assert.match(card.container.querySelector('pre')?.textContent ?? '', /Qwen3\.8-27B — 113920 token context/)
  } finally {
    await card.close()
  }
})

test('a save re-probes the endpoint the write left behind', async () => {
  const { remote, calls } = stubRemote()
  const card = await mount(remote)
  try {
    await card.click(card.summary())
    await card.type(card.container.querySelector('#llm-llamacpp-baseURL'), 'http://elsewhere:8080/v1')
    await card.click(card.button('Save'))
    await act(async () => {})
    await act(async () => {})
    assert.equal(calls.replace, 1)
    assert.deepEqual(calls.discover.at(-1), { ns: 'llm-llamacpp', baseURL: 'http://elsewhere:8080/v1' })
  } finally {
    await card.close()
  }
})

test('apply registers the card on the llama.cpp row through the slot seam', () => {
  const registered = []
  const injected = []
  const ctx = {
    slots: {
      inject: (name, activate) => { injected.push(name); activate() },
      register: (seat, render) => { registered.push({ seat, render }) },
    },
    remote: {},
  }
  client.apply(ctx)
  assert.deepEqual(client.inject, ['slots', 'remote', 'remote.settings', 'remote.llm'])
  assert.deepEqual(injected, ['settings.models.provider-card'])
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].seat, { name: 'settings.models.provider-card', key: 'llm-llamacpp' })
})
