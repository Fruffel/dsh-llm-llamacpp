window.__ModuleLoader__.load({
	id: "dsh-llm-llamacpp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/**
		 * Browser half of the llama.cpp provider: the configuration card that
		 * appears on this provider's row in Settings → Models.
		 *
		 * The page dispatches this slot with only the provider row
		 * (`provider`, `configured`, `keyConfigured`), so the card owns its own
		 * data: it reads the `llm-llamacpp` namespace through `remote.settings`
		 * and writes it back through the same seam. Nothing here restates the
		 * Host's schema — the key table below names each control once, and the
		 * Host validates whatever comes back.
		 *
		 * Fields appear only where they decide something. With discovery on, the
		 * server owns the context window, so the card says so instead of offering
		 * an override that would silently win; turning discovery off reveals the
		 * pinned field in its place.
		 *
		 * The card is closed until asked for: one line reports whether the
		 * configured endpoint answers, which endpoint that is, and how many models
		 * it serves, and the fields unfold behind it. That line carries the dot the
		 * page cannot draw — llama.cpp ignores the credential, so the row's own
		 * credential dot never lights for this family, and the page cannot know
		 * whether the server behind the route is up. Discovery is the seam that
		 * actually reaches the server, so the dot is read from the same call the
		 * Test connection button makes and the two can never disagree.
		 */

		/** Settings namespace this provider's profile lives in. */
		const NS = "llm-llamacpp";
		/** Slot this card occupies, keyed by that same namespace. */
		const SLOT = "settings.models.provider-card";

		/** The probe state before the first answer: a dot that claims nothing yet. */
		const CHECKING = Object.freeze({ status: "checking", base: "", models: [], message: undefined });
		/** Dot colour per probe state — the whole status vocabulary, in one map. */
		const DOT_CLASS = {
			checking: "dsh-llamacpp-dot-checking",
			connected: "dsh-llamacpp-dot-connected",
			unreachable: "dsh-llamacpp-dot-unreachable",
		};
		/** The word the dot is read as. */
		const DOT_LABEL = { checking: "Checking", connected: "Connected", unreachable: "Not reachable" };

		/** Fields whose emptiness means "no override" rather than "an empty value". */
		const NULLABLE = new Set(["contextWindow", "maxTokens", "temperature", "probeTimeoutMs"]);
		/** Every key the card edits, in form order. */
		const KEYS = [
			"baseURL", "apiKey", "headers", "contextWindow", "maxTokens",
			"temperature", "probeTimeoutMs", "discoverContext", "logLevel",
		];

		/** Render a resolved profile back into the strings the form edits. */
		function toDraft(value) {
			const source = value ?? {};
			const draft = {};
			for (const key of KEYS) {
				const current = source[key];
				if (key === "discoverContext") {
					draft[key] = current === undefined ? true : current === true;
				} else if (key === "headers") {
					draft[key] = mapToText(current);
				} else {
					draft[key] = current === undefined || current === null ? "" : String(current);
				}
			}
			return draft;
		}

		/** Render a header map as the `name: value` lines the form edits. */
		function mapToText(map) {
			if (typeof map !== "object" || map === null) return "";
			return Object.entries(map).map(([name, value]) => `${name}: ${value}`).join("\n");
		}

		/** Parse those lines back into a header map, ignoring anything malformed. */
		function textToMap(text) {
			const map = {};
			for (const line of String(text).split("\n")) {
				const at = line.indexOf(":");
				if (at <= 0) continue;
				const name = line.slice(0, at).trim();
				const value = line.slice(at + 1).trim();
				if (name.length > 0 && value.length > 0) map[name] = value;
			}
			return map;
		}

		/**
		 * The patch to write: only what changed, with an emptied optional field
		 * written as `null` — the wire's way of saying "no override", which the
		 * Host resolves back to the composition row's value.
		 */
		function patchOf(base, draft) {
			const baseDraft = toDraft(base);
			const patch = {};
			for (const key of KEYS) {
				if (draft[key] === baseDraft[key]) continue;
				if (key === "discoverContext") {
					patch[key] = draft[key] === true;
					continue;
				}
				if (key === "headers") {
					patch[key] = textToMap(draft[key]);
					continue;
				}
				const raw = String(draft[key] ?? "").trim();
				if (raw.length === 0) {
					if (NULLABLE.has(key)) patch[key] = null;
					continue;
				}
				if (key === "temperature") {
					const parsed = Number.parseFloat(raw);
					if (Number.isFinite(parsed)) patch[key] = parsed;
					continue;
				}
				if (NULLABLE.has(key)) {
					const parsed = Number.parseInt(raw, 10);
					if (Number.isFinite(parsed)) patch[key] = parsed;
					continue;
				}
				patch[key] = raw;
			}
			return patch;
		}

		/**
		 * Ask one endpoint what it serves, through the Host's discovery seam.
		 *
		 * Never throws: a probe that fails is an answer too — the card reports it
		 * beside the dot rather than letting it take the form down with it.
		 * @param remote - the client's remote service.
		 * @param baseURL - the endpoint to interrogate; empty asks for the applied one.
		 * @returns the models it serves, or the message that says why it served none.
		 */
		async function askEndpoint(remote, baseURL) {
			try {
				const answer = await remote.llm.discoverModels(NS, baseURL.length === 0 ? {} : { baseURL });
				if (answer.ok === true) return { models: answer.value ?? [] };
				const failure = answer.error;
				return { failure: failure === undefined ? "the Host refused this request" : failure.message };
			} catch (error) {
				return { failure: error.message };
			}
		}

		/**
		 * What the status line says after its first word.
		 *
		 * A reachable endpoint is named before anything else — which server the
		 * route points at is the fact a reader opens this row for — while a failure
		 * is its own message, which usually names the endpoint already, so it is
		 * not repeated after it.
		 */
		function summaryDetail(endpoint) {
			const message = endpoint.message ?? "";
			if (endpoint.status === "connected") {
				const models = endpoint.models.length === 1 ? "1 model" : `${endpoint.models.length} models`;
				return [endpoint.base, models].filter(part => part.length > 0).join(" · ");
			}
			if (endpoint.status === "unreachable") {
				return [message, message.includes(endpoint.base) ? "" : endpoint.base]
					.filter(part => part.length > 0).join(" · ");
			}
			return endpoint.base;
		}

		/** Unwrap one remote answer, or throw the Host's own diagnostic. */
		function unwrap(answer) {
			if (answer !== undefined && answer.ok === true) return answer.value;
			const failure = answer === undefined ? undefined : answer.error;
			throw new Error(failure === undefined ? "the Host refused this request" : failure.message);
		}

		/**
		 * The card's stylesheet.
		 *
		 * Injected once, into a link the plugin's own fiber removes again. Every
		 * colour is a theme alias, so the card follows light and dark without a
		 * second rule set, and each class is package-scoped because a slot shares
		 * the page with everything else.
		 */
		const CSS = `
.dsh-llamacpp-card {
  margin-top: 0.75rem;
  padding-top: 0.875rem;
  border-top: 1px solid var(--dsw-alias-border-l1);
  display: flex;
  flex-direction: column;
  gap: 1rem;
  font-size: 0.8125rem;
  color: var(--dsw-alias-label-primary);
}
.dsh-llamacpp-summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  box-sizing: border-box;
  padding: 0.45rem 0.6rem;
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 0.5rem;
  cursor: pointer;
}
.dsh-llamacpp-summary:hover {
  border-color: var(--dsw-alias-border-l2);
}
.dsh-llamacpp-summary:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-llamacpp-dot {
  box-sizing: border-box;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dsh-llamacpp-dot-connected {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-llamacpp-dot-unreachable {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-llamacpp-dot-checking {
  background: var(--dsw-alias-label-secondary);
  opacity: 0.5;
}
.dsh-llamacpp-summary-state {
  flex: none;
  font-weight: 600;
}
.dsh-llamacpp-summary-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
.dsh-llamacpp-chevron {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 0.6875rem;
}
.dsh-llamacpp-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.dsh-llamacpp-note {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}
.dsh-llamacpp-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.dsh-llamacpp-legend {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
}
.dsh-llamacpp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem 1rem;
  align-items: start;
}
.dsh-llamacpp-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.dsh-llamacpp-label {
  font-size: 0.75rem;
  font-weight: 500;
}
.dsh-llamacpp-hint {
  font-size: 0.6875rem;
  line-height: 1.45;
  color: var(--dsw-alias-label-secondary);
}
.dsh-llamacpp-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.4rem 0.55rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 0.5rem;
}
.dsh-llamacpp-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-llamacpp-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.dsh-llamacpp-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 0.5rem;
  background: var(--dsw-alias-bg-layer-2);
  font-size: 0.75rem;
  cursor: pointer;
}
.dsh-llamacpp-toggle input {
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.dsh-llamacpp-details {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 0.5rem;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-llamacpp-details > summary {
  padding: 0.45rem 0.6rem;
  font-size: 0.75rem;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  user-select: none;
}
.dsh-llamacpp-details[open] > summary {
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-llamacpp-details > .dsh-llamacpp-grid {
  padding: 0.75rem 0.6rem;
}
.dsh-llamacpp-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.dsh-llamacpp-button {
  padding: 0.35rem 0.75rem;
  font: inherit;
  font-size: 0.75rem;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 0.5rem;
  cursor: pointer;
}
.dsh-llamacpp-button:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-llamacpp-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dsh-llamacpp-button-primary:not(:disabled) {
  color: var(--dsw-alias-bg-base);
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}
.dsh-llamacpp-status {
  font-size: 0.75rem;
  color: var(--dsw-alias-state-success-primary);
}
.dsh-llamacpp-error {
  font-size: 0.75rem;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-llamacpp-readout {
  margin: 0;
  padding: 0.5rem 0.6rem;
  border-radius: 0.5rem;
  background: var(--dsw-alias-bg-layer-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6875rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
`;

		/** Attach the stylesheet once, and let the plugin's fiber take it away again. */
		/**
		 * Attach the card's stylesheet, once per document.
		 *
		 * Deliberately not registered as a fiber effect: a hot reload unloads and
		 * re-applies this module without re-running a disposer's counterpart, so
		 * a fiber-owned tag would be stripped and never restored. The tag is
		 * idempotent by id, and it is one scoped stylesheet on a page the card is
		 * already part of.
		 * @returns whether this call added the tag.
		 */
		function mountStyles() {
			const id = "dsh-llm-llamacpp-card-css";
			if (typeof document === "undefined") return false;
			// `querySelector` rather than `getElementById`: the two disagree in
			// headless Chromium about a style element this code just appended, and
			// the selector is the one that answers correctly in both.
			if (document.querySelector(`style#${id}`) !== null) return false;
			const tag = document.createElement("style");
			tag.id = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return true;
		}

		/** One labelled control, with its hint beneath it. */
		function Field(props) {
			return React.createElement("div", { className: "dsh-llamacpp-field" },
				props.label === undefined
					? null
					: React.createElement("label", { className: "dsh-llamacpp-label", htmlFor: props.id }, props.label),
				props.children,
				props.hint === undefined
					? null
					: React.createElement("span", { className: "dsh-llamacpp-hint" }, props.hint),
			);
		}

		/**
		 * The provider's configuration card.
		 * @param props - the hosted card's share: the provider row it sits on.
		 * @returns the card.
		 */
		function LlamaCppCard(props) {
			const { provider, remote } = props;
			const [namespace, setNamespace] = React.useState(null);
			const [draft, setDraft] = React.useState(() => toDraft(undefined));
			const [busy, setBusy] = React.useState(true);
			const [status, setStatus] = React.useState(null);
			const [failure, setFailure] = React.useState(null);
			const [discovered, setDiscovered] = React.useState(null);
			const [endpoint, setEndpoint] = React.useState(CHECKING);
			const [open, setOpen] = React.useState(false);

			/** Read the section, and name the endpoint the first probe should ask. */
			const load = React.useCallback(async () => {
				try {
					const answer = unwrap(await remote.settings.describe());
					const row = answer.namespaces.find(candidate => candidate.ns === NS);
					setNamespace(row ?? null);
					const resolved = toDraft(row === undefined ? undefined : row.value);
					setDraft(resolved);
					setFailure(row === undefined ? `The Host registered no "${NS}" settings section.` : null);
					return resolved.baseURL;
				} catch (error) {
					setFailure(error.message);
					return "";
				} finally {
					setBusy(false);
				}
			}, [remote]);

			/**
			 * Ask the endpoint the form names what it serves, and keep the answer as
			 * the card's connection state.
			 *
			 * Run on mount with the resolved value and after every write with the
			 * value that write left behind, so the dot describes the endpoint the
			 * next request will reach rather than the one being typed.
			 */
			const probe = React.useCallback(async (baseURL) => {
				setEndpoint({ ...CHECKING, base: baseURL });
				const answer = await askEndpoint(remote, baseURL);
				setEndpoint(answer.models === undefined
					? { status: "unreachable", base: baseURL, models: [], message: answer.failure }
					: answer.models.length === 0
						? {
							status: "unreachable", base: baseURL, models: [],
							message: "the endpoint advertised no models",
						}
						: { status: "connected", base: baseURL, models: answer.models, message: undefined });
				return answer;
			}, [remote]);

			// The card owns its stylesheet: an idempotent mount here means the
			// styles are present whenever the card is, whatever the module
			// lifecycle did before this render.
			React.useEffect(() => {
				mountStyles();
			}, []);

			React.useEffect(() => {
				setBusy(true);
				void load().then(baseURL => probe(baseURL));
			}, [load, probe]);

			const value = namespace === null ? undefined : namespace.value;
			const discovery = draft.discoverContext === true;
			const patch = patchOf(value, draft);
			const changed = Object.keys(patch).length > 0;

			const edit = (key, next) => {
				setDraft(current => ({ ...current, [key]: next }));
			};

			const write = async (section, done) => {
				setBusy(true);
				setFailure(null);
				setStatus(null);
				try {
					const row = unwrap(await remote.settings.replace(
						NS,
						section,
						namespace === null ? undefined : namespace.revision,
					));
					setNamespace(row);
					setDraft(toDraft(row.value));
					setStatus(done);
					void probe(toDraft(row.value).baseURL);
				} catch (error) {
					setFailure(error.message);
				} finally {
					setBusy(false);
				}
			};

			const save = () => write(patch, "Saved");

			/**
			 * Remove this namespace's whole user layer, so the composition row
			 * applies again. Each stored path is named rather than rebuilt from
			 * the resolved value, so a secret the wire never returned cannot be
			 * resurrected by this write.
			 */
			const reset = async () => {
				setBusy(true);
				setFailure(null);
				setStatus(null);
				try {
					const keys = new Set([
						...Object.keys(namespace.user ?? {}),
						...namespace.secrets.map(secret => secret.path[0]),
					]);
					let resolved = toDraft(namespace.value);
					if (keys.size > 0) {
						const ops = [...keys].map(key => ({ op: "unset", path: [key] }));
						const row = unwrap(await remote.settings.mutate(NS, ops, namespace.revision));
						setNamespace(row);
						resolved = toDraft(row.value);
					}
					setDraft(resolved);
					setStatus("Reset — the composition row applies again");
					void probe(resolved.baseURL);
				} catch (error) {
					setFailure(error.message);
				} finally {
					setBusy(false);
				}
			};

			/** Test connection: probe the endpoint as typed, and show what it served. */
			const discover = async () => {
				setBusy(true);
				setFailure(null);
				setStatus(null);
				setDiscovered(null);
				try {
					const answer = await probe(draft.baseURL.trim());
					if (answer.failure !== undefined) {
						setFailure(answer.failure);
						return;
					}
					setDiscovered(answer.models);
					if (answer.models.length === 0) setStatus("That endpoint reported no models");
				} finally {
					setBusy(false);
				}
			};

			if (namespace === null) {
				return React.createElement("div", { className: "dsh-llamacpp-card" },
					React.createElement("p", { className: failure === null ? "dsh-llamacpp-note" : "dsh-llamacpp-error" },
						failure ?? `Reading the ${NS} settings section…`));
			}

			const text = (key, off) => React.createElement("input", {
				id: `${NS}-${key}`, className: "dsh-llamacpp-input", disabled: off,
				type: key === "apiKey" ? "password" : "text",
				...key === "baseURL" ? { placeholder: "http://localhost:8080/v1" } : {},
				...key === "apiKey" ? { placeholder: "no-key" } : {},
				value: draft[key],
				onChange: event => { edit(key, event.target.value) },
			});

			const number = (key, off) => React.createElement("input", {
				id: `${NS}-${key}`, className: "dsh-llamacpp-input", disabled: off, type: "number", min: "0",
				...key === "temperature" ? { step: "0.05" } : {},
				value: draft[key],
				onChange: event => { edit(key, event.target.value) },
			});

			// With discovery off nothing asks the server, so the pinned value is the
			// only thing left that decides the window — and it is required. The
			// capability probe still runs, which is why the probe timeout stays
			// available in both modes.
			const contextField = discovery
				? React.createElement(Field, {
					id: `${NS}-contextWindow`,
					label: "Context window",
					hint: endpoint.status === "connected"
						? `Read from /props for ${endpoint.models.length === 1 ? endpoint.models[0].id : `${endpoint.models.length} models`}. Turn discovery off to pin a smaller budget.`
						: "Read from the server's /props, per resolution.",
				}, React.createElement("div", { className: "dsh-llamacpp-readout" }, "discovered from the server"))
				: React.createElement(Field, {
					id: `${NS}-contextWindow`,
					label: "Pinned context window",
					hint: "Required while discovery is off: nothing else can say how much context this model has.",
				}, number("contextWindow"));

			const connection = React.createElement("div", { className: "dsh-llamacpp-group" },
				React.createElement("span", { className: "dsh-llamacpp-legend" }, "Connection"),
				React.createElement("div", { className: "dsh-llamacpp-grid" },
					React.createElement(Field, {
						id: `${NS}-baseURL`,
						label: "Base URL",
						hint: "The llama.cpp API base. A value without /v1 gets one.",
					}, text("baseURL", busy)),
					React.createElement(Field, {
						id: `${NS}-apiKey`,
						label: "API key",
						hint: "Bearer token; ignored unless the server runs with --api-key.",
					}, text("apiKey", busy)),
					React.createElement(Field, {
						id: `${NS}-headers`,
						label: "Extra headers",
						hint: "One per line, as name: value. For a proxy in front of the server.",
					}, React.createElement("textarea", {
						id: `${NS}-headers`, className: "dsh-llamacpp-input", rows: 2, spellCheck: false, disabled: busy,
						placeholder: "x-team: local", value: draft.headers,
						onChange: event => { edit("headers", event.target.value) },
					})),
				),
			);

			const model = React.createElement("div", { className: "dsh-llamacpp-group" },
				React.createElement("span", { className: "dsh-llamacpp-legend" }, "Model"),
				React.createElement("div", { className: "dsh-llamacpp-grid" },
					contextField,
					React.createElement(Field, {
						id: `${NS}-maxTokens`,
						label: "Output cap",
						hint: "Leave empty to derive it from the context window.",
					}, number("maxTokens", busy)),
				),
				React.createElement("label", { className: "dsh-llamacpp-toggle", htmlFor: `${NS}-discoverContext` },
					React.createElement("input", {
						id: `${NS}-discoverContext`, type: "checkbox", disabled: busy,
						checked: discovery,
						onChange: event => { edit("discoverContext", event.target.checked) },
					}),
					"Ask the server for the context window and thinking mode",
				),
				React.createElement(Field, {
					id: `${NS}-probeTimeoutMs`,
					label: "Probe timeout (ms)",
					hint: "How long /props may take before a request proceeds without it. Empty uses 1500.",
				}, number("probeTimeoutMs", busy)),
			);

			const advanced = React.createElement("details", { className: "dsh-llamacpp-details" },
				React.createElement("summary", null, "Advanced"),
				React.createElement("div", { className: "dsh-llamacpp-grid" },
					React.createElement(Field, {
						id: `${NS}-temperature`,
						label: "Temperature",
						hint: "Applied when a request names none.",
					}, number("temperature", busy)),
					React.createElement(Field, {
						id: `${NS}-logLevel`,
						label: "Diagnostics",
						hint: "info logs what was discovered at startup.",
					}, React.createElement("select", {
						id: `${NS}-logLevel`, className: "dsh-llamacpp-input", disabled: busy,
						value: draft.logLevel,
						onChange: event => { edit("logLevel", event.target.value) },
					}, ["silent", "info", "verbose"].map(option =>
						React.createElement("option", { key: option, value: option }, option)))),
				),
			);

			const actions = React.createElement("div", { className: "dsh-llamacpp-actions" },
				React.createElement("button", {
					type: "button", className: "dsh-llamacpp-button dsh-llamacpp-button-primary",
					disabled: busy || !changed, onClick: save,
				}, changed ? "Save" : "Saved"),
				React.createElement("button", {
					type: "button", className: "dsh-llamacpp-button", disabled: busy, onClick: discover,
				}, "Test connection"),
				React.createElement("button", {
					type: "button", className: "dsh-llamacpp-button", disabled: busy, onClick: reset,
				}, "Reset to composition"),
				busy ? React.createElement("span", { className: "dsh-llamacpp-hint" }, "working…") : null,
			);

			const report = React.createElement(React.Fragment, null,
				status === null ? null : React.createElement("div", { className: "dsh-llamacpp-status" }, status),
				failure === null ? null : React.createElement("div", { className: "dsh-llamacpp-error" }, failure),
				discovered === null
					? null
					: React.createElement("pre", { className: "dsh-llamacpp-readout" }, discovered.length === 0
						? "No models reported."
						: discovered.map(entry => [
							entry.id,
							entry.name === undefined || entry.name === entry.id ? "" : ` (${entry.name})`,
							entry.contextWindow === undefined ? "" : ` — ${entry.contextWindow} token context`,
						].join("")).join("\n")),
			);

			/**
			 * The one line that stands in for the card while it is closed: whether the
			 * endpoint answers, which endpoint it is, and what it serves. A collapsed
			 * row keeps its own status visible, so the page shows one fact per
			 * provider instead of every field of every row.
			 */
			const summary = React.createElement("button", {
				type: "button", className: "dsh-llamacpp-summary",
				"aria-expanded": open,
				title: endpoint.message,
				onClick: () => { setOpen(current => !current) },
			},
				React.createElement("span", {
					className: `dsh-llamacpp-dot ${DOT_CLASS[endpoint.status]}`,
					"aria-hidden": "true",
				}),
				React.createElement("span", { className: "dsh-llamacpp-summary-state" }, DOT_LABEL[endpoint.status]),
				React.createElement("span", { className: "dsh-llamacpp-summary-detail" }, summaryDetail(endpoint)),
				React.createElement("span", { className: "dsh-llamacpp-chevron", "aria-hidden": "true" }, open ? "▾" : "▸"),
			);

			const body = React.createElement("div", { className: "dsh-llamacpp-body" },
				React.createElement("p", { className: "dsh-llamacpp-note" },
					"Endpoint configuration for the ",
					provider === undefined ? "llama.cpp" : provider.displayName,
					" route."),
				connection,
				model,
				advanced,
				actions,
				report,
			);

			return React.createElement("div", { className: "dsh-llamacpp-card" },
				summary,
				open ? body : null,
			);
		}

		/**
		 * Services this plugin needs before it can register anything. The Remote
		 * namespaces are named individually: the guard rejects a generated member
		 * reached through the bare `remote` service.
		 */
		const inject = ["slots", "remote", "remote.settings", "remote.llm"];
		exports.inject = inject;

		/**
		 * Register the configuration card on the llama.cpp provider row.
		 * @param ctx - the Client plugin context.
		 */
		function apply(ctx) {
			mountStyles();
			ctx.slots.inject(SLOT, () => ctx.slots.register(
				{ name: SLOT, key: NS },
				props => React.createElement(LlamaCppCard, { ...props, remote: ctx.remote }),
			));
		}
		exports.apply = apply;

		exports.LlamaCppCard = LlamaCppCard;
		return module.exports;
	}
});
