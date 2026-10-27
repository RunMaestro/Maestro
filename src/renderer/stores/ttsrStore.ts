/**
 * Renderer-side TTSR display cache.
 *
 * Gate B of the TTSR plan: main owns every authoritative bit of TTSR state
 * (matching, repeat policy, injected-rule records). Nothing here is a source of
 * truth - it counts match events for the Rules panel. Native Steer owns its own pending state.
 *
 * The {@link TtsrStore.matches} map is the display side of the same deal: it
 * counts `ttsr:matched` pushes so a non-interrupting rule is visible somewhere
 * instead of firing in total silence. Its consumer is the Right Bar Rules
 * panel, which renders one match line per rule. Those counts are per-renderer
 * and since
 * app start (in a browser client, since this browser session) - they are NOT
 * persisted and are NOT the injection counts main keeps in `ttsr-state.json`.
 */

import { create } from 'zustand';
import type { TtsrMatchedPayload, TtsrScope } from '../../shared/ttsr-types';

/** What the Rules panel shows for one rule that has fired this session. */
export interface TtsrRuleMatchStats {
	count: number;
	lastMatchedAt: number;
	lastSource: TtsrScope;
	/** True when the last match requested corrective guidance. */
	lastWillInterrupt: boolean;
	lastFilePath?: string;
}

/**
 * Key for the {@link TtsrStore.matches} map.
 *
 * Rule paths are project-relative, so two projects can hold a rule at the same
 * path. The NUL separator cannot occur in either half, so the pair is
 * unambiguous no matter what the path or the root looks like.
 */
export function matchKey(projectRoot: string, rulePath: string): string {
	return `${projectRoot}\u0000${rulePath}`;
}

interface TtsrStore {
	/**
	 * Per-rule match stats keyed by {@link matchKey}, surfaced as the Rules
	 * panel's match line. Bounded by the number of rules on disk, so it needs no
	 * eviction.
	 */
	matches: Record<string, TtsrRuleMatchStats>;
	/** Record a `ttsr:matched` push against every rule it names. */
	noteMatched: (projectRoot: string, payload: TtsrMatchedPayload) => void;
}

export const useTtsrStore = create<TtsrStore>()((set) => ({
	matches: {},

	noteMatched: (projectRoot, payload) =>
		set((state) => {
			if (payload.rules.length === 0) return state;
			const at = Date.now();
			const matches = { ...state.matches };
			for (const rule of payload.rules) {
				const key = matchKey(projectRoot, rule.path);
				matches[key] = {
					count: (matches[key]?.count ?? 0) + 1,
					lastMatchedAt: at,
					lastSource: payload.source,
					lastWillInterrupt: payload.willInterrupt,
					lastFilePath: payload.filePath,
				};
			}
			return { ...state, matches };
		}),
}));
