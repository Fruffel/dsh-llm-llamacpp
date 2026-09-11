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
      const line = `${message.params.type}: ${text}`
      consoleLines.push(line)
      if (/llama|slot|error|exception/i.test(line)) console.error('check-card console> ' + line.slice(0, 400))
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      const line = `exception: ${details.exception?.description ?? details.text}`
      consoleLines.push(line)
      console.error('check-card console> ' + line.slice(0, 400))
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

  // The card sits on the provider's row, closed until it is asked for. What it
  // says while closed is read first — the status line is a finding in its own
  // right — and only then is it opened, the way a person would open it.
  report.page = await evaluate(`(() => {
    const panel = document.querySelector('[role="dialog"]') ?? document.body
    return panel.innerText.slice(0, 400)
  })()`)
  report.expanded = await evaluate(CLICK('llama.cpp'))
  await sleep(2500)

  report.closed = await evaluate(`(() => {
    const summary = document.querySelector('.dsh-llamacpp-summary')
    return {
      cardPresent: document.querySelector('.dsh-llamacpp-card') !== null,
      summary: summary === null ? null : summary.innerText.replace(/\\s+/g, ' '),
      expanded: summary === null ? null : summary.getAttribute('aria-expanded'),
      dot: summary === null ? null : (summary.querySelector('.dsh-llamacpp-dot')?.className ?? null),
      // Scoped to the card's own body: while closed, none of its fields exist.
      fields: document.querySelectorAll('.dsh-llamacpp-card [id^="llm-llamacpp-"]').length,
    }
  })()`)
  console.log('check-card: closed ' + JSON.stringify(report.closed))

  report.opened = await evaluate(`(() => {
    const summary = document.querySelector('.dsh-llamacpp-summary')
    if (summary === null) return false
    summary.click()
    return true
  })()`)
  await sleep(1200)

  report.card = await evaluate(`(() => {
    const pre = [...document.querySelectorAll('pre')].map(node => node.innerText)
    const inputs = [...document.querySelectorAll('input,select,textarea')]
      .filter(node => (node.id ?? '').startsWith('llm-llamacpp-'))
      .map(node => ({ id: node.id, value: node.type === 'checkbox' ? String(node.checked) : node.value }))
    const buttons = [...document.querySelectorAll('button')].map(node => node.textContent.trim())
      .filter(text => ['Save', 'Saved', 'Test connection', 'Reset to composition'].includes(text))
    return { inputs, buttons, pre }
  })()`)

  // What the card actually put on the page, read before anything is driven.
  report.diagnostic = await evaluate(`(() => ({
    cardPresent: document.querySelector('.dsh-llamacpp-card') !== null,
    stylePresent: document.getElementById('dsh-llamacpp-card-css') !== null,
    fieldIds: [...document.querySelectorAll('[id^="llm-llamacpp-"]')].map(node => node.id),
    panelTail: (document.querySelector('[role="dialog"]') ?? document.body).innerText.slice(-600),
  }))()`)
  console.log('check-card: diagnostic ' + JSON.stringify(report.diagnostic))

  // Drive the card the way a person would: interrogate the endpoint, change a
  // field, save it, then put the section back the way it was.
  report.interactions = {}
  // Whether the card's stylesheet is *applied* — the only question that matters,
  // and one the DOM cannot answer ambiguously the way a tag lookup can.
  report.interactions.styles = await evaluate(`(() => {
    const card = document.querySelector('.dsh-llamacpp-card')
    if (card === null) return { cardPresent: false }
    const style = getComputedStyle(card)
    const input = document.querySelector('#llm-llamacpp-baseURL')
    return {
      cardPresent: true,
      gap: style.gap,
      display: style.display,
      separator: style.borderTopWidth,
      inputRadius: input === null ? null : getComputedStyle(input).borderRadius,
      matchedRules: [...document.styleSheets].reduce((count, sheet) => {
        try { return count + [...sheet.cssRules].filter(rule => (rule.selectorText ?? '').includes('dsh-llamacpp')).length } catch { return count }
      }, 0),
    }
  })()`)

  report.interactions.advanced = await evaluate(
    'document.querySelectorAll("details.dsh-llamacpp-details").length')

  // Discovery on: the window is the server's answer, so no override is offered.
  report.interactions.discoveryOn = await evaluate(`(() => {
    const toggle = document.querySelector('#llm-llamacpp-discoverContext')
    const field = document.querySelector('#llm-llamacpp-contextWindow')
    return {
      checked: toggle?.checked ?? null,
      present: field !== null,
      probeVisible: document.querySelector('#llm-llamacpp-probeTimeoutMs') !== null,
    }
  })()`)

  // Discovery off: the pinned field takes its place and becomes required.
  await evaluate(`(() => {
    const toggle = document.querySelector('#llm-llamacpp-discoverContext')
    toggle.click()
    return true
  })()`)
  await sleep(600)
  report.interactions.discoveryOff = await evaluate(`(() => {
    const field = document.querySelector('#llm-llamacpp-contextWindow')
    return {
      present: field !== null,
      readOnly: field?.readOnly ?? null,
      type: field?.type ?? null,
      probeVisible: document.querySelector('#llm-llamacpp-probeTimeoutMs') !== null,
    }
  })()`)
  // Put the toggle back so the rest of the run starts from the real state.
  await evaluate(`(() => {
    document.querySelector('#llm-llamacpp-discoverContext').click()
    return true
  })()`)
  await sleep(600)

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
    // Closed first: one status line, no fields, and a dot that names its state.
    && report.closed?.cardPresent === true
    && report.closed?.expanded === 'false'
    && report.closed?.fields === 0
    && /dsh-llamacpp-dot-(connected|unreachable|checking)/.test(report.closed?.dot ?? '')
    && report.opened === true
    && interactions.styles?.cardPresent === true
    && interactions.styles?.display === 'flex'
    && interactions.styles?.inputRadius !== null
    && interactions.styles?.matchedRules > 5
    && interactions.advanced === 1
    // Discovery on: the server answers, so the window field is a readout that
    // no longer exists as an editable input, not a disabled one.
    && interactions.discoveryOn?.present === false
    && interactions.discoveryOn?.checked === true
    // Discovery off: an editable number takes its place.
    && interactions.discoveryOff?.present === true
    && interactions.discoveryOff?.readOnly === false
    && interactions.discoveryOff?.type === 'number'
    // The capability probe runs in both modes, so its timeout is always offered.
    && interactions.discoveryOn?.probeVisible === true
    && interactions.discoveryOff?.probeVisible === true
    && (interactions.discovery?.pre ?? '').includes('113920')
    && interactions.afterSave?.temperature === '0.35'
    && interactions.afterReset?.temperature === ''
  console.error(ok
    ? 'check-card: OK the closed status line, styling, conditional fields, discovery, save, and reset all behaved'
    : 'check-card: FAIL see card/interactions in the report')
  process.exitCode = ok ? 0 : 1
} catch (error) {
  console.error('check-card: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
} finally {
  close()
  if (!keepOpen) chrome.kill('SIGKILL')
}
