/**
 * Antigravity CLI (`agy`) model catalogue and model/effort selection.
 *
 * `agy models` prints one model per line as `<id>\t<label>` under a
 * "Fetching available models..." heading. Most ids carry their reasoning
 * effort as a suffix (`gemini-4-neon-high`), so the catalogue is really a set
 * of base models, each with the efforts it accepts:
 *
 *   gemini-4-neon-high	Gemini 4 Neon (High)
 *   gemini-4-neon-xhigh	Gemini 4 Neon (XHigh)
 *   gemini-pro-orchestrator-neon	Orchestrator (Neon)
 *   gpt-oss-120b-medium	GPT-OSS 120B (Medium)
 *
 * Verified on agy 1.5.14:
 * - `--model <base> --effort <e>` runs when the base lists `e`.
 * - `--model <base>` alone runs at the CLI's default effort.
 * - `--model <base>-<e1> --effort <e2>` is refused ("conflicts with --effort").
 * - `--effort` on an id with no effort suffix (the orchestrators) is refused
 *   ("--effort is not supported for model").
 * - An effort the base does not list is refused, naming the ones it does.
 */

/** Every effort word `agy --effort` accepts, in ladder order. */
export const ANTIGRAVITY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const EFFORT_SUFFIX_REGEX = new RegExp(`^(.+)-(${ANTIGRAVITY_EFFORTS.join('|')})$`);

/** A model id split into its base model and the effort its suffix names. */
export interface AntigravityModelSelection {
	base: string;
	effort?: string;
}

/** `gemini-4-neon-high` -> `{ base: 'gemini-4-neon', effort: 'high' }`; ids with no suffix stay whole. */
export function splitAntigravityModelEffort(modelId: string): AntigravityModelSelection {
	const match = EFFORT_SUFFIX_REGEX.exec(modelId.trim());
	return match ? { base: match[1], effort: match[2] } : { base: modelId.trim() };
}

export interface AntigravityModelCatalog {
	/** Base model ids in the order `agy models` first lists them. */
	models: string[];
	/** Efforts each base model accepts, in ladder order. Empty: takes no `--effort`. */
	efforts: Record<string, string[]>;
}

function byLadder(a: string, b: string): number {
	const order = ANTIGRAVITY_EFFORTS as readonly string[];
	return order.indexOf(a) - order.indexOf(b);
}

/**
 * Parse `agy models` stdout. Only `<id>\t<label>` lines are models; the
 * heading and any blank or prose line is skipped, so a reworded heading cannot
 * turn into a bogus model id.
 */
export function parseAntigravityModelList(stdout: string): AntigravityModelCatalog {
	const models: string[] = [];
	const efforts: Record<string, string[]> = Object.create(null);
	for (const line of stdout.split(/\r?\n/)) {
		const tab = line.indexOf('\t');
		if (tab <= 0) continue;
		const id = line.slice(0, tab).trim();
		if (!id || /\s/.test(id)) continue;
		const { base, effort } = splitAntigravityModelEffort(id);
		if (!(base in efforts)) {
			efforts[base] = [];
			models.push(base);
		}
		if (effort && !efforts[base].includes(effort)) efforts[base].push(effort);
	}
	for (const base of models) efforts[base].sort(byLadder);
	return { models, efforts };
}

/** Every effort any model in the catalogue accepts, in ladder order. */
export function antigravityEffortUnion(catalog: AntigravityModelCatalog): string[] {
	const all = new Set<string>();
	for (const base of catalog.models) for (const effort of catalog.efforts[base]) all.add(effort);
	return [...all].sort(byLadder);
}

/**
 * The model and effort to send so `agy` never sees a contradiction.
 *
 * - An explicit effort wins over a suffix in the model id (`gemini-4-neon-high`
 *   plus effort `low` runs `gemini-4-neon --effort low`), because the effort is
 *   the more specific choice: a tab or task hint set it on purpose, while the
 *   suffixed id is usually an agent-level default.
 * - With no explicit effort, a suffixed id runs as written.
 * - An orchestrator id takes no `--effort` at all, so one is dropped rather
 *   than failing the turn.
 */
export function resolveAntigravitySelection(
	model: string | undefined,
	effort: string | undefined
): { model?: string; effort?: string } {
	const trimmedModel = model?.trim() || undefined;
	const trimmedEffort = effort?.trim() || undefined;
	if (!trimmedModel) return { effort: trimmedEffort };
	if (!trimmedEffort) return { model: trimmedModel };
	if (/(^|-)orchestrator(-|$)/.test(trimmedModel)) return { model: trimmedModel };
	const split = splitAntigravityModelEffort(trimmedModel);
	// A suffix that names the same effort is not a conflict; agy runs it as is.
	if (!split.effort || split.effort === trimmedEffort) {
		return { model: trimmedModel, effort: trimmedEffort };
	}
	return { model: split.base, effort: trimmedEffort };
}

/**
 * Rewrite `--model` / `--effort` in an `agy` argument list so the pair is one
 * the CLI accepts (see {@link resolveAntigravitySelection}). Both `--flag value`
 * and `--flag=value` spellings are read; the last occurrence of each wins, the
 * way the CLI's own flag parser reads them. Everything else keeps its place.
 */
export function resolveAntigravityModelEffortArgs(args: string[]): string[] {
	let model: string | undefined;
	let effort: string | undefined;
	const rest: string[] = [];
	const modelAt: number[] = [];
	const effortAt: number[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const flag = arg === '--model' || arg.startsWith('--model=') ? 'model' : null;
		const effortFlag = arg === '--effort' || arg.startsWith('--effort=') ? 'effort' : null;
		const which = flag ?? effortFlag;
		if (!which) {
			rest.push(arg);
			continue;
		}
		const equals = arg.indexOf('=');
		const value = equals >= 0 ? arg.slice(equals + 1) : args[++i];
		if (which === 'model') {
			model = value;
			modelAt.push(rest.length);
		} else {
			effort = value;
			effortAt.push(rest.length);
		}
	}
	if (modelAt.length === 0 && effortAt.length === 0) return args;
	const selected = resolveAntigravitySelection(model, effort);
	// Only a real conflict is rewritten; anything agy accepts keeps its spelling.
	const readModel = model?.trim() || undefined;
	const readEffort = effort?.trim() || undefined;
	if (selected.model === readModel && selected.effort === readEffort) return args;
	const out = [...rest];
	// Re-insert at the first position each flag held, effort after model so a
	// shared position keeps the CLI's documented order.
	const inserts: Array<[number, string[]]> = [];
	if (selected.model && modelAt.length > 0) inserts.push([modelAt[0], ['--model', selected.model]]);
	if (selected.effort && effortAt.length > 0)
		inserts.push([effortAt[0], ['--effort', selected.effort]]);
	inserts.sort((a, b) => b[0] - a[0] || (a[1][0] === '--effort' ? -1 : 1));
	for (const [at, pair] of inserts) out.splice(at, 0, ...pair);
	return out;
}

/**
 * The model and thinking level to hand the Antigravity Python SDK (native
 * mode). The SDK names Gemini API models, which carry no effort suffix, and
 * takes the effort as `thinking_level`; a suffixed id is split so its effort
 * is not lost, and an explicit effort still wins.
 */
export function antigravitySdkSelection(
	model: string | undefined,
	effort: string | undefined
): { model?: string; effort?: string } {
	const trimmedModel = model?.trim() || undefined;
	const trimmedEffort = effort?.trim() || undefined;
	if (!trimmedModel) return { effort: trimmedEffort };
	const split = splitAntigravityModelEffort(trimmedModel);
	return { model: split.base, effort: trimmedEffort ?? split.effort };
}
