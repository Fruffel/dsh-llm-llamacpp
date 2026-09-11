/**
 * Translate llama.cpp chat-completions SSE chunks into the harness
 * `StreamChunk` protocol.
 *
 * The wire shape is OpenAI's, with one llama.cpp addition: reasoning arrives as
 * `delta.reasoning_content` (or `delta.reasoning` on some templates), and the
 * server may repeat a delta's already-sent reasoning one token at a time. One
 * stateful block is kept per content, reasoning, or tool-call index, so deltas
 * interleave safely; `block-end`, `usage`, and `finish` are deferred until the
 * `[DONE]` sentinel, which guarantees nothing follows `finish` even when the
 * server attaches usage to a trailing chunk of its own.
 *
 * @module dsh-llm-llamacpp/lib/translate
 */

import { DONE } from './wire.mjs'

/**
 * Map the wire finish vocabulary onto the harness finish reason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values become an in-band error finish.
 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() },
      }
  }
}

/**
 * Map llama.cpp/OpenAI usage counters onto the harness convention, whose
 * counts are DISJOINT: prompt tokens minus cached prompt tokens is the input
 * count, and cached tokens are reported separately.
 * @param usage - the wire `usage` object.
 * @returns harness token usage, or `undefined` when the payload carries no counters.
 */
export function mapUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const prompt = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : undefined
  const completion = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : undefined
  if (prompt === undefined && completion === undefined) return undefined
  const cached = Number.isFinite(usage.prompt_tokens_details?.cached_tokens)
    ? usage.prompt_tokens_details.cached_tokens
    : undefined
  const reasoning = Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)
    ? usage.completion_tokens_details.reasoning_tokens
    : undefined
  const inputTokens = Math.max(0, (prompt ?? 0) - (cached ?? 0))
  const outputTokens = completion ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + (cached ?? 0),
    ...cached === undefined ? {} : { cacheReadTokens: cached },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/**
 * Accept one streamed tool-call identity field. `id` and `name` are identity,
 * not accumulation: the wire sends each once, on the call's first delta, and a
 * continuation that re-sends the field empty or null means "no update".
 * @param current - identity established by an earlier delta.
 * @param incoming - the field as parsed from this delta.
 * @returns the identity in force after this delta.
 */
function acceptIdentity(current, incoming) {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/** The reasoning field spellings llama.cpp builds emit. */
function reasoningOf(delta) {
  const value = delta?.reasoning_content ?? delta?.reasoning
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** One unterminated content block under assembly. */
function openBlock(index, kind) {
  return { index, kind, text: '', callId: undefined, name: undefined }
}

/** Materialize the final `ContentBlock` for one open block. */
function closeBlock(block) {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    default: return {
      type: 'tool-call',
      id: block.callId ?? '',
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE payloads and yield harness stream chunks.
 *
 * A malformed JSON payload throws `MALFORMED_RESPONSE` through the caller's
 * error factory rather than ending the stream quietly: a response that cannot
 * be parsed is not a response. A `stop` finish with no content at all is
 * reported as the harness `EMPTY_RESPONSE` failure, matching the shipped
 * adapters, because an empty assistant message silently ends a turn.
 *
 * @param payloads - SSE data payloads, `[DONE]`-terminated.
 * @param fail - builds the adapter's error type from `(message, code)`.
 * @yields {import('./types.mjs').StreamChunk} deltas as they arrive; block ends, usage, and the finish come last.
 */
export async function* translate(payloads, fail) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage
  let sawDone = false

  const open = (kind) => {
    const block = openBlock(nextIndex++, kind)
    order.push(block)
    return block
  }

  const finish = function* () {
    for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
    if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
    const reason = pendingFinish ?? { kind: 'stop' }
    yield {
      type: 'finish',
      reason: reason.kind === 'stop' && order.length === 0
        ? {
          kind: 'error',
          failure: {
            message: 'model returned a completed response with no content',
            code: 'EMPTY_RESPONSE',
          },
        }
        : reason,
    }
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      sawDone = true
      yield* finish()
      return
    }

    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      throw fail(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
      const delta = choice?.delta

      const reasoning = reasoningOf(delta)
      if (reasoning !== undefined) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
        const key = Number.isInteger(call?.index) ? call.index : toolBlocks.size
        let block = toolBlocks.get(key)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(key, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.callId = acceptIdentity(block.callId, call?.id)
        block.name = acceptIdentity(block.name, call?.function?.name)
        const fragment = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId ?? '',
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: fragment,
        }
      }

      if (typeof choice?.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }

    // Usage arrives either attached to the finish chunk or as a trailing
    // usage-only chunk; keep the latest of whichever shape the build sends.
    const usage = mapUsage(chunk?.usage)
    if (usage !== undefined) pendingUsage = usage
  }

  if (sawDone) return
  // The connection closed without the sentinel. A declared finish reason still
  // makes the response usable — some proxies close the stream instead of
  // sending `[DONE]` — but an abrupt close mid-response must not be reported
  // as a completed turn.
  if (pendingFinish !== undefined) {
    yield* finish()
    return
  }
  throw fail('SSE stream ended without a finish reason or [DONE]', 'STREAM_CLOSED')
}
