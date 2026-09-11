#!/usr/bin/env node
/**
 * Browser acceptance check for the llama.cpp provider card.
 *
 * Walks the real GUI into Settings → Models, expands the llama.cpp row, and
 * reports what the card actually rendered — plus any console error, which is
 * where a broken client bundle shows up. Chrome is driven over CDP with Node's
 * built-in WebSocket, so there is nothing to install.
 *
 * usage: node test/check-card.mjs [entry-url] [--keep-open] [--screenshot]
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEBUG_PORT = 9333
const PROFILE = join(tmpdir(), 'dsh-llamacpp-card-profile')
const CANDIDATES = [
  process.env.CHROME,
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
].filter(value => typeof value === 'string' && value !== '')

const args = process.argv.slice(2)
const keepOpen = args.includes('--keep-open')
const screenshot = args.includes('--screenshot')
const entry = args.find(value => !value.startsWith('--')) ?? 'http://127.0.0.1:3080/'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** First candidate that resolves to an executable path or a PATH lookup. */
function findChrome() {
  for (const candidate of CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    return candidate
  }
  return undefined
}

/** CDP page target URL of the headless browser, once it is listening. */
async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find(target => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('the browser exposed no page target')
}

/** Run one page-context expression and return its value. */
function makeEvaluate(send) {
  return async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }
}

/** Poll a page-context expression until it is truthy. */
async function waitFor(evaluate, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return
    } catch {}
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Click the first node whose text matches exactly. */
const CLICK = label => `(() => {
  const nodes = [...document.querySelectorAll('button,[role="button"],a,li,span,div')]
  const hit = nodes.find(node => node.children.length === 0 && node.textContent.trim() === ${JSON.stringify(label)})
    ?? [...document.querySelectorAll('button,[role="button"],a')].find(node => (node.getAttribute('aria-label') ?? node.textContent).trim() === ${JSON.stringify(label)})
  if (!hit) return false
  ;(hit.closest('button,[role="button"],a,li') ?? hit).click()
  return true
})()`

const chromePath = findChrome()
if (chromePath === undefined) {
  console.error('check-card: no Chrome found; set CHROME=/path/to/chrome')
  process.exit(1)
}

rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })

let close = () => {}
try {
  const socket = new WebSocket(await pageTarget())
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('CDP socket failed'))
  })

  let sequence = 0
  const pending = new Map()
  const consoleLines = []
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ')
      consoleLines.push(`${message.params.type}: ${text}`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      consoleLines.push(`exception: ${details.exception?.description ?? details.text}`)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, message => (message.error
      ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      : resolve(message.result)))
    socket.send(JSON.stringify({ id, method, params }))
  })
  close = () => socket.close()
  const evaluate = makeEvaluate(send)

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: entry })
  await waitFor(evaluate, '!!globalThis.__DSH_BOOT__', 'the client boot graph')
  await waitFor(evaluate, 'document.querySelectorAll("button,[role=button],a").length > 2', 'the shell chrome')
  await sleep(2500)

  const report = { entry, finalUrl: await evaluate('location.href') }

  if (!await evaluate(CLICK('Settings'))) throw new Error('no Settings trigger on the page')
  await sleep(1500)
  if (!await evaluate(CLICK('Models'))) throw new Error('no Models entry in the settings navigation')
  await sleep(3000)

  // The card sits on the provider's row and is only composed once that row's
  // details are expanded, so the row is opened before anything is read.
  report.page = await evaluate(`(() => {
    const panel = document.querySelector('[role="dialog"]') ?? document.body
    return panel.innerText.slice(0, 400)
  })()`)
  report.expanded = await evaluate(CLICK('llama.cpp'))
  await sleep(2500)

  report.card = await evaluate(`(() => {
    const pre = [...document.querySelectorAll('pre')].map(node => node.innerText)
    const inputs = [...document.querySelectorAll('input,select,textarea')]
      .filter(node => (node.id ?? '').startsWith('llm-llamacpp-'))
      .map(node => ({ id: node.id, value: node.type === 'checkbox' ? String(node.checked) : node.value }))
    const buttons = [...document.querySelectorAll('button')].map(node => node.textContent.trim())
      .filter(text => ['Save', 'Saved', 'Test connection', 'Reset to composition'].includes(text))
    return { inputs, buttons, pre }
  })()`)

  // Drive the card the way a person would: interrogate the endpoint, change a
  // field, save it, then put the section back the way it was.
  report.interactions = {}
  await evaluate(CLICK('Test connection'))
  await sleep(4000)
  report.interactions.discovery = await evaluate(`(() => {
    const pre = [...document.querySelectorAll('pre')].map(node => node.innerText).join('\\n')
    const failed = [...document.querySelectorAll('div')]
      .map(node => node.innerText).find(text => /cannot reach|HTTP \\d|no models/i.test(text ?? ''))
    return { pre, failed: failed ?? null }
  })()`)

  report.interactions.saved = await evaluate(`(() => {
    const field = document.querySelector('#llm-llamacpp-temperature')
    if (!field) return 'no temperature field'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(field, '0.35')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return field.value
  })()`)
  await sleep(600)
  await evaluate(CLICK('Save'))
  await sleep(3000)
  report.interactions.afterSave = await evaluate(`(() => ({
    status: [...document.querySelectorAll('div')].map(node => node.innerText).find(text => text === 'Saved') ?? null,
    temperature: document.querySelector('#llm-llamacpp-temperature')?.value ?? null,
    saveDisabled: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Saved')?.disabled ?? null,
  }))()`)

  await evaluate(CLICK('Reset to composition'))
  await sleep(3000)
  report.interactions.afterReset = await evaluate(`(() => ({
    temperature: document.querySelector('#llm-llamacpp-temperature')?.value ?? null,
    baseURL: document.querySelector('#llm-llamacpp-baseURL')?.value ?? null,
  }))()`)

  report.console = consoleLines.filter(line => /llama|error|exception|ModuleLoader|slot/i.test(line)).slice(0, 15)

  if (screenshot) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false })
    await sleep(500)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const path = join(tmpdir(), 'dsh-llamacpp-card.png')
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    report.screenshot = path
  }

  console.log(JSON.stringify(report, null, 2))
  const interactions = report.interactions ?? {}
  const ok = Array.isArray(report.card?.inputs) && report.card.inputs.length > 0
    && (interactions.discovery?.pre ?? '').includes('113920')
    && interactions.afterSave?.temperature === '0.35'
    && interactions.afterReset?.temperature === ''
  console.error(ok
    ? 'check-card: OK the card rendered, discovered the endpoint, saved, and reset'
    : 'check-card: FAIL see card/interactions in the report')
  process.exitCode = ok ? 0 : 1
} catch (error) {
  console.error('check-card: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
} finally {
  close()
  if (!keepOpen) chrome.kill('SIGKILL')
}
