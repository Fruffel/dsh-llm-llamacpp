# dsh-llm-llamacpp

A `llama-cpp` provider for the DeepSeek Harness: the harness-side twin of
[huggingface/pi-llama](https://github.com/huggingface/pi-llama).

A running `llama-server` is the whole configuration. The plugin reads the model
catalog from `GET /v1/models` and — the point of the exercise — the **context
window** from the server itself, so compaction, the token meter, and the GUI's
context display all size themselves to whatever the server has loaded right now.
Swap the model behind the server and the next turn already knows the new
window; nothing in this deployment has to be edited.

```
GET /props     → default_generation_settings.n_ctx  ← authoritative context window
                 chat_template                      ← decides the thinking capability
GET /v1/models → data[].meta.n_ctx                  ← fallback when /props is absent
row contextWindow                                   ← your pinned override, wins over both
```

Both facts come from the same probe, and the probe is raced against a 1.5s
deadline: a slow or unreachable server costs a little latency once, never the
answer — the next call finds it cached. Context windows are cached for 60s, the
template capability for as long as the model stays put.

## Install

The plugin is one self-contained package: copy this directory anywhere on the
machine running the harness, and mount it from the profile's patch file.

```yaml
- insert:
    - id: llm-llamacpp
      name: /absolute/path/to/dsh-llm-llamacpp/index.mjs
      config:
        baseURL: http://localhost:8080/v1
```

The web profile live-reloads `cordis.patch.yml`, so the provider appears without
a restart. `journalctl --user -u dsh-web -f` shows the mount and any diagnostic.

Two things the harness needs from the host machine:

* **`harnessRoot`** — where the harness checkout lives. The plugin imports the
  harness's own `LlmAdapter`, `LlmError`, and `attributionHeaders` from it so
  error identity and attribution stay exactly what the runtime expects. The
  default is this deployment's build path; set the field to use another.
* **Node 22+**, which the harness already requires.

### This deployment (dsh-ops)

The package also lives in the `dsh-ops` checkout as `plugins/dsh-llm-llamacpp/`,
where the installer deploys every package it finds:

```bash
cd ~/Documents/dsh-ops && npm run assets     # copies plugins + renders the patch
```

## Configure

One row in `harness/cordis.patch.web.yml` (which the installer renders into
`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: llm-llamacpp
      name: ./dsh-llm-llamacpp/index.mjs
      config:
        baseURL: http://localhost:18080/v1   # ← the one knob
        displayName: llama.cpp
```

`baseURL` resolves in this order: this row, then `LLAMA_BASE_URL` in the
environment, then `http://localhost:8080/v1`. A value without a trailing `/v1`
gets one, so `http://host:8080` and `http://host:8080/v1` are the same endpoint.

| Field | Default | Meaning |
| --- | --- | --- |
| `baseURL` | env `LLAMA_BASE_URL`, then `http://localhost:8080/v1` | llama.cpp API base |
| `apiKey` | env `LLAMA_API_KEY`, then `no-key` | Bearer token; ignored unless `llama-server --api-key` is set |
| `headers` | none | Extra request headers, for a proxy in front of the server |
| `displayName` | `llama.cpp` | Name in provider selectors |
| `contextWindow` | discovered | Pinned context size; skips discovery entirely when set |
| `discoverContext` | `true` | Ask `/props`; a server that never answers still serves chat |
| `harnessRoot` | this build's checkout | Harness to load the LLM seam from |
| `logLevel` | `silent` | `info` logs what was discovered at startup |

Every field is also the base layer of the **`llm-llamacpp` settings section**,
so the Settings and Models pages edit the live endpoint without touching the
composition or restarting anything. Resolution is per call: a settings change
reaches the next request.

## Use

The route id is `llama-cpp` and the model id is whatever the server advertises
(`GET /v1/models`, e.g. the GGUF alias). Select it as the session model, or set
it as the default in `~/.dsh/settings.yaml`:

```yaml
agent-default-model:
  provider: llama-cpp
  model: Qwen3-8B-Q4_K_M
```

## Reloading

The web profile live-reloads `cordis.patch.yml`, so **config** edits (a new
`baseURL`) apply to the next request with no restart. Editing the plugin's own
**code** does not: the harness's module graph keeps the version it imported, so
a changed `index.mjs`/`lib/*.mjs` needs `npm run assets` followed by a
`dsh-web` restart to take effect.

## Notes and limits

* **Text only.** A message carrying an image or file attachment fails with
  `UNSUPPORTED_CONTENT` rather than silently dropping it. Vision models report
  their modality in the catalog, but projection is not implemented here.
* **Thinking.** llama.cpp has no effort ladder, so a template that reads
  `enable_thinking` advertises `off | low | medium | high | max`, where `off`
  sends `enable_thinking: false` and every other level sends `true`; the default
  is `off`. A template without the knob advertises no reasoning at all, and the
  harness then refuses an explicit effort instead of silently ignoring it.
  Measured on Qwen3.8-27B: `off` answers in 2 tokens with no reasoning, `high`
  spends 33 reasoning tokens before the same answer.
* **Port 8080 is coolify-proxy on this machine.** Point `baseURL` at another
  port (`llama-server --port 18080`) or the requests reach the proxy.
* The catalog is cached for 5s and a discovered context window for 60s; a
  restarted server is picked up on the next request after that.

## Verify

```bash
npm test                                   # 36 tests, no network, no model
node test/mock-llamacpp-server.mjs --port 18080   # then point baseURL at it
node test/verify-against-server.mjs http://desktop:8080/v1 off   # against a real server
```

`npm test` covers the pure wire helpers, the chunk translation contract, the
adapter against a mock llama.cpp endpoint (streaming, tool calls, errors,
context discovery, fallbacks, reasoning capability, cold-start thinking), and
the plugin's own `apply()` against stubs of the `llm` and `settings` services.
The mock server deliberately advertises 8192 in the catalog and 40960 on
`/props`, so a resolution of 40960 proves the context came from the server.

`test/verify-against-server.mjs` is the other half: it drives a real
`llama-server` through the adapter and prints what it discovered and what a turn
actually produced, per thinking mode.
