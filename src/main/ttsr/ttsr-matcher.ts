/**
 * Pure TTSR match predicates: eligibility (agents gate, scope narrowing, glob
 * path gate), regex evaluation, and the interrupt-vs-defer classification.
 *
 * Nothing here touches process state, so the whole matching surface is unit
 * testable without spawning an agent. Stateful concerns (buffers, repeat
 * policy) live in `TtsrManager` and `TtsrStateStore`.
 */

import * as path from 'path';
import picomatch from 'picomatch';
import type { AgentId } from '../../shared/agentIds';
import {
	ttsrScopeCarriesPath,
	type LoadedTtsrRule,
	type TtsrInterruptMode,
	type TtsrScope,
} from '../../shared/ttsr-types';

/** Which stream a candidate match came from. Same vocabulary as `scope`. */
export type TtsrMatchSource = TtsrScope;

/** What the matcher needs to know about the delta it is evaluating. */
export interface TtsrMatchContext {
	agentId: AgentId;
	source: TtsrMatchSource;
	/** Edited file path for tool sources. Absolute or project-relative. */
	filePath?: string;
	/** Project root, used to relativize `filePath` before glob matching. */
	cwd?: string;
}

/**
 * What happens to a match:
 * - `interrupt`: abort the in-flight turn and reinject `<system-interrupt>`
 * - `deferred-prose` / `deferred-tool`: queue a `<system-reminder>` for the
 *   next prompt (Maestro has no tool-result hook, so a non-interrupting tool
 *   match cannot be folded in-band the way OMP's `afterToolCall` does)
 */
export type TtsrDisposition = 'interrupt' | 'deferred-prose' | 'deferred-tool';

/** `text` and `thinking` are prose; everything else is tool-sourced. */
export function isProseSource(source: TtsrMatchSource): boolean {
	return source === 'text' || source === 'thinking';
}

/** Whether the rule's `interruptMode` permits aborting on this source. */
export function interruptModeAllows(mode: TtsrInterruptMode, source: TtsrMatchSource): boolean {
	switch (mode) {
		case 'never':
			return false;
		case 'always':
			return true;
		case 'prose-only':
			return isProseSource(source);
		case 'tool-only':
			return !isProseSource(source);
	}
}

/** Classify a match into its Phase 3 bucket. */
export function classifyMatch(
	rule: Pick<LoadedTtsrRule, 'interruptMode'>,
	source: TtsrMatchSource
): TtsrDisposition {
	if (interruptModeAllows(rule.interruptMode, source)) return 'interrupt';
	return isProseSource(source) ? 'deferred-prose' : 'deferred-tool';
}

// ── Glob path gate ───────────────────────────────────────────────────────────

const globMatcherCache = new Map<string, (input: string) => boolean>();

function getGlobMatcher(globs: string[]): (input: string) => boolean {
	const key = globs.join('\n');
	let matcher = globMatcherCache.get(key);
	if (!matcher) {
		matcher = picomatch(globs, { dot: true });
		globMatcherCache.set(key, matcher);
	}
	return matcher;
}

/** Normalize to forward slashes and drop the project root prefix when present. */
function toGlobCandidate(filePath: string, cwd?: string): string {
	let candidate = filePath;
	if (cwd && path.isAbsolute(filePath)) {
		const relative = path.relative(cwd, filePath);
		// `path.relative` escaping the root (`../`) means the file lives outside
		// the project; keep the original so an absolute-path glob can still match.
		if (relative && !relative.startsWith('..')) candidate = relative;
	}
	return candidate.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Whether a tool-source file path satisfies a rule's `globs`.
 * An empty glob list means "any path".
 */
export function matchesGlobs(globs: string[], filePath: string, cwd?: string): boolean {
	if (globs.length === 0) return true;
	return getGlobMatcher(globs)(toGlobCandidate(filePath, cwd));
}

// ── Eligibility ──────────────────────────────────────────────────────────────

/**
 * Whether a rule may be evaluated against this delta at all: the agent gate
 * (Gate A), scope narrowing, and the glob path gate for file-bearing sources.
 *
 * `globs` narrow by file path, so they only apply to sources that name a file
 * (`tool:edit` / `tool:write`). Prose and `tool:bash` have no path and ignore
 * them - a shell command is not "in" a file. A file-bearing match whose path is
 * unknown is skipped: an unlocatable edit cannot be proven to be in scope.
 */
export function ruleAppliesToContext(
	rule: Pick<LoadedTtsrRule, 'agents' | 'scope' | 'globs'>,
	ctx: TtsrMatchContext
): boolean {
	if (!rule.agents.includes(ctx.agentId)) return false;
	if (!rule.scope.includes(ctx.source)) return false;
	if (!ttsrScopeCarriesPath(ctx.source) || rule.globs.length === 0) return true;
	if (!ctx.filePath) return false;
	return matchesGlobs(rule.globs, ctx.filePath, ctx.cwd);
}

/**
 * First regex hit for this rule, or `null`. Returns the matched substring so
 * the activity log can show what tripped the rule.
 */
export function findRegexMatch(
	rule: Pick<LoadedTtsrRule, 'compiledCondition'>,
	text: string
): string | null {
	if (!text) return null;
	for (const regex of rule.compiledCondition) {
		// Guard against sticky/global patterns carrying `lastIndex` between calls.
		if (regex.global || regex.sticky) regex.lastIndex = 0;
		const match = regex.exec(text);
		if (match) return match[0];
	}
	return null;
}
