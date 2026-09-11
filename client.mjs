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
		 * Host's schema — `FIELDS` names each control once, and the Host
		 * validates whatever comes back.
		 */

		/** Settings namespace this provider's profile lives in. */
		const NS = "llm-llamacpp";
		/** Slot this card occupies, keyed by that same namespace. */
		const SLOT = "settings.models.provider-card";

		/** One editable field, naming the control that edits it. */
		const FIELDS = [
			{ key: "baseURL", label: "Base URL", kind: "text", placeholder: "http://desktop:8080/v1", hint: "The llama.cpp API base. A value without /v1 gets one." },
			{ key: "apiKey", label: "API key", kind: "password", placeholder: "no-key", hint: "Sent as a bearer token. llama.cpp ignores it unless started with --api-key." },
			{ key: "headers", label: "Extra headers", kind: "map", lines: 3, hint: "One per line, as name: value. For a proxy in front of the server." },
			{ key: "contextWindow", label: "Pinned context window", kind: "number", hint: "Leave empty to read it from the server at /props." },
			{ key: "maxTokens", label: "Output cap", kind: "number", hint: "Leave empty to derive it from the context window." },
			{ key: "temperature", label: "Temperature", kind: "number", step: "0.05", hint: "Used when a request names none." },
			{ key: "probeTimeoutMs", label: "Probe timeout (ms)", kind: "number", hint: "How long /props may take before a request proceeds without it." },
			{ key: "discoverContext", label: "Discover from the server", kind: "boolean", hint: "Ask /props for the context window and thinking capability." },
			{ key: "logLevel", label: "Diagnostics", kind: "select", options: ["silent", "info", "verbose"] },
		];

		/** Fields whose emptiness means "no override" rather than "an empty value". */
		const NULLABLE = new Set(["contextWindow", "maxTokens", "temperature", "probeTimeoutMs"]);

		/** Render a resolved profile back into the strings the form edits. */
		function toDraft(value) {
			const source = value ?? {};
			const draft = {};
			for (const field of FIELDS) {
				const current = source[field.key];
				if (field.kind === "boolean") {
					draft[field.key] = current === undefined ? true : current === true;
				} else if (field.kind === "map") {
					draft[field.key] = mapToText(current);
				} else {
					draft[field.key] = current === undefined || current === null ? "" : String(current);
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
			for (const field of FIELDS) {
				if (draft[field.key] === baseDraft[field.key]) continue;
				if (field.kind === "boolean") {
					patch[field.key] = draft[field.key] === true;
					continue;
				}
				if (field.kind === "map") {
					patch[field.key] = textToMap(draft[field.key]);
					continue;
				}
				const raw = String(draft[field.key] ?? "").trim();
				if (raw.length === 0) {
					if (NULLABLE.has(field.key)) patch[field.key] = null;
					continue;
				}
				if (field.kind === "number") {
					const parsed = field.step === undefined ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
					if (!Number.isFinite(parsed)) continue;
					patch[field.key] = parsed;
					continue;
				}
				patch[field.key] = raw;
			}
			return patch;
		}

		/** Unwrap one remote answer, or throw the Host's own diagnostic. */
		function unwrap(answer) {
			if (answer !== undefined && answer.ok === true) return answer.value;
			const failure = answer === undefined ? undefined : answer.error;
			throw new Error(failure === undefined ? "the Host refused this request" : failure.message);
		}

		const styles = {
			wrap: { marginTop: "0.5rem", borderTop: "1px solid var(--dsh-border, rgba(127,127,127,0.25))", paddingTop: "0.75rem" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))", gap: "0.6rem" },
			field: { display: "flex", flexDirection: "column", gap: "0.2rem", minWidth: 0 },
			label: { fontSize: "0.75rem", opacity: 0.8 },
			hint: { fontSize: "0.7rem", opacity: 0.55, lineHeight: 1.35 },
			input: {
				width: "100%", boxSizing: "border-box", padding: "0.35rem 0.5rem",
				borderRadius: "0.375rem", border: "1px solid var(--dsh-border, rgba(127,127,127,0.35))",
				background: "var(--dsh-input-bg, transparent)", color: "inherit", font: "inherit", fontSize: "0.8rem",
			},
			row: { display: "flex", alignItems: "center", gap: "0.4rem" },
			actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", marginTop: "0.7rem" },
			button: {
				padding: "0.3rem 0.7rem", borderRadius: "0.375rem",
				border: "1px solid var(--dsh-border, rgba(127,127,127,0.35))",
				background: "var(--dsh-button-bg, transparent)", color: "inherit", font: "inherit",
				fontSize: "0.78rem", cursor: "pointer",
			},
			primary: { fontWeight: 600 },
			status: { fontSize: "0.75rem", opacity: 0.8 },
			error: { fontSize: "0.75rem", color: "var(--dsh-danger, #d9534f)" },
			pre: {
				margin: "0.5rem 0 0", padding: "0.4rem 0.5rem", maxHeight: "10rem", overflow: "auto",
				fontSize: "0.72rem", lineHeight: 1.4, whiteSpace: "pre-wrap",
				borderRadius: "0.375rem", background: "var(--dsh-code-bg, rgba(127,127,127,0.12))",
			},
			summary: { fontSize: "0.75rem", opacity: 0.8, marginBottom: "0.5rem" },
		};

		/**
		 * The provider's configuration card.
		 * @param props - the hosted card's share (the provider row) and the page's copy function.
		 * @returns the card.
		 */
		function LlamaCppCard(props) {
			const { provider, remote, readOnly } = props;
			const [namespace, setNamespace] = React.useState(null);
			const [draft, setDraft] = React.useState(() => toDraft(undefined));
			const [busy, setBusy] = React.useState(true);
			const [status, setStatus] = React.useState(null);
			const [failure, setFailure] = React.useState(null);
			const [discovered, setDiscovered] = React.useState(null);

			const load = React.useCallback(async () => {
				try {
					const answer = unwrap(await remote.settings.describe());
					const row = answer.namespaces.find((candidate) => candidate.ns === NS);
					setNamespace(row ?? null);
					setDraft(toDraft(row === undefined ? undefined : row.value));
					setFailure(row === undefined ? `The Host registered no "${NS}" settings section.` : null);
				} catch (error) {
					setFailure(error.message);
				} finally {
					setBusy(false);
				}
			}, [remote]);

			React.useEffect(() => {
				setBusy(true);
				void load();
			}, [load]);

			const value = namespace === null ? undefined : namespace.value;
			const disabled = readOnly === true || busy;
			const patch = patchOf(value, draft);
			const changed = Object.keys(patch).length > 0;

			const edit = (key, next) => {
				setDraft((current) => ({ ...current, [key]: next }));
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
				} catch (error) {
					setFailure(error.message);
				} finally {
					setBusy(false);
				}
			};

			const save = () => write(patch, "Saved");

			/**
			 * Remove this namespace's whole user layer, so the composition row
			 * applies again. `replace({})` would leave an empty section behind;
			 * unsetting each stored path is what actually clears it — and the
			 * paths are named rather than rebuilt from the resolved value, so a
			 * secret the wire never returned cannot be resurrected by a write.
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
					if (keys.size > 0) {
						const ops = [...keys].map(key => ({ op: "unset", path: [key] }));
						const row = unwrap(await remote.settings.mutate(NS, ops, namespace.revision));
						setNamespace(row);
						setDraft(toDraft(row.value));
					} else {
						setDraft(toDraft(namespace.value));
					}
					setStatus("Reset — the composition row applies again");
				} catch (error) {
					setFailure(error.message);
				} finally {
					setBusy(false);
				}
			};

			const discover = async () => {
				setBusy(true);
				setFailure(null);
				setStatus(null);
				setDiscovered(null);
				try {
					const answer = await remote.llm.discoverModels(NS, { baseURL: draft.baseURL.trim() });
					if (answer.ok === true) {
						setDiscovered(answer.value);
						if (answer.value.length === 0) setStatus("That endpoint reported no models");
					} else {
						setFailure(answer.error.message);
					}
				} catch (error) {
					setFailure(error.message);
				} finally {
					setBusy(false);
				}
			};

			if (namespace === null) {
				return React.createElement("div", { style: styles.wrap },
					React.createElement("div", { style: failure === null ? styles.hint : styles.error },
						failure ?? `Reading the ${NS} settings section…`));
			}

			const controls = FIELDS.map((field) => {
				const id = `${NS}-${field.key}`;
				const label = React.createElement("label", { key: "l", style: styles.label, htmlFor: id }, field.label);
				const hint = field.hint === undefined
					? null
					: React.createElement("span", { key: "h", style: styles.hint }, field.hint);
				let control;
				if (field.kind === "boolean") {
					control = React.createElement("input", {
						key: "c", id, type: "checkbox", checked: draft[field.key] === true, disabled,
						onChange: (event) => { edit(field.key, event.target.checked) },
					});
				} else if (field.kind === "select") {
					control = React.createElement("select", {
						key: "c", id, style: styles.input, value: draft[field.key], disabled,
						onChange: (event) => { edit(field.key, event.target.value) },
					}, field.options.map((option) => React.createElement("option", { key: option, value: option }, option)));
				} else if (field.kind === "map") {
					control = React.createElement("textarea", {
						key: "c", id, style: styles.input, rows: field.lines ?? 3, spellCheck: false, disabled,
						placeholder: "x-team: local", value: draft[field.key],
						onChange: (event) => { edit(field.key, event.target.value) },
					});
				} else {
					control = React.createElement("input", {
						key: "c", id, style: styles.input, disabled,
						type: field.kind === "number" ? "number" : field.kind === "password" ? "password" : "text",
						...field.step === undefined ? {} : { step: field.step },
						...field.placeholder === undefined ? {} : { placeholder: field.placeholder },
						value: draft[field.key],
						onChange: (event) => { edit(field.key, event.target.value) },
					});
				}
				return React.createElement("div", { key: field.key, style: styles.field }, label, control, hint);
			});

			const actions = React.createElement("div", { style: styles.actions },
				React.createElement("button", {
					type: "button", style: { ...styles.button, ...styles.primary },
					disabled: disabled || !changed, onClick: save,
				}, changed ? "Save" : "Saved"),
				React.createElement("button", {
					type: "button", style: styles.button, disabled: disabled, onClick: discover,
				}, "Test connection"),
				React.createElement("button", {
					type: "button", style: styles.button, disabled: disabled, onClick: reset,
				}, "Reset to composition"),
				busy ? React.createElement("span", { style: styles.hint }, "working…") : null,
			);

			const report = React.createElement(React.Fragment, null,
				status === null ? null : React.createElement("div", { style: styles.status }, status),
				failure === null ? null : React.createElement("div", { style: styles.error }, failure),
				discovered === null
					? null
					: React.createElement("pre", { style: styles.pre }, discovered.length === 0
						? "No models reported."
						: discovered.map((model) => [
							model.id,
							model.name === undefined || model.name === model.id ? "" : ` (${model.name})`,
							model.contextWindow === undefined ? "" : ` — ${model.contextWindow} token context`,
						].join("")).join("\n")),
			);

			return React.createElement("div", { style: styles.wrap },
				React.createElement("div", { style: styles.summary },
					"Endpoint configuration for the ",
					provider === undefined ? "llama.cpp" : provider.displayName,
					" route — the context window and thinking mode come from the server unless pinned here."),
				React.createElement("div", { style: styles.grid }, controls),
				actions,
				report,
			);
		}

		/**
		 * Services this plugin needs before it can register anything. The
		 * Remote namespaces are named individually: the guard rejects a
		 * generated member reached through the bare `remote` service.
		 */
		const inject = ["slots", "remote", "remote.settings", "remote.llm"];
		exports.inject = inject;

		/**
		 * Register the configuration card on the llama.cpp provider row.
		 * @param ctx - the Client plugin context.
		 */
		function apply(ctx) {
			ctx.slots.inject(SLOT, () => ctx.slots.register(
				{ name: SLOT, key: NS },
				(props) => React.createElement(LlamaCppCard, { ...props, remote: ctx.remote }),
			));
		}
		exports.apply = apply;

		exports.LlamaCppCard = LlamaCppCard;
		return module.exports;
	}
});
