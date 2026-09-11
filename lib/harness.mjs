/**
 * Access to the running harness's own modules.
 *
 * This plugin lives beside the deployment rather than inside the harness
 * checkout, so a bare `import '@deepseek-ai/dsh-llm'` here resolves against the
 * wrong `node_modules` — or none at all. The harness is a pnpm workspace, so its
 * packages are reachable only from a package that depends on them; resolution is
 * therefore anchored at such a package inside the checkout, and the resolved
 * URL is imported dynamically.
 *
 * The harness's real `LlmAdapter`, `LlmError`, and `attributionHeaders` are used
 * rather than structural copies, so error identity, the `HarnessError` contract,
 * and provider attribution at the adapter boundary stay exactly what the retry
 * and failure-normalization paths expect.
 *
 * @module dsh-llm-llamacpp/lib/harness
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Default harness checkout for this machine. `harnessRoot` on the composition
 * row overrides it, which is what keeps the plugin portable: point it at
 * another checkout (or another release) and nothing else changes.
 */
export const DEFAULT_HARNESS_ROOT = '/home/fruffel/Documents/dsh-ops/harness/builds/dsh-v0.1.5-rc.2'

/**
 * The checkout in force for this plugin instance. The plugin's `apply` sets it
 * before the adapter module is imported (ESM defers that evaluation to the end
 * of the importing module's body), so a row that names another checkout gets
 * the harness classes from that checkout rather than the default one.
 */
let activeRoot

/**
 * Workspace packages that depend on the harness core, used only as resolution
 * anchors. The first one present wins; the order is deliberate, because an
 * anchor that exists but does not depend on the wanted module resolves nothing.
 */
const ANCHORS = [
  'packages/llm/llm-deepseek/package.json',
  'packages/llm/llm-pi-ai/package.json',
  'apps/cli/package.json',
  'package.json',
]

/**
 * Resolve the harness checkout to use.
 * @param {{ harnessRoot?: string }} [profile] - composition profile, when it declares a root.
 * @returns the checkout path.
 * @throws {Error} when the path does not hold a harness `package.json`.
 */
export function harnessRoot(profile = {}) {
  const root = profile.harnessRoot ?? activeRoot ?? process.env.DSH_HARNESS_ROOT ?? DEFAULT_HARNESS_ROOT
  if (!existsSync(join(root, 'package.json'))) {
    throw new Error(
      `llama.cpp provider: no harness checkout at ${root} — set harnessRoot on this plugin's row`,
    )
  }
  return root
}

/**
 * Point module resolution at one checkout. Idempotent, and safe to call before
 * any module has been resolved.
 * @param {string} root - harness checkout path.
 * @returns the validated checkout path.
 * @throws {Error} when the path does not hold a harness `package.json`.
 */
export function setHarnessRoot(root) {
  activeRoot = harnessRoot({ harnessRoot: root })
  return activeRoot
}

/**
 * Import one module out of a harness checkout.
 * @param {string} specifier - a package specifier the harness itself depends on.
 * @param {{ harnessRoot?: string }} [profile] - composition profile.
 * @returns {Promise<Record<string, unknown>>} the module namespace.
 * @throws {Error} when the specifier cannot be resolved from any anchor.
 */
export async function harnessModule(specifier, profile = {}) {
  const root = harnessRoot(profile)
  const tried = []
  for (const anchor of ANCHORS) {
    const anchorPath = join(root, anchor)
    if (!existsSync(anchorPath)) continue
    let resolved
    try {
      resolved = createRequire(anchorPath).resolve(specifier)
    } catch (error) {
      tried.push(`${anchor} (${error.code ?? error.message})`)
      continue
    }
    // Resolution succeeded, so a failure here is the harness itself — surface
    // it rather than reporting it as a resolution problem from another anchor.
    return import(resolved)
  }
  throw new Error(
    `llama.cpp provider: cannot resolve "${specifier}" from the harness at ${root}`
    + (tried.length === 0 ? ' — no resolution anchor found' : ` — tried ${tried.join('; ')}`),
  )
}
