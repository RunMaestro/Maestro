/**
 * TTSR config normalizer - turns raw frontmatter-markdown rule files and the
 * raw `.maestro/ttsr.yaml` mapping into validated, normalized shapes.
 *
 * Mirrors `src/main/cue/config/cue-config-normalizer.ts`: coercion and enum
 * validation live here (the settings-metadata layer has no enum kind), and
 * every rejection produces a warning string instead of throwing, so one bad
 * rule never blocks the rest of a project's rule set.
 */

import * as path from 'path';
import * as yaml from 'js-yaml';
import { isValidAgentId, type AgentId } from '../../../shared/agentIds';
import {
	DEFAULT_TTSR_CONTEXT_MODE,
	DEFAULT_TTSR_PROJECT_SETTINGS,
	DEFAULT_TTSR_REPEAT_GAP,
	DEFAULT_TTSR_SCOPES,
	TTSR_CONTEXT_MODES,
	TTSR_INTERRUPT_MODES,
	TTSR_REPEAT_MODES,
	TTSR_SCOPES,
	defaultTtsrAgentsForRule,
	supportsTtsrAst,
	supportsTtsrProse,
	supportsTtsrShell,
	ttsrScopeCarriesPath,
	TTSR_AGENT_CAPABILITIES,
	type LoadedTtsrRule,
	type TtsrContextMode,
	type TtsrInterruptMode,
	type TtsrProjectSettings,
	type TtsrRepeatMode,
	type TtsrScope,
} from '../../../shared/ttsr-types';

/** Result of normalizing one rule file. A `null` rule means it was dropped. */
export interface ParsedTtsrRuleResult {
	rule: LoadedTtsrRule | null;
	warnings: string[];
}

// ── Coercion helpers ─────────────────────────────────────────────────────────

/** Coerce `string | string[] | undefined` into a trimmed, non-empty string[]. */
function toStringArray(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	const list = Array.isArray(value) ? value : [value];
	return list
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function toEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
	field: string,
	warnings: string[]
): T {
	if (value === undefined || value === null) return fallback;
	if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
		return value as T;
	}
	warnings.push(
		`Invalid ${field} "${String(value)}" (expected one of ${allowed.join(', ')}); using "${fallback}"`
	);
	return fallback;
}

// ── Regex safety gate ────────────────────────────────────────────────────────

/**
 * The quantifier starting at `index`, if any, and whether it can repeat the
 * preceding term more than once (`?` and `{0,1}` cannot).
 */
function readQuantifier(source: string, index: number): { end: number; repeats: boolean } | null {
	const ch = source[index];
	if (ch === '*' || ch === '+') return { end: index + 1, repeats: true };
	if (ch === '?') return { end: index + 1, repeats: false };
	if (ch !== '{') return null;
	const close = source.indexOf('}', index);
	if (close === -1) return null;
	const body = source.slice(index + 1, close);
	if (!/^\d*(,\d*)?$/.test(body) || body.length === 0) return null;
	const [minRaw, maxRaw] = body.split(',');
	const min = Number(minRaw || '0');
	// `{n,}` is unbounded; `{n,m}` repeats when it can run more than once.
	const max = body.includes(',') ? (maxRaw === '' ? Infinity : Number(maxRaw)) : min;
	return { end: close + 1, repeats: max > 1 };
}

/**
 * Heuristic catastrophic-backtracking gate for repo-supplied patterns.
 *
 * Rules load from the opened project's `.maestro/rules/*.md`, so a hostile (or
 * simply careless) repo picks the regexes that run on the main process's stdout
 * hot path. The classic wedge is a quantified group whose body is itself
 * unbounded - `(a+)+$`, `(x*)+`, `(\s+)  {2,}` - which makes the engine explore
 * exponentially many splits of the same input before failing.
 *
 * Deliberately a heuristic, not an analyzer: it rejects the nested-quantifier
 * shape and nothing else, which costs a handful of legitimate-but-rewritable
 * patterns and buys the guarantee that the obvious attack is not expressible.
 * The scan-length ceiling in `ttsr-matcher.ts` is the other half of the defense.
 */
function hasNestedQuantifier(source: string): boolean {
	/** One open group; `unbounded` once its body can repeat without a bound. */
	const groups: Array<{ unbounded: boolean }> = [];
	let inClass = false;

	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === '\\') {
			i += 1;
			continue;
		}
		if (inClass) {
			if (ch === ']') inClass = false;
			continue;
		}
		if (ch === '[') {
			inClass = true;
			continue;
		}
		if (ch === '(') {
			groups.push({ unbounded: false });
			continue;
		}
		if (ch === ')') {
			const group = groups.pop();
			const quantifier = readQuantifier(source, i + 1);
			if (!quantifier) continue;
			i = quantifier.end - 1;
			if (quantifier.repeats && group?.unbounded) return true;
			// A repeating group is itself an unbounded term for its parent.
			if (quantifier.repeats && groups.length > 0) {
				groups[groups.length - 1].unbounded = true;
			}
			continue;
		}
		const quantifier = readQuantifier(source, i);
		if (!quantifier) continue;
		i = quantifier.end - 1;
		// `a+` inside `(...)` makes every enclosing group unbounded, so
		// `((a+)b)*` is caught as well as `(a+)*`.
		if (quantifier.repeats) {
			for (const group of groups) group.unbounded = true;
		}
	}

	return false;
}

/**
 * Split a frontmatter-markdown document into its YAML block and body.
 * Returns `null` when the document has no leading `---` fence.
 */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } | null {
	const trimmed = raw.trimStart();
	if (!trimmed.startsWith('---')) return null;
	// Match the closing fence on its own line, mirroring `stripFrontmatter` in
	// `src/main/ipc/handlers/agents.ts`.
	const endIndex = trimmed.indexOf('\n---', 3);
	if (endIndex === -1) return null;
	return {
		frontmatter: trimmed.slice(3, endIndex),
		body: trimmed.slice(endIndex + 4).trim(),
	};
}

// ── Rule normalization ───────────────────────────────────────────────────────

/**
 * Parse and validate a single `.maestro/rules/*.md` file.
 *
 * `relativePath` is the project-relative source path; it becomes `rule.path`
 * and supplies the fallback rule name.
 *
 * Invalid regexes are dropped individually (siblings survive, mirroring OMP);
 * a rule left with nothing to match, no body, or unusable frontmatter is
 * dropped entirely with a warning.
 */
export function parseTtsrRule(raw: string, relativePath: string): ParsedTtsrRuleResult {
	const warnings: string[] = [];
	const label = relativePath;

	const split = splitFrontmatter(raw);
	if (!split) {
		return { rule: null, warnings: [`${label}: missing YAML frontmatter; rule skipped`] };
	}

	let front: unknown;
	try {
		front = yaml.load(split.frontmatter);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			rule: null,
			warnings: [`${label}: unparseable frontmatter (${message}); rule skipped`],
		};
	}

	if (front === undefined || front === null) front = {};
	if (typeof front !== 'object' || Array.isArray(front)) {
		return { rule: null, warnings: [`${label}: frontmatter must be a YAML mapping; rule skipped`] };
	}
	const fm = front as Record<string, unknown>;

	const fallbackName = path.basename(relativePath).replace(/\.md$/i, '');
	const name =
		typeof fm.name === 'string' && fm.name.trim().length > 0 ? fm.name.trim() : fallbackName;

	if (typeof fm.description !== 'string' || fm.description.trim().length === 0) {
		warnings.push(`${label}: missing "description"; using the rule name for display`);
	}
	const description =
		typeof fm.description === 'string' && fm.description.trim().length > 0
			? fm.description.trim()
			: name;

	// Compile every regex up front. A bad pattern - unparseable, or shaped like a
	// backtracking bomb - is dropped with a warning so the rest of the rule still
	// works, matching OMP's behavior for invalid patterns.
	const compiledCondition: RegExp[] = [];
	const condition: string[] = [];
	for (const source of toStringArray(fm.condition)) {
		if (hasNestedQuantifier(source)) {
			warnings.push(
				`${label}: regex "${source}" dropped (nested quantifier can backtrack catastrophically; ` +
					'rewrite it without a quantified group whose body is itself unbounded)'
			);
			continue;
		}
		try {
			compiledCondition.push(new RegExp(source));
			condition.push(source);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push(`${label}: invalid regex "${source}" dropped (${message})`);
		}
	}

	// ast-grep patterns are validated by the engine at match time (Phase 2);
	// here they are only coerced into a list.
	const astCondition = toStringArray(fm.astCondition);

	if (condition.length === 0 && astCondition.length === 0) {
		warnings.push(`${label}: no usable condition or astCondition; rule skipped`);
		return { rule: null, warnings };
	}

	const rawScopes = toStringArray(fm.scope);
	const scope: TtsrScope[] = [];
	for (const entry of rawScopes) {
		if ((TTSR_SCOPES as readonly string[]).includes(entry)) {
			if (!scope.includes(entry as TtsrScope)) scope.push(entry as TtsrScope);
		} else {
			warnings.push(
				`${label}: unknown scope "${entry}" dropped (expected one of ${TTSR_SCOPES.join(', ')})`
			);
		}
	}
	if (scope.length === 0) {
		// A rule that only declares ast patterns is inherently tool-scoped;
		// anything else defaults to the prose streams.
		scope.push(
			...(condition.length === 0 && astCondition.length > 0
				? (['tool:edit', 'tool:write'] as TtsrScope[])
				: DEFAULT_TTSR_SCOPES)
		);
	}

	const globs = toStringArray(fm.globs);
	// `globs` narrow by file path, and a shell command has none. Said out loud
	// here because the alternative - silently never matching - is the kind of
	// thing a user would spend an hour debugging.
	if (globs.length > 0 && !scope.some((s) => ttsrScopeCarriesPath(s))) {
		warnings.push(
			`${label}: "globs" only narrows tool:edit / tool:write matches and is ignored by this rule's scope`
		);
	}

	const interruptMode = toEnum<TtsrInterruptMode>(
		fm.interruptMode,
		TTSR_INTERRUPT_MODES,
		'always',
		`${label}: interruptMode`,
		warnings
	);
	const repeatMode = toEnum<TtsrRepeatMode>(
		fm.repeatMode,
		TTSR_REPEAT_MODES,
		'after-gap',
		`${label}: repeatMode`,
		warnings
	);

	let repeatGap = DEFAULT_TTSR_REPEAT_GAP;
	if (fm.repeatGap !== undefined && fm.repeatGap !== null) {
		const parsed = Number(fm.repeatGap);
		if (Number.isInteger(parsed) && parsed >= 1) {
			repeatGap = parsed;
		} else {
			warnings.push(
				`${label}: repeatGap must be an integer >= 1, got "${String(fm.repeatGap)}"; using ${DEFAULT_TTSR_REPEAT_GAP}`
			);
		}
	}

	const declaredAgents = toStringArray(fm.agents);
	let agents: AgentId[];
	if (declaredAgents.length === 0) {
		agents = defaultTtsrAgentsForRule({ condition, astCondition, scope });
	} else {
		agents = [];
		for (const entry of declaredAgents) {
			if (!isValidAgentId(entry)) {
				warnings.push(`${label}: unknown agent "${entry}" dropped`);
				continue;
			}
			const reason = unsupportedAgentReason(entry, { condition, astCondition, scope });
			if (reason) {
				warnings.push(`${label}: agent "${entry}" dropped (${reason})`);
				continue;
			}
			if (!agents.includes(entry)) agents.push(entry);
		}
	}
	if (agents.length === 0) {
		warnings.push(`${label}: rule targets no agent that can evaluate it; it will never fire`);
	}

	if (split.body.length === 0) {
		warnings.push(`${label}: empty body, so there is nothing to inject; rule skipped`);
		return { rule: null, warnings };
	}

	return {
		rule: {
			name,
			description,
			condition,
			astCondition,
			scope,
			globs,
			interruptMode,
			repeatMode,
			repeatGap,
			agents,
			content: split.body,
			path: relativePath,
			compiledCondition,
		},
		warnings,
	};
}

/**
 * Why an explicitly-listed agent cannot evaluate this rule, or `null` when it
 * can. Enforces Gate A at load time so an `astCondition` rule pointed at
 * factory-droid fails loudly in the warnings instead of silently never firing.
 */
function unsupportedAgentReason(
	agentId: AgentId,
	rule: { condition: string[]; astCondition: string[]; scope: TtsrScope[] }
): string | null {
	const cap = TTSR_AGENT_CAPABILITIES[agentId];
	if (cap.tier === 'C' || !cap.interrupt) return 'TTSR does not support this agent';
	if (rule.astCondition.length > 0 && !supportsTtsrAst(agentId)) {
		return 'agent surfaces no edit content for AST matching';
	}
	if (rule.scope.some((s) => ttsrScopeCarriesPath(s)) && !cap.toolEvents) {
		return 'agent emits no tool events';
	}
	if (rule.scope.includes('tool:bash') && !supportsTtsrShell(agentId)) {
		return 'agent does not report the shell commands it runs';
	}
	if (
		rule.condition.length > 0 &&
		rule.scope.some((s) => !s.startsWith('tool:')) &&
		!supportsTtsrProse(agentId)
	) {
		return 'agent exposes no prose or thinking stream';
	}
	return null;
}

// ── Settings normalization ───────────────────────────────────────────────────

/**
 * Normalize the `.maestro/ttsr.yaml` mapping into {@link TtsrProjectSettings}.
 * Unknown/invalid values fall back to the defaults with a warning; only a
 * non-mapping root is a hard error.
 */
export function normalizeTtsrSettings(raw: unknown): {
	settings: TtsrProjectSettings;
	errors: string[];
	warnings: string[];
} {
	const warnings: string[] = [];
	const errors: string[] = [];

	if (raw === undefined || raw === null) {
		return { settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS }, errors, warnings };
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		errors.push('TTSR config root must be a YAML mapping');
		return { settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS }, errors, warnings };
	}

	const map = raw as Record<string, unknown>;

	let enabled = DEFAULT_TTSR_PROJECT_SETTINGS.enabled;
	if (map.enabled !== undefined && map.enabled !== null) {
		if (typeof map.enabled === 'boolean') {
			enabled = map.enabled;
		} else {
			warnings.push(`ttsr.yaml: "enabled" must be a boolean; using ${enabled}`);
		}
	}

	// Left undefined when the project says nothing, so the global
	// `ttsrContextMode` setting is what applies. An invalid value is a statement
	// (a wrong one), so it falls back to the built-in default with a warning
	// rather than silently handing control back to the global setting.
	const contextMode =
		map.contextMode === undefined || map.contextMode === null
			? undefined
			: toEnum<TtsrContextMode>(
					map.contextMode,
					TTSR_CONTEXT_MODES,
					DEFAULT_TTSR_CONTEXT_MODE,
					'ttsr.yaml: contextMode',
					warnings
				);

	return {
		settings: {
			enabled,
			disabledRules: toStringArray(map.disabledRules),
			contextMode,
		},
		errors,
		warnings,
	};
}
