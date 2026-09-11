# dsh-llm-llamacpp

A `llama-cpp` provider for the DeepSeek Harness: the harness-side twin of
[huggingface/pi-llama](https://github.com/huggingface/pi-llama).

A running `llama-server` is the whole configuration. The plugin reads the model
catalog from `GET /v1/models` and — the point of the exercise — the **context
window** from the server itself, so compaction, the token meter, and the GUI's
context display all size themselves to whatever the server has loaded right now.
Swap the model behind the server and the next turn already knows the new
window; nothing here has to be edited.

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

### Shipping a change

This repository is the source of truth; a deployment mounts a checkout of it.
On the machine it was developed on, the deployment is a `dsh-ops` checkout whose
`plugins.conf` names this repository, so the loop is:

```bash
# in this checkout
git commit && git push
# in the deployment
bin/dsh-plugins.sh --update      # fast-forwards the clone under plugins/
bin/dsh-install-assets.sh        # copies the package into the profile layer
systemctl --user restart dsh-web # the harness keeps the module it imported
```

Config edits (a new `baseURL`) take effect with **no restart** — the profile
reloads its patch layer, and the value is read per request. **Code** edits do
not: the harness holds the module it imported, so `index.mjs`, `client.mjs`, and
`lib/*.mjs` need the restart.

Two things the harness needs from the host machine:

* **`harnessRoot`** — where the harness checkout lives. The plugin imports the
  harness's own `LlmAdapter`, `LlmError`, and `attributionHeaders` from it so
  error identity and attribution stay exactly what the runtime expects. The
  field exists because the default is one machine's build path; set it to yours.
* **Node 22+**, which the harness already requires.

### The configuration card

The web GUI edits this provider in place. Settings → Models shows a row for
**llama.cpp** whose card stays closed until it is asked for: one status line
reports whether the configured endpoint answers — a green dot when it does, a
red one when it does not, with the reason beside it — which endpoint that is,
and how many models it serves. Clicking the line unfolds a card with every field
below, a **Test connection** button that interrogates the endpoint being typed
and reports the models and context window it finds, and **Reset to composition**,
which clears the section so the row's own values apply again.

That dot is the card's own, and deliberately so: llama.cpp ignores the
credential, so the page's own credential dot never lights for this family, and
nothing but a live probe can say whether the server behind the route is up. The
probe is the same `llm/discoverModels` call the **Test connection** button
makes, so the dot and the model list cannot disagree; it runs once when the card
appears and again after every save or reset.

That card is this package's browser half (`client.mjs`, declared as
`dsh.client` in `package.json`), registered into the `settings.models.provider-card`
slot under the `llm-llamacpp` key. Edits land in `llm-llamacpp` in the settings
document and reach the next request — no restart. Only a change to the plugin's
own code needs one.


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
| `contextWindow` | discovered | Pinned context size |
| `discoverContext` | `true` | Ask `/props`; a server that never answers still serves chat |
| `maxTokens` | derived from the context window | Output cap advertised per request |
| `temperature` | none | Applied when a request names none |
| `probeTimeoutMs` | `1500` | How long `/props` may take before a request proceeds without it |
| `logLevel` | `silent` | `info` logs what was discovered at startup |
| `harnessRoot` | this build's checkout | Harness to load the LLM seam from |

Every field is editable from the card except `displayName` and `harnessRoot`,
which stay composition-level: a display name belongs to the row that declares
the route, and the checkout path is a property of the machine, not of the
endpoint.

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
* **A base URL without `/v1` gets one**, so `http://host:8080` and
  `http://host:8080/v1` address the same server. If something else already holds
  the port you meant (`llama-server --port 18080`), the failure is a 404 or a
  hang from that other service, not from this plugin.
* The catalog is cached for 5s and a discovered context window for 60s; a
  restarted server is picked up on the next request after that.

## Verify

```bash
npm test                    # 44 tests, no network, no model
npm run mock                # a stand-in llama-server on 127.0.0.1:18080
npm run check:server -- http://desktop:8080/v1 off   # against a real server
npm run check:card -- "http://127.0.0.1:3080/?token=<launch token>"   # the GUI card
```

`check:card` drives headless Chrome over CDP through Settings → Models: it
reads the closed status line the llama.cpp row shows, opens the card, reads the
rendered fields, presses **Test connection**, saves a value, then resets — and
fails if any of that did not happen. It needs a Chrome/Chromium binary
(`CHROME=/path/to/chrome` overrides discovery; a Playwright-installed Chromium
works).

`npm test` covers the pure wire helpers, the chunk translation contract, the
adapter against a mock llama.cpp endpoint (streaming, tool calls, errors,
context discovery, fallbacks, reasoning capability, cold-start thinking), the
plugin's own `apply()` against stubs of the `llm` and `settings` services —
and the browser half, rendered in jsdom against stubbed remotes through the same
`__ModuleLoader__` seam the page uses (closed until asked, the endpoint's dot,
the fields it reveals, and the re-probe a write triggers).
The mock server deliberately advertises 8192 in the catalog and 40960 on
`/props`, so a resolution of 40960 proves the context came from the server.

`test/verify-against-server.mjs` is the other half: it drives a real
`llama-server` through the adapter and prints what it discovered and what a turn
actually produced, per thinking mode.
