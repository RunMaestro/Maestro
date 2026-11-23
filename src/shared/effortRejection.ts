/**
 * A provider refusing the effort level a turn asked for.
 *
 * Maestro picks effort values on the user's behalf in several places (tab
 * naming, synopses, context summaries, an Auto Run `effort="low"` hint, a Cue
 * subscription), all through the static ladder in `modelTiers.ts`. A provider
 * can retire a value at any time: Codex dropped `minimal`, and its API answers
 * a retired value with a 400 instead of clamping. Every one of those turns then
 * died before producing a word, and the only trace was a log line - a tab that
 * never got a name, a History entry with no synopsis.
 *
 * Two pieces, both import-free so the main process, the renderer, and the CLI
 * bundle can all use them:
 *
 * - {@link parseEffortRejection} recognizes the refusal in whatever text the
 *   provider printed (an `AgentError` message, a JSONL line, stderr).
 * - {@link noteEffortRejection} remembers it for the life of the process, and
 *   `resolveEffortLevel` consults that memory - so a refused ladder value
 *   resolves to "use the agent's own effort" from then on, and only the FIRST
 *   turn in a process pays for the discovery. Each spawn layer retries that
 *   first turn once without the override.
 *
 * The memory is keyed by provider and value, NOT by model, on purpose: the
 * resolver is asked for a level before a model is known, and a spawn that left
 * the model at its default cannot be matched to the model the API names. The
 * cost is that a value one model refuses is skipped for that provider's other
 * models until restart. That is the safe direction - the turn runs at the
 * agent's configured effort instead of failing.
 *
 * It only ever affects values Maestro chose through the ladder. An effort the
 * user picked on a tab or an agent is never rewritten here: that turn keeps
 * failing with the provider's own message, which is the user's to act on.
 */

export interface EffortRejection {
	/** The effort value the provider refused, e.g. `minimal`. */
	value: string;
	/** The model it was refused for, when the provider named one. */
	model?: string;
	/** Accepted values or menu IDs, in provider order; diagnostic, not routing authority. */
	supported: string[];
}

/**
 * OpenAI's Responses API wording, which is what Codex surfaces:
 *
 *   Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model.
 *   Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.
 *
 * with `"param":"reasoning.effort"` beside it. The parameter name is REQUIRED:
 * the same sentence is used for other parameters, and treating one of those as
 * an effort refusal would strip the effort from a turn that never had a problem
 * with it.
 *
 * A provider that phrases its refusal differently is simply not recognized,
 * and its turn fails the way it did before; add its pattern here rather than
 * at a call site.
 */
const UNSUPPORTED_VALUE_REGEX =
	/Unsupported value:\s*\\?['"]([^'"\\]+)\\?['"]\s+is not supported with the\s+\\?['"]([^'"\\]+)\\?['"]\s+model/i;
const EFFORT_PARAM_REGEX = /reasoning[._]effort/i;
const SUPPORTED_VALUES_REGEX = /Supported values are:\s*([^.]+)\./i;
const QUOTED_VALUE_REGEX = /\\?['"]([^'"\\]+)\\?['"]/g;

/**
 * Copilot CLI's wording, printed when the model takes no effort at all (its
 * `auto` model routes per turn and has no effort knob):
 *
 *   Error: Model "auto" does not support reasoning effort configuration (requested: "low").
 *
 * It names no accepted values, because there are none.
 */
const NO_EFFORT_SUPPORT_REGEX =
	/Model\s+\\?['"]([^'"\\]+)\\?['"]\s+does not support reasoning effort configuration\s*\(requested:\s*\\?['"]([^'"\\]+)\\?['"]\)/i;

/**
 * Grok headless's selected-model validation (pinned grok-build model_state.rs):
 *   --effort/--reasoning-effort: unknown effort level 'minimal'; use one of: low, high
 * It can instead say "this model has no selectable effort levels". Require
 * the CLI prefix and rejected token; ACP's generic "unknown reasoning_effort
 * value" and warnings about ignored effort do not identify a safe retry.
 * A missing catalog is not proof that a model rejected a value, either.
 */
const GROK_EFFORT_REJECTION_REGEX =
	/--effort\/--reasoning-effort:\s*unknown effort level\s+\\?['"]([^'"\\\r\n]+)\\?['"];\s*(?:(use one of:)|this model has no selectable effort levels(?=$|[\r\n"]|\\[nr"]))/i;

/**
 * Antigravity CLI (`agy`) model-selection validation, verified on agy 1.5.14.
 * Each model accepts its own subset of efforts, so both forms name the model:
 *
 *   error: invalid model selection (--model "gpt-oss-120b" --effort "high"): gpt-oss-120b has no "high" effort (available: medium)
 *   error: invalid model selection (--model "gemini-pro-orchestrator-neon" --effort "low"): --effort is not supported for model "gemini-pro-orchestrator-neon"
 *
 * The suffix/effort conflict (`--model x-high conflicts with --effort=low`) is
 * not a refusal of the effort: launch args are normalized so it cannot occur.
 */
const AGY_EFFORT_UNAVAILABLE_REGEX =
	/([A-Za-z0-9._-]+) has no \\?"([A-Za-z]+)\\?" effort \(available:\s*([^)\r\n]*)\)/;
const AGY_EFFORT_UNSUPPORTED_REGEX =
	/--effort \\?"([A-Za-z]+)\\?"\):\s*--effort is not supported for model \\?"([A-Za-z0-9._-]+)\\?"/;

/**
 * The refusal described by `text`, or `null` when `text` is not one.
 *
 * Accepts anything, because the callers hold provider output of uncertain
 * shape: an error message, a rejected promise's reason, a raw stdout buffer.
 */
export function parseEffortRejection(text: unknown): EffortRejection | null {
	if (typeof text !== 'string' || text.length === 0) return null;

	const grokEffort = GROK_EFFORT_REJECTION_REGEX.exec(text);
	if (grokEffort) {
		// Menu IDs are arbitrary strings, not canonical effort tokens. Keep the
		// refusal even when an escaped diagnostic cannot be read unambiguously.
		const offered = grokEffort[2]
			? /^[ \t]*([^\r\n"\\]+)(?=$|[\r\n"]|\\[nr"])/.exec(
					text.slice(grokEffort.index + grokEffort[0].length)
				)?.[1]
			: undefined;
		return {
			value: grokEffort[1],
			supported:
				offered
					?.split(',')
					.map((value) => value.trim())
					.filter(Boolean) ?? [],
		};
	}

	const agyUnavailable = AGY_EFFORT_UNAVAILABLE_REGEX.exec(text);
	if (agyUnavailable) {
		return {
			value: agyUnavailable[2],
			model: agyUnavailable[1],
			supported: agyUnavailable[3]
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean),
		};
	}
	const agyUnsupported = AGY_EFFORT_UNSUPPORTED_REGEX.exec(text);
	if (agyUnsupported) return { value: agyUnsupported[1], model: agyUnsupported[2], supported: [] };

	const noEffort = NO_EFFORT_SUPPORT_REGEX.exec(text);
	if (noEffort) return { value: noEffort[2], model: noEffort[1], supported: [] };

	if (!EFFORT_PARAM_REGEX.test(text)) return null;

	const match = UNSUPPORTED_VALUE_REGEX.exec(text);
	if (!match) return null;

	const supported: string[] = [];
	const supportedMatch = SUPPORTED_VALUES_REGEX.exec(text);
	if (supportedMatch) {
		for (const quoted of supportedMatch[1].matchAll(QUOTED_VALUE_REGEX)) {
			supported.push(quoted[1]);
		}
	}

	return { value: match[1], model: match[2], supported };
}

/** The parts of an `AgentError` a refusal can be read from. */
export interface AgentErrorText {
	message?: string;
	raw?: { stderr?: string; stdout?: string; errorLine?: string };
}

/**
 * The refusal carried by an agent error, or `null` when it carries none.
 *
 * Reads the raw provider output as well as the message. A parser that maps an
 * exit to a generic message ("Agent exited with code 1", as Copilot's does)
 * keeps the provider's own words only in `raw`.
 */
export function parseAgentErrorEffortRejection(
	error: AgentErrorText | null | undefined
): EffortRejection | null {
	if (!error) return null;
	for (const text of [error.message, error.raw?.errorLine, error.raw?.stderr, error.raw?.stdout]) {
		const rejection = parseEffortRejection(text);
		if (rejection) return rejection;
	}
	return null;
}

const rejections = new Map<string, EffortRejection>();

function rejectionKey(provider: string, value: string, model?: string): string {
	// Antigravity's effort menu is per model (gpt-oss-120b takes only medium,
	// gemini-4-neon goes to xhigh), so one model's refusal must not withdraw the
	// value from every other model. A lookup with no model never matches it.
	if (provider === 'antigravity') return `${provider}:${model ?? ''}:${value}`;
	// Grok's native CLI matches menu IDs and canonical values ignoring ASCII case.
	return `${provider}:${provider === 'grok' ? value.replace(/[A-Z]/g, (char) => char.toLowerCase()) : value}`;
}

/**
 * Remember that `provider` refused `rejection.value`.
 *
 * Returns `true` only the first time a given provider and value are noted in
 * this process, so a caller can report the refusal exactly once (a toast, a
 * Sentry message) however many turns hit it.
 */
export function noteEffortRejection(provider: string, rejection: EffortRejection): boolean {
	const key = rejectionKey(provider, rejection.value, rejection.model);
	if (rejections.has(key)) return false;
	rejections.set(key, rejection);
	return true;
}

/**
 * The refusal noted for this provider and value, if any. Antigravity refusals
 * are per model: pass the model, or none is found.
 */
export function getEffortRejection(
	provider: string,
	value: string,
	model?: string
): EffortRejection | undefined {
	return rejections.get(rejectionKey(provider, value, model));
}

/**
 * One sentence naming what was refused and what is accepted instead, for a
 * warning, a toast, or a log line. `providerName` is whatever the caller shows
 * its user: a display name in the app, the bare id on the CLI.
 */
export function describeEffortRejection(providerName: string, rejection: EffortRejection): string {
	const forModel = rejection.model ? ` for ${rejection.model}` : '';
	const accepted =
		rejection.supported.length > 0 ? ` It accepts ${rejection.supported.join(', ')}.` : '';
	return `${providerName} rejected effort "${rejection.value}"${forModel}.${accepted}`;
}

/** Forget every noted refusal. For tests; the app never needs to. */
export function resetEffortRejections(): void {
	rejections.clear();
}
