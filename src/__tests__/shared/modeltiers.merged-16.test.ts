// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/modelTiers.test.ts
// Source: src/__tests__/shared/agentConstants.test.ts
// Source: src/__tests__/shared/tabConversationStats.test.ts
// Source: src/__tests__/shared/themeGloss.test.ts
// Source: src/__tests__/shared/usagePeaks.test.ts
// Source: src/__tests__/shared/usageQuota.test.ts
// Source: src/__tests__/shared/window-types.test.ts
// Source: src/__tests__/shared/percentiles.test.ts
// Source: src/__tests__/shared/convertBracketMath.test.ts
// Source: src/__tests__/shared/groupChatRemote.test.ts
// Source: src/__tests__/shared/agentIds.test.ts
// Source: src/__tests__/shared/embeddedSystemPrompt.test.ts
// Source: src/__tests__/shared/autorunSteering.test.ts
// Source: src/__tests__/shared/normalizeChatDisplayMath.test.ts
// Source: src/__tests__/shared/claudeTokenModeLabel.test.ts
// Source: src/__tests__/shared/statsActiveAgents.test.ts
// Source: src/__tests__/shared/jsonUtils.test.ts
// Source: src/__tests__/shared/encoreFeatures.test.ts
import { describe, afterEach, it, expect } from 'vitest';
import { noteEffortRejection, resetEffortRejections } from '../../shared/effortRejection';
import {
	TIER_LEVELS,
	asTierLevel,
	cheapResumeTurnSettings,
	cheapTurnSettings,
	isLadderEffortValue,
	rejectedEffortForLevel,
	resolveEffortLevel,
	resolveTierModel,
	supportsEffortSelection,
	supportsTierSelection,
} from '../../shared/modelTiers';
import {
	DEFAULT_CONTEXT_WINDOWS,
	FALLBACK_CONTEXT_WINDOW,
	COMBINED_CONTEXT_AGENTS,
	resilienceEnabled,
} from '../../shared/agentConstants';
import { AGENT_IDS as S2_AGENT_IDS } from '../../shared/agentIds';
import {
	computeTabConversationStats,
	formatConversationDuration,
} from '../../shared/tabConversationStats';
import type { LogEntry } from '../../renderer/types';
import {
	GLOSS_LEVELS,
	GLOSS_LEVEL_META,
	DEFAULT_GLOSS_LEVEL,
	asGlossLevel,
	glossLevelIndex,
	glossLevelAtIndex,
	isGlossOff,
	type GlossLevel,
} from '../../shared/themeGloss';
import {
	mergeUsagePeaks,
	usagePeaksEqual,
	ZERO_USAGE_PEAKS,
	USAGE_PEAK_KEYS,
} from '../../shared/usagePeaks';
import {
	hasValidQuotaWindow,
	hasUsefulAnthropicQuotaDetails,
	hasUsefulCodexQuotaDetails,
} from '../../shared/usageQuota';
import {
	APP_WINDOW_TITLE_BASE,
	formatWindowTitle,
	isPointInWindowBounds,
	isPointOutsideWindowBounds,
	type WindowBounds,
} from '../../shared/window-types';
import {
	computePercentiles,
	percentilesFromSorted,
	percentileOfSorted,
	emptyPercentiles,
} from '../../shared/percentiles';
import { convertBracketMath } from '../../shared/convertBracketMath';
import {
	planGroupChatStart,
	toRemoteGroupChatState,
	withParticipantMentions,
} from '../../shared/groupChatRemote';
import type { GroupChat } from '../../shared/group-chat-types';
import { AGENT_IDS as S11_AGENT_IDS, isValidAgentId } from '../../shared/agentIds';
import type { AgentId } from '../../shared/agentIds';
import {
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
	embedSystemPromptInPrompt,
	hasEmbeddedSystemPrompt,
	stripEmbeddedSystemPrompt,
} from '../../shared/embeddedSystemPrompt';
import {
	formatSteeringNotesBlock,
	normalizeSteeringNoteText,
	MAX_STEERING_NOTE_LENGTH,
	STEERING_BLOCK_START,
	STEERING_BLOCK_END,
	type AutoRunSteeringNote,
} from '../../shared/autorunSteering';
import { normalizeChatDisplayMath } from '../../shared/normalizeChatDisplayMath';
import { getTokenSourcePill } from '../../shared/claudeTokenModeLabel';
import {
	isAgentActiveInRange,
	countActiveAgents,
	type BySessionByDay,
} from '../../shared/statsActiveAgents';
import {
	assertSerializedJsonIsSafe,
	parseJsonWithBom,
	serializedJsonByteLength,
	stripJsonBom,
} from '../../shared/jsonUtils';
import { serializedJsonByteLength as contributionsByteLength } from '../../shared/plugins/contributions';
import {
	ENCORE_FEATURE_DEFAULTS,
	isEncoreFeatureEnabled,
	requireEncoreFeature,
	resolveEncoreFeatures,
} from '../../shared/encoreFeatureDefaults';
// Source: src/__tests__/shared/modelTiers.test.ts
describe('', () => {
	describe('tier vocabulary', () => {
		it('is exactly low, medium, high', () => {
			expect(TIER_LEVELS).toEqual(['low', 'medium', 'high']);
		});
		it('narrows only real levels', () => {
			expect(asTierLevel('high')).toBe('high');
			expect(asTierLevel('max')).toBeUndefined();
			expect(asTierLevel('')).toBeUndefined();
			expect(asTierLevel(undefined)).toBeUndefined();
			expect(asTierLevel(2)).toBeUndefined();
		});
	});
	describe('effort ladders', () => {
		it('maps Maestro levels to ladder POSITIONS, not to same-named strings', () => {
			// Claude's ladder is low, medium, high, xhigh, max. "high" means the
			// ceiling of that ladder, so it resolves to `max`, and "medium" means the
			// middle rung, which is Claude's `high`. Identity mapping here would mean
			// a document asking for the most effort silently got the middle.
			expect(resolveEffortLevel('claude-code', 'low')).toBe('low');
			expect(resolveEffortLevel('claude-code', 'medium')).toBe('high');
			expect(resolveEffortLevel('claude-code', 'high')).toBe('max');
		});
		it("uses codex's real floor, which is low: no current model accepts minimal", () => {
			// `minimal` used to sit below `low`. Every model in Codex's catalogue
			// now rejects it with a 400 ("'minimal' is not supported with the
			// 'gpt-6-astra' model"), which killed every cheap turn with no output.
			expect(resolveEffortLevel('codex', 'low')).toBe('low');
			expect(resolveEffortLevel('codex', 'medium')).toBe('medium');
			expect(resolveEffortLevel('codex', 'high')).toBe('xhigh');
		});
		it('is the identity only where the provider ladder is exactly three rungs', () => {
			expect(resolveEffortLevel('factory-droid', 'low')).toBe('low');
			expect(resolveEffortLevel('factory-droid', 'medium')).toBe('medium');
			expect(resolveEffortLevel('factory-droid', 'high')).toBe('high');
		});
		it('reports no effort for a provider that has no effort knob', () => {
			// OpenCode exposes no effort/reasoning option at all, so an effort hint has
			// nothing to write. Undefined (inherit + warn), never a guessed value.
			expect(resolveEffortLevel('opencode', 'high')).toBeUndefined();
			expect(supportsEffortSelection('opencode')).toBe(false);
			expect(supportsEffortSelection('claude-code')).toBe(true);
		});
	});
	describe('model tiers', () => {
		it('uses Claude permanent aliases so a playbook does not rot', () => {
			expect(resolveTierModel('claude-code', 'low')).toBe('haiku');
			expect(resolveTierModel('claude-code', 'medium')).toBe('sonnet');
			expect(resolveTierModel('claude-code', 'high')).toBe('opus');
		});
		it('leaves discovery-driven providers unmapped rather than guessing', () => {
			// Codex/Copilot IDs churn per release and OpenCode runs whatever the user
			// configured. A shipped guess would rot into naming a model they cannot
			// run, so these resolve to the agent default and the caller warns.
			expect(resolveTierModel('codex', 'high')).toBeUndefined();
			expect(resolveTierModel('copilot-cli', 'high')).toBeUndefined();
			expect(resolveTierModel('opencode', 'high')).toBeUndefined();
			expect(supportsTierSelection('opencode')).toBe(false);
			expect(supportsTierSelection('claude-code')).toBe(true);
		});
	});
	describe('cheap synopsis turn', () => {
		it('pins to the bottom of both ladders', () => {
			expect(cheapTurnSettings('claude-code')).toEqual({ model: 'haiku', effort: 'low' });
			expect(cheapTurnSettings('codex')).toEqual({ model: undefined, effort: 'low' });
		});
		it('yields all-undefined for a provider with neither axis mapped', () => {
			// Callers fall back to the agent's own config, so a synopsis still runs.
			expect(cheapTurnSettings('opencode')).toEqual({ model: undefined, effort: undefined });
		});
	});
	describe('cheap synopsis turn resumed on its session', () => {
		it('drops to the bottom of both ladders when the window does not shrink', () => {
			expect(cheapResumeTurnSettings('claude-code', { model: 'opus', effort: 'max' })).toEqual({
				model: 'haiku',
				effort: 'low',
			});
		});
		it('keeps the session model when the cheap one has a smaller context window', () => {
			// Resuming replays the transcript: what fit a 1M window cannot fit 200k.
			// Effort still drops, since that costs nothing to read.
			expect(cheapResumeTurnSettings('claude-code', { model: 'opus[1m]', effort: 'max' })).toEqual({
				model: 'opus[1m]',
				effort: 'low',
			});
		});
		it('inherits the session values on a provider with no cheap tier', () => {
			expect(cheapResumeTurnSettings('codex', { model: 'gpt-5-codex', effort: 'high' })).toEqual({
				model: 'gpt-5-codex',
				effort: 'low',
			});
			expect(cheapResumeTurnSettings('opencode', { model: 'm', effort: 'e' })).toEqual({
				model: 'm',
				effort: 'e',
			});
		});
		it('works with nothing configured on the session', () => {
			expect(cheapResumeTurnSettings('claude-code')).toEqual({ model: 'haiku', effort: 'low' });
			expect(cheapResumeTurnSettings('opencode')).toEqual({
				model: undefined,
				effort: undefined,
			});
		});
	});
	describe('a ladder value the provider has refused', () => {
		// The ladders are a snapshot of each provider's catalogue. Codex retired
		// `minimal` and answered it with a 400, which killed every cheap turn with
		// no output. A refusal noted in this process takes the value out of
		// circulation instead of letting the next turn fail the same way.
		const refusal = { value: 'low', model: 'gpt-6-astra', supported: ['medium', 'high'] };
		afterEach(() => {
			resetEffortRejections();
		});
		it('resolves to undefined, meaning inherit the agent own effort', () => {
			expect(resolveEffortLevel('codex', 'low')).toBe('low');
			noteEffortRejection('codex', refusal);
			expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
			expect(cheapTurnSettings('codex')).toEqual({ model: undefined, effort: undefined });
		});
		it('leaves the other levels and the other providers alone', () => {
			noteEffortRejection('codex', refusal);
			expect(resolveEffortLevel('codex', 'medium')).toBe('medium');
			expect(resolveEffortLevel('codex', 'high')).toBe('xhigh');
			// Claude maps `low` to the same string, but it is Codex that said no.
			expect(resolveEffortLevel('claude-code', 'low')).toBe('low');
		});
		it('takes out every level that maps to the refused value', () => {
			// Claude's `medium` is `high`; a refusal of `high` must not leave it live.
			noteEffortRejection('claude-code', { value: 'high', supported: [] });
			expect(resolveEffortLevel('claude-code', 'medium')).toBeUndefined();
			expect(resolveEffortLevel('claude-code', 'high')).toBe('max');
		});
		it('still reports the provider as having an effort setting', () => {
			noteEffortRejection('codex', refusal);
			expect(supportsEffortSelection('codex')).toBe(true);
		});
		it('hands the refusal to callers that explain an unmapped level', () => {
			expect(rejectedEffortForLevel('codex', 'low')).toBeUndefined();
			noteEffortRejection('codex', refusal);
			expect(rejectedEffortForLevel('codex', 'low')).toEqual(refusal);
			expect(rejectedEffortForLevel('codex', 'medium')).toBeUndefined();
			expect(rejectedEffortForLevel('opencode', 'low')).toBeUndefined();
		});
		it('ignores a refusal of a value no ladder hands out', () => {
			// `ultra` is something a user picked on a tab, not a ladder rung.
			noteEffortRejection('codex', { value: 'ultra', supported: [] });
			expect(resolveEffortLevel('codex', 'low')).toBe('low');
			expect(resolveEffortLevel('codex', 'high')).toBe('xhigh');
		});
	});
	describe('isLadderEffortValue', () => {
		it('is true only for a value a ladder hands out for that provider', () => {
			expect(isLadderEffortValue('codex', 'low')).toBe(true);
			expect(isLadderEffortValue('codex', 'xhigh')).toBe(true);
			// Offered in the Codex dropdown, never chosen by Maestro.
			expect(isLadderEffortValue('codex', 'ultra')).toBe(false);
			expect(isLadderEffortValue('codex', 'minimal')).toBe(false);
			expect(isLadderEffortValue('claude-code', 'max')).toBe(true);
		});
		it('is false for a provider with no ladder, or one it has never heard of', () => {
			expect(isLadderEffortValue('opencode', 'low')).toBe(false);
			expect(isLadderEffortValue('not-a-provider', 'low')).toBe(false);
		});
	});
});
// Source: src/__tests__/shared/agentConstants.test.ts
describe('', () => {
	describe('agentConstants', () => {
		describe('FALLBACK_CONTEXT_WINDOW', () => {
			it('should be 200000', () => {
				expect(FALLBACK_CONTEXT_WINDOW).toBe(200000);
			});
			it('should be a positive number', () => {
				expect(FALLBACK_CONTEXT_WINDOW).toBeGreaterThan(0);
			});
		});
		describe('DEFAULT_CONTEXT_WINDOWS', () => {
			it('should have entries for active agents', () => {
				expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
				expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
				expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
				expect(DEFAULT_CONTEXT_WINDOWS['factory-droid']).toBe(200000);
				expect(DEFAULT_CONTEXT_WINDOWS['hermes']).toBe(200000);
				expect(DEFAULT_CONTEXT_WINDOWS['pi']).toBe(200000);
			});
			it('should have terminal context window set to 0', () => {
				expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
			});
			it('should only contain valid agent IDs', () => {
				for (const key of Object.keys(DEFAULT_CONTEXT_WINDOWS)) {
					expect(S2_AGENT_IDS).toContain(key);
				}
			});
			it('should have positive values for non-terminal agents', () => {
				for (const [key, value] of Object.entries(DEFAULT_CONTEXT_WINDOWS)) {
					if (key !== 'terminal') {
						expect(value).toBeGreaterThan(0);
					}
				}
			});
		});
		describe('COMBINED_CONTEXT_AGENTS', () => {
			it('should be a ReadonlySet', () => {
				expect(COMBINED_CONTEXT_AGENTS).toBeInstanceOf(Set);
			});
			it('should contain codex (OpenAI uses combined context)', () => {
				expect(COMBINED_CONTEXT_AGENTS.has('codex')).toBe(true);
			});
			it('should contain copilot-cli (Copilot CLI normalizes input reporting cumulative-style)', () => {
				expect(COMBINED_CONTEXT_AGENTS.has('copilot-cli')).toBe(true);
			});
			it('should not contain claude-code (Claude uses separate limits)', () => {
				expect(COMBINED_CONTEXT_AGENTS.has('claude-code')).toBe(false);
			});
			it('should only contain valid agent IDs', () => {
				for (const id of COMBINED_CONTEXT_AGENTS) {
					expect(S2_AGENT_IDS).toContain(id);
				}
			});
		});
		describe('resilienceEnabled', () => {
			it('treats undefined as ON (read-time default, no migration for existing agents)', () => {
				expect(resilienceEnabled(undefined)).toBe(true);
			});
			it('treats an explicit true as ON', () => {
				expect(resilienceEnabled(true)).toBe(true);
			});
			it('only an explicit false opts out', () => {
				expect(resilienceEnabled(false)).toBe(false);
			});
		});
	});
});
// Source: src/__tests__/shared/tabConversationStats.test.ts
describe('', () => {
	const BASE_TIME = 1703116800000; // 2023-12-21T00:00:00.000Z
	function log(source: LogEntry['source'], offsetMs: number, text = 'x'): LogEntry {
		return {
			id: `log-${source}-${offsetMs}`,
			timestamp: BASE_TIME + offsetMs,
			source,
			text,
		};
	}
	describe('computeTabConversationStats', () => {
		it('returns zeroed stats for an empty or missing log array', () => {
			for (const input of [undefined, []]) {
				const stats = computeTabConversationStats(input);
				expect(stats.logs).toEqual([]);
				expect(stats.totalMessages).toBe(0);
				expect(stats.userMessages).toBe(0);
				expect(stats.aiMessages).toBe(0);
				expect(stats.durationMs).toBe(0);
			}
		});
		it('counts every conversation entry, not just prose', () => {
			const stats = computeTabConversationStats([
				log('user', 0),
				log('ai', 1000),
				log('tool', 2000),
				log('thinking', 3000),
				log('stdout', 4000),
			]);
			expect(stats.totalMessages).toBe(5);
			expect(stats.userMessages).toBe(1);
			expect(stats.aiMessages).toBe(2); // ai + stdout
		});
		it('drops sources that are not part of the conversation', () => {
			const stats = computeTabConversationStats([
				log('user', 0),
				log('command' as LogEntry['source'], 1000),
				log('ai', 2000),
			]);
			expect(stats.totalMessages).toBe(2);
			expect(stats.logs.map((l) => l.source)).toEqual(['user', 'ai']);
		});
		it('measures the span between the first and last conversation entry', () => {
			const stats = computeTabConversationStats([
				log('user', 0),
				log('ai', 60000),
				log('user', 3600000),
			]);
			expect(stats.durationMs).toBe(3600000);
		});
		it('ignores dropped sources when measuring the span', () => {
			const stats = computeTabConversationStats([
				log('command' as LogEntry['source'], 0),
				log('user', 60000),
				log('ai', 120000),
				log('command' as LogEntry['source'], 900000),
			]);
			expect(stats.durationMs).toBe(60000);
		});
		it('reports a zero span for a single entry', () => {
			expect(computeTabConversationStats([log('user', 0)]).durationMs).toBe(0);
		});
	});
	describe('formatConversationDuration', () => {
		it('renders zero as 0m rather than an empty string', () => {
			expect(formatConversationDuration(0)).toBe('0m');
		});
		it('renders a real span compactly', () => {
			expect(formatConversationDuration(3600000)).toContain('1h');
		});
	});
});
// Source: src/__tests__/shared/themeGloss.test.ts
describe('', () => {
	describe('themeGloss', () => {
		it('orders the levels least to most, which is what makes the control a slider', () => {
			expect([...GLOSS_LEVELS]).toEqual(['off', 'sheen', 'strong', 'max']);
		});
		it('defaults to off, so an install that never opens Settings is unchanged', () => {
			expect(DEFAULT_GLOSS_LEVEL).toBe('off');
		});
		it('names and describes every level, so a new one cannot ship unlabelled', () => {
			for (const level of GLOSS_LEVELS) {
				expect(GLOSS_LEVEL_META[level].label.length).toBeGreaterThan(0);
				expect(GLOSS_LEVEL_META[level].description.length).toBeGreaterThan(0);
			}
		});
		describe('asGlossLevel', () => {
			it('passes every valid level through untouched', () => {
				for (const level of GLOSS_LEVELS) {
					expect(asGlossLevel(level)).toBe(level);
				}
			});
			it.each([
				['an unknown string', 'shiny'],
				['a boolean', true],
				['a number', 2],
				['null', null],
				['undefined', undefined],
				['an object', {}],
				['the wrong case', 'Strong'],
			])('falls back to the default for %s', (_label, input) => {
				expect(asGlossLevel(input)).toBe(DEFAULT_GLOSS_LEVEL);
			});
		});
		describe('isGlossOff', () => {
			it("is true only for 'off'", () => {
				expect(isGlossOff('off')).toBe(true);
				expect(isGlossOff('sheen')).toBe(false);
			});
			it("exists because 'off' is a truthy string", () => {
				// The trap this guards: `if (level)` is true for every level, including
				// the one that means "do nothing".
				const level: GlossLevel = 'off';
				expect(Boolean(level)).toBe(true);
				expect(isGlossOff(level)).toBe(true);
			});
		});
		describe('index round-trip', () => {
			it('converts both ways for every level', () => {
				for (const level of GLOSS_LEVELS) {
					expect(glossLevelAtIndex(glossLevelIndex(level))).toBe(level);
				}
			});
			it('clamps out-of-range positions instead of returning undefined', () => {
				// A range input cannot produce these, but the CLI and older persisted
				// values can, and an undefined level would land on <html> as the
				// string "undefined".
				expect(glossLevelAtIndex(-5)).toBe('off');
				expect(glossLevelAtIndex(99)).toBe('max');
				expect(glossLevelAtIndex(Number.NaN)).toBe(DEFAULT_GLOSS_LEVEL);
			});
			it('rounds a fractional position to the nearest stop', () => {
				expect(glossLevelAtIndex(1.4)).toBe('sheen');
				expect(glossLevelAtIndex(1.6)).toBe('strong');
			});
		});
	});
});
// Source: src/__tests__/shared/usagePeaks.test.ts
describe('', () => {
	describe('mergeUsagePeaks', () => {
		const stored = {
			maxAgents: 89,
			maxDefinedAgents: 89,
			maxSimultaneousAutoRuns: 8,
			maxSimultaneousQueries: 8,
			maxQueueDepth: 16,
		};
		it('keeps the stored value when the incoming sample is lower', () => {
			const merged = mergeUsagePeaks(stored, {
				maxAgents: 12,
				maxDefinedAgents: 12,
				maxSimultaneousAutoRuns: 1,
				maxSimultaneousQueries: 2,
				maxQueueDepth: 0,
			});
			expect(merged).toEqual(stored);
		});
		it('raises only the counters that were actually beaten', () => {
			const merged = mergeUsagePeaks(stored, { maxQueueDepth: 20, maxAgents: 3 });
			expect(merged.maxQueueDepth).toBe(20);
			expect(merged.maxAgents).toBe(89);
		});
		// The incident this guards: a caller whose own copy is still zeroed (a
		// renderer mid-hydration, a second window) must not be able to lower a peak.
		it('cannot lower a peak from a zeroed baseline', () => {
			const merged = mergeUsagePeaks(stored, ZERO_USAGE_PEAKS);
			expect(merged).toEqual(stored);
		});
		it('treats a missing, null, or undefined side as no observation', () => {
			expect(mergeUsagePeaks(stored, undefined)).toEqual(stored);
			expect(mergeUsagePeaks(null, stored)).toEqual(stored);
			expect(mergeUsagePeaks(undefined, undefined)).toEqual(ZERO_USAGE_PEAKS);
		});
		// Math.max(89, NaN) is NaN, which would wipe the peak it is defending.
		it('coerces junk read back from JSON to 0 instead of NaN', () => {
			const merged = mergeUsagePeaks(stored, {
				maxAgents: NaN,
				maxQueueDepth: -5,
				maxSimultaneousQueries: 'nope' as unknown as number,
			});
			expect(merged).toEqual(stored);
			for (const key of USAGE_PEAK_KEYS) {
				expect(Number.isFinite(merged[key])).toBe(true);
			}
		});
		it('fills in a key the stored object predates', () => {
			const merged = mergeUsagePeaks({ maxAgents: 4 }, { maxQueueDepth: 2 });
			expect(merged).toEqual({
				maxAgents: 4,
				maxDefinedAgents: 0,
				maxSimultaneousAutoRuns: 0,
				maxSimultaneousQueries: 0,
				maxQueueDepth: 2,
			});
		});
	});
	describe('usagePeaksEqual', () => {
		it('is true when every counter matches', () => {
			expect(usagePeaksEqual(ZERO_USAGE_PEAKS, { ...ZERO_USAGE_PEAKS })).toBe(true);
		});
		it('is false when any counter differs', () => {
			expect(usagePeaksEqual(ZERO_USAGE_PEAKS, { ...ZERO_USAGE_PEAKS, maxQueueDepth: 1 })).toBe(
				false
			);
		});
		it('treats a missing key and an explicit 0 as the same', () => {
			expect(usagePeaksEqual({ maxAgents: 3 }, { maxAgents: 3, maxQueueDepth: 0 })).toBe(true);
		});
	});
});
// Source: src/__tests__/shared/usageQuota.test.ts
describe('', () => {
	const WINDOW = { percent: 42, resetsAt: '2026-01-01T00:00:00.000Z' };
	describe('hasValidQuotaWindow', () => {
		it('accepts a finite percent paired with a reset timestamp', () => {
			expect(hasValidQuotaWindow(WINDOW)).toBe(true);
			expect(hasValidQuotaWindow({ percent: 0, resetsAt: WINDOW.resetsAt })).toBe(true);
		});
		it('rejects a missing window', () => {
			expect(hasValidQuotaWindow(undefined)).toBe(false);
		});
		it('rejects non-finite or negative percentages', () => {
			expect(hasValidQuotaWindow({ percent: NaN, resetsAt: WINDOW.resetsAt })).toBe(false);
			expect(hasValidQuotaWindow({ percent: Infinity, resetsAt: WINDOW.resetsAt })).toBe(false);
			expect(hasValidQuotaWindow({ percent: -1, resetsAt: WINDOW.resetsAt })).toBe(false);
		});
		it('rejects a missing or empty reset timestamp', () => {
			expect(hasValidQuotaWindow({ percent: 42 })).toBe(false);
			expect(hasValidQuotaWindow({ percent: 42, resetsAt: '' })).toBe(false);
		});
	});
	describe('hasUsefulAnthropicQuotaDetails', () => {
		it('accepts a snapshot with any one valid window', () => {
			expect(hasUsefulAnthropicQuotaDetails({ session: WINDOW })).toBe(true);
			expect(hasUsefulAnthropicQuotaDetails({ weekAllModels: WINDOW })).toBe(true);
			expect(hasUsefulAnthropicQuotaDetails({ weekSonnetOnly: WINDOW })).toBe(true);
		});
		it('treats a missing authState as authenticated (back-compat)', () => {
			expect(hasUsefulAnthropicQuotaDetails({ session: WINDOW })).toBe(true);
		});
		it('rejects an explicitly unauthenticated snapshot even with windows', () => {
			expect(
				hasUsefulAnthropicQuotaDetails({ authState: 'unauthenticated', session: WINDOW })
			).toBe(false);
		});
		it('rejects a snapshot with no usable window', () => {
			expect(hasUsefulAnthropicQuotaDetails({})).toBe(false);
			expect(hasUsefulAnthropicQuotaDetails({ session: { percent: 42 } })).toBe(false);
		});
	});
	describe('hasUsefulCodexQuotaDetails', () => {
		it.each([
			{ kind: 'balance', balance: 12.5 },
			{ kind: 'balance', balance: 0 },
			{ kind: 'unlimited' },
		] as const)('accepts authenticated credit-only snapshots: %j', (credits) => {
			expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated', credits })).toBe(true);
		});
		it.each(['missing_auth', 'error'])(
			'rejects credit-only snapshots with auth state %s',
			(authState) => {
				expect(hasUsefulCodexQuotaDetails({ authState, credits: { kind: 'unlimited' } })).toBe(
					false
				);
			}
		);
		it('accepts an authenticated snapshot with any one valid window', () => {
			expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated', session: WINDOW })).toBe(
				true
			);
			expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated', weekly: WINDOW })).toBe(true);
			expect(
				hasUsefulCodexQuotaDetails({ authState: 'authenticated', additionalLimits: [WINDOW] })
			).toBe(true);
		});
		it('requires an explicit authenticated state', () => {
			expect(hasUsefulCodexQuotaDetails({ authState: 'missing_auth', session: WINDOW })).toBe(
				false
			);
			expect(hasUsefulCodexQuotaDetails({ authState: 'error', session: WINDOW })).toBe(false);
		});
		it('rejects an authenticated snapshot with nothing to render', () => {
			expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated' })).toBe(false);
			expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated', additionalLimits: [] })).toBe(
				false
			);
		});
	});
});
// Source: src/__tests__/shared/window-types.test.ts
describe('', () => {
	const BOUNDS: WindowBounds = { x: 100, y: 100, width: 800, height: 600 };
	describe('isPointInWindowBounds', () => {
		it('returns true for a point well inside the rectangle', () => {
			expect(isPointInWindowBounds({ x: 500, y: 400 }, BOUNDS)).toBe(true);
		});
		it('treats the left and top edges as inclusive', () => {
			// Top-left corner is the first pixel inside.
			expect(isPointInWindowBounds({ x: 100, y: 100 }, BOUNDS)).toBe(true);
			expect(isPointInWindowBounds({ x: 100, y: 400 }, BOUNDS)).toBe(true);
			expect(isPointInWindowBounds({ x: 500, y: 100 }, BOUNDS)).toBe(true);
		});
		it('treats the right and bottom edges as exclusive', () => {
			// x === x + width and y === y + height land just OUTSIDE the rectangle.
			expect(isPointInWindowBounds({ x: 900, y: 400 }, BOUNDS)).toBe(false);
			expect(isPointInWindowBounds({ x: 500, y: 700 }, BOUNDS)).toBe(false);
			expect(isPointInWindowBounds({ x: 900, y: 700 }, BOUNDS)).toBe(false);
		});
		it('returns false when the point is outside on any single axis', () => {
			expect(isPointInWindowBounds({ x: 99, y: 400 }, BOUNDS)).toBe(false); // left
			expect(isPointInWindowBounds({ x: 500, y: 99 }, BOUNDS)).toBe(false); // above
			expect(isPointInWindowBounds({ x: 901, y: 400 }, BOUNDS)).toBe(false); // right
			expect(isPointInWindowBounds({ x: 500, y: 701 }, BOUNDS)).toBe(false); // below
		});
		it('handles a window anchored at the origin', () => {
			const atOrigin: WindowBounds = { x: 0, y: 0, width: 100, height: 100 };
			expect(isPointInWindowBounds({ x: 0, y: 0 }, atOrigin)).toBe(true);
			expect(isPointInWindowBounds({ x: 100, y: 100 }, atOrigin)).toBe(false);
		});
	});
	describe('formatWindowTitle', () => {
		it('keeps the bare product name for the primary window (number 1)', () => {
			expect(formatWindowTitle(1)).toBe(APP_WINDOW_TITLE_BASE);
		});
		it('appends a "[N]" badge for secondary windows (number >= 2)', () => {
			expect(formatWindowTitle(2)).toBe('Maestro [2]');
			expect(formatWindowTitle(3)).toBe('Maestro [3]');
			expect(formatWindowTitle(10)).toBe('Maestro [10]');
		});
		it('falls back to the bare name for a non-positive/defensive number', () => {
			// A primary should never render "[1]"; anything <= 1 stays unbadged.
			expect(formatWindowTitle(0)).toBe(APP_WINDOW_TITLE_BASE);
		});
	});
	describe('isPointOutsideWindowBounds', () => {
		it('is the exact negation of isPointInWindowBounds', () => {
			const samples = [
				{ x: 500, y: 400 }, // inside
				{ x: 100, y: 100 }, // inclusive corner
				{ x: 900, y: 700 }, // exclusive corner
				{ x: -50, y: 400 }, // far left
				{ x: 5000, y: 5000 }, // far outside
			];
			for (const point of samples) {
				expect(isPointOutsideWindowBounds(point, BOUNDS)).toBe(
					!isPointInWindowBounds(point, BOUNDS)
				);
			}
		});
	});
});
// Source: src/__tests__/shared/percentiles.test.ts
describe('', () => {
	describe('percentiles', () => {
		describe('emptyPercentiles', () => {
			it('is all zeros with count 0', () => {
				expect(emptyPercentiles()).toEqual({
					count: 0,
					min: 0,
					p50: 0,
					p75: 0,
					p90: 0,
					p95: 0,
					p99: 0,
					max: 0,
				});
			});
		});
		describe('computePercentiles', () => {
			it('returns the empty distribution for an empty array', () => {
				expect(computePercentiles([])).toEqual(emptyPercentiles());
			});
			it('handles a single value (all percentiles equal it)', () => {
				const d = computePercentiles([42]);
				expect(d).toEqual({
					count: 1,
					min: 42,
					p50: 42,
					p75: 42,
					p90: 42,
					p95: 42,
					p99: 42,
					max: 42,
				});
			});
			it('computes nearest-rank percentiles over 1..100', () => {
				const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
				const d = computePercentiles(values);
				expect(d.count).toBe(100);
				expect(d.min).toBe(1);
				expect(d.max).toBe(100);
				// floor((p/100) * 100) index into the sorted 0-based array → value index+1
				expect(d.p50).toBe(51);
				expect(d.p75).toBe(76);
				expect(d.p90).toBe(91);
				expect(d.p95).toBe(96);
				expect(d.p99).toBe(100);
			});
			it('does not mutate the input array', () => {
				const values = [3, 1, 2];
				computePercentiles(values);
				expect(values).toEqual([3, 1, 2]);
			});
			it('sorts unsorted input before computing', () => {
				const unsorted = computePercentiles([100, 1, 50, 25, 75]);
				const sorted = percentilesFromSorted([1, 25, 50, 75, 100]);
				expect(unsorted).toEqual(sorted);
			});
		});
		describe('percentileOfSorted', () => {
			it('returns 0 for an empty array', () => {
				expect(percentileOfSorted([], 95)).toBe(0);
			});
			it('clamps to the last element at p100', () => {
				expect(percentileOfSorted([10, 20, 30], 100)).toBe(30);
			});
			it('returns the first element at p0', () => {
				expect(percentileOfSorted([10, 20, 30], 0)).toBe(10);
			});
		});
	});
});
// Source: src/__tests__/shared/convertBracketMath.test.ts
describe('', () => {
	describe('convertBracketMath', () => {
		it('converts inline \\(...\\) to inline $$...$$', () => {
			expect(convertBracketMath('Inline \\(N \\approx 1000\\) here.')).toBe(
				'Inline $$N \\approx 1000$$ here.'
			);
		});
		it('converts display \\[...\\] to a blank-line-isolated $$...$$ block', () => {
			expect(convertBracketMath('Display: \\[E = mc^2\\]')).toBe('Display: \n\n$$E = mc^2$$\n\n');
		});
		it('trims whitespace inside the delimiters', () => {
			expect(convertBracketMath('\\(  x + y  \\)')).toBe('$$x + y$$');
		});
		it('converts multiple inline spans on one line', () => {
			expect(convertBracketMath('Two \\(a\\) and \\(b\\) inline.')).toBe(
				'Two $$a$$ and $$b$$ inline.'
			);
		});
		it('leaves currency and shell variables untouched', () => {
			const input = 'It costs $5 and $10; path is $HOME/bin.';
			expect(convertBracketMath(input)).toBe(input);
		});
		it('does not touch \\(...\\) inside an inline code span', () => {
			const input = 'Code: `\\(y\\)` stays literal';
			expect(convertBracketMath(input)).toBe(input);
		});
		it('does not touch \\[...\\] inside a fenced code block', () => {
			const input = '```\n\\[not math\\]\n```';
			expect(convertBracketMath(input)).toBe(input);
		});
		it('emits an unterminated \\( verbatim (does not swallow the rest)', () => {
			const input = 'Broken \\(x + y and more prose that must survive.';
			expect(convertBracketMath(input)).toBe(input);
		});
		it('returns input unchanged when there are no bracket delimiters', () => {
			const input = 'plain text with $5 and (parentheses) and [brackets]';
			expect(convertBracketMath(input)).toBe(input);
		});
		// Over-escaped delimiters: agents routinely emit `\\(x\\)` when they escape
		// the backslash one time too many. Matching only the two-character closer left
		// a stray `\` in front of the generated `$$`, which markdown read as an
		// escaped dollar, so the reader saw a literal `$$x$$` instead of math.
		it('converts the over-escaped \\\\(...\\\\) inline form', () => {
			expect(convertBracketMath('all \\\\(N\\\\) documents')).toBe('all $$N$$ documents');
		});
		it('converts several over-escaped inline runs on one line', () => {
			const input = 'has \\\\(\\text{df} = N\\\\), so \\\\(\\text{IDF} = \\log 1 = 0\\\\).';
			expect(convertBracketMath(input)).toBe(
				'has $$\\text{df} = N$$, so $$\\text{IDF} = \\log 1 = 0$$.'
			);
		});
		it('converts the over-escaped \\\\[...\\\\] display form', () => {
			expect(convertBracketMath('a \\\\[x=1\\\\] b')).toBe('a \n\n$$x=1$$\n\n b');
		});
		it('leaves an over-escaped run inside an inline code span alone', () => {
			const input = 'Code: `\\\\(y\\\\)` stays literal';
			expect(convertBracketMath(input)).toBe(input);
		});
		it('emits an unterminated over-escaped \\\\( verbatim', () => {
			const input = 'Broken \\\\(x + y and more prose that must survive.';
			expect(convertBracketMath(input)).toBe(input);
		});
		it('handles a multi-line \\[...\\] display block', () => {
			const input = '\\[\\begin{aligned}\na &= b\n\\end{aligned}\\]';
			expect(convertBracketMath(input)).toBe(
				'\n\n$$\\begin{aligned}\na &= b\n\\end{aligned}$$\n\n'
			);
		});
	});
});
// Source: src/__tests__/shared/groupChatRemote.test.ts
describe('', () => {
	const baseChat: GroupChat = {
		id: 'chat-1',
		name: 'Maestro Release',
		createdAt: 0,
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'group-chat-chat-1-moderator',
		participants: [
			{ name: 'rc', agentId: 'claude-code', sessionId: 'proc-rc', addedAt: 0 },
			{ name: 'RunMaestro.ai', agentId: 'codex', sessionId: 'proc-web', addedAt: 0 },
		],
		logPath: '/tmp/log',
		imagesDir: '/tmp/images',
	};
	describe('toRemoteGroupChatState', () => {
		it('maps the chat name to topic and each participant agent type to toolType', () => {
			const state = toRemoteGroupChatState(baseChat, 'idle');
			expect(state.topic).toBe('Maestro Release');
			expect(state.participants).toEqual([
				{ sessionId: 'proc-rc', name: 'rc', toolType: 'claude-code' },
				{ sessionId: 'proc-web', name: 'RunMaestro.ai', toolType: 'codex' },
			]);
			expect(state.messages).toEqual([]);
			expect(state.moderatorAgentId).toBe('claude-code');
		});
		it('reports any non-idle state as active', () => {
			expect(toRemoteGroupChatState(baseChat, 'idle').isActive).toBe(false);
			expect(toRemoteGroupChatState(baseChat, 'moderator-thinking').isActive).toBe(true);
			expect(toRemoteGroupChatState(baseChat, 'agent-working')).toMatchObject({
				isActive: true,
				state: 'agent-working',
			});
		});
		it('marks user lines as user and everything else as assistant, with epoch timestamps', () => {
			const state = toRemoteGroupChatState(baseChat, 'idle', [
				{ timestamp: '2026-09-26T10:00:00.000Z', from: 'user', content: 'go' },
				{ timestamp: '2026-09-26T10:00:05.000Z', from: 'moderator', content: 'on it' },
			]);
			expect(state.messages.map((m) => [m.role, m.participantName, m.content])).toEqual([
				['user', 'user', 'go'],
				['assistant', 'moderator', 'on it'],
			]);
			expect(state.messages[1].timestamp).toBe(Date.parse('2026-09-26T10:00:05.000Z'));
			expect(new Set(state.messages.map((m) => m.id)).size).toBe(2);
		});
		it('carries who took a steered user message, and nothing on a plain one', () => {
			const state = toRemoteGroupChatState(baseChat, 'moderator-thinking', [
				{ timestamp: '2026-09-26T10:00:00.000Z', from: 'user', content: 'go' },
				{
					timestamp: '2026-09-26T10:00:01.000Z',
					from: 'user',
					content: 'also docs',
					steeredTo: ['Moderator'],
				},
				{ timestamp: '2026-09-26T10:00:02.000Z', from: 'user', content: 'x', steeredTo: [] },
			]);
			expect(state.messages[0]).not.toHaveProperty('steeredTo');
			expect(state.messages[1].steeredTo).toEqual(['Moderator']);
			expect(state.messages[2]).not.toHaveProperty('steeredTo');
		});
		it('leaves the queue out when none is passed', () => {
			const state = toRemoteGroupChatState(baseChat, 'idle');
			expect(state).not.toHaveProperty('queue');
			expect(state).not.toHaveProperty('queuePaused');
		});
		it('reports the queue with only the flags that are set, and never the image data', () => {
			const state = toRemoteGroupChatState(baseChat, 'agent-working', [], {
				items: [
					{ id: 'q1', text: 'plain', timestamp: 1 },
					{
						id: 'q2',
						text: 'with everything',
						timestamp: 2,
						images: ['data:image/png;base64,AAAA'],
						failed: true,
						failureReason: 'boom',
						sending: true,
						readOnlyMode: true,
					},
					{ id: 'q3', text: 'empty images', timestamp: 3, images: [] },
				],
				paused: true,
			});
			expect(state.queue).toEqual([
				{ id: 'q1', text: 'plain', timestamp: 1 },
				{
					id: 'q2',
					text: 'with everything',
					timestamp: 2,
					hasImages: true,
					failed: true,
					failureReason: 'boom',
					sending: true,
				},
				{ id: 'q3', text: 'empty images', timestamp: 3 },
			]);
			expect(state.queuePaused).toBe(true);
		});
	});
	describe('withParticipantMentions', () => {
		it('prefixes every participant the body does not mention', () => {
			expect(withParticipantMentions('Cut the release.', ['rc', 'RunMaestro.ai'])).toBe(
				'@rc @RunMaestro.ai\n\nCut the release.'
			);
		});
		it('leaves the body alone when every participant is already mentioned', () => {
			const body = '@rc owns the RC. **@RunMaestro.ai** announces.';
			expect(withParticipantMentions(body, ['rc', 'RunMaestro.ai'])).toBe(body);
		});
		it('only adds the missing ones, hyphenating names with spaces', () => {
			expect(withParticipantMentions('@rc go', ['rc', 'Web Site'])).toBe('@Web-Site\n\n@rc go');
		});
		it('treats a hyphenated mention as matching a spaced name', () => {
			expect(withParticipantMentions('@Web-Site go', ['Web Site'])).toBe('@Web-Site go');
		});
	});
	describe('planGroupChatStart', () => {
		const agents = [
			{ id: 'a1', name: 'Alpha', toolType: 'claude-code' },
			{ id: 'a2', name: 'Beta', toolType: 'codex' },
			{ id: 'a3', name: 'Shell', toolType: 'terminal' },
			{ id: 'a4', name: 'Review Bot', toolType: 'claude-code' },
			{ id: 'a5', name: 'review-bot', toolType: 'opencode' },
		];
		it('plans the participants in the order asked, moderated by the first one’s provider', () => {
			expect(planGroupChatStart(['a2', 'a1'], agents)).toEqual({
				ok: true,
				participants: [agents[1], agents[0]],
				moderatorProvider: 'codex',
			});
		});
		it('lets the caller name the moderator’s provider', () => {
			expect(planGroupChatStart(['a1'], agents, 'opencode')).toMatchObject({
				ok: true,
				moderatorProvider: 'opencode',
			});
		});
		it('refuses an unknown agent, a terminal, and nobody', () => {
			expect(planGroupChatStart(['zzz'], agents)).toEqual({
				ok: false,
				error: 'Unknown agent: zzz',
			});
			expect(planGroupChatStart(['a3'], agents)).toEqual({
				ok: false,
				error: '"Shell" is a terminal agent and cannot join a group chat',
			});
			expect(planGroupChatStart([], agents)).toEqual({
				ok: false,
				error: 'At least 1 participant is required',
			});
		});
		it('refuses a name two agents answer to, so a mention picks out exactly one', () => {
			expect(planGroupChatStart(['a4'], agents)).toEqual({
				ok: false,
				error: '2 agents answer to @Review Bot; rename one so the mention is unambiguous',
			});
		});
		it('does not count a terminal as a namesake', () => {
			const withTerminalTwin = [
				{ id: 'a1', name: 'Alpha', toolType: 'claude-code' },
				{ id: 'a9', name: 'alpha', toolType: 'terminal' },
			];
			expect(planGroupChatStart(['a1'], withTerminalTwin).ok).toBe(true);
		});
	});
});
// Source: src/__tests__/shared/agentIds.test.ts
describe('', () => {
	describe('agentIds', () => {
		describe('AGENT_IDS', () => {
			it('should be a readonly array', () => {
				expect(Array.isArray(S11_AGENT_IDS)).toBe(true);
				expect(S11_AGENT_IDS.length).toBeGreaterThan(0);
			});
			it('should contain all known active agents', () => {
				expect(S11_AGENT_IDS).toContain('claude-code');
				expect(S11_AGENT_IDS).toContain('codex');
				expect(S11_AGENT_IDS).toContain('opencode');
				expect(S11_AGENT_IDS).toContain('factory-droid');
				expect(S11_AGENT_IDS).toContain('hermes');
				expect(S11_AGENT_IDS).toContain('pi');
				expect(S11_AGENT_IDS).toContain('terminal');
			});
			it('should contain placeholder agents', () => {
				expect(S11_AGENT_IDS).toContain('gemini-cli');
				expect(S11_AGENT_IDS).toContain('qwen3-coder');
			});
			it('should contain beta agents', () => {
				expect(S11_AGENT_IDS).toContain('copilot-cli');
				expect(S11_AGENT_IDS).toContain('omp');
			});
			it('should have no duplicates', () => {
				const unique = new Set(S11_AGENT_IDS);
				expect(unique.size).toBe(S11_AGENT_IDS.length);
			});
		});
		describe('isValidAgentId', () => {
			it('should return true for valid agent IDs', () => {
				for (const id of S11_AGENT_IDS) {
					expect(isValidAgentId(id)).toBe(true);
				}
			});
			it('should return false for invalid agent IDs', () => {
				expect(isValidAgentId('unknown-agent')).toBe(false);
				expect(isValidAgentId('')).toBe(false);
				expect(isValidAgentId('Claude Code')).toBe(false);
				expect(isValidAgentId('CLAUDE-CODE')).toBe(false);
			});
			it('should narrow the type to AgentId', () => {
				const id: string = 'claude-code';
				if (isValidAgentId(id)) {
					// TypeScript should accept this assignment without error
					const narrowed: AgentId = id;
					expect(narrowed).toBe('claude-code');
				}
			});
		});
		describe('AgentId type', () => {
			it('should be assignable from valid string literals', () => {
				const id: AgentId = 'claude-code';
				expect(id).toBe('claude-code');
			});
		});
	});
});
// Source: src/__tests__/shared/embeddedSystemPrompt.test.ts
describe('', () => {
	const SYSTEM_PROMPT = '# Maestro System Context\n\nYou are **Scout**, powered by **codex**.';
	describe('embedSystemPromptInPrompt', () => {
		it('round-trips: the strip recovers exactly what was embedded', () => {
			const wrapped = embedSystemPromptInPrompt(SYSTEM_PROMPT, 'summarise the release notes');
			expect(wrapped.startsWith(SYSTEM_PROMPT)).toBe(true);
			expect(stripEmbeddedSystemPrompt(wrapped)).toBe('summarise the release notes');
		});
		it('keeps the on-disk wire format that existing transcripts were written with', () => {
			// Changing this string orphans every transcript already on disk.
			expect(EMBEDDED_SYSTEM_PROMPT_SEPARATOR).toBe('\n\n---\n\n# User Request\n\n');
		});
		it('preserves a multi-line user request verbatim', () => {
			const prompt = 'line one\n\n---\n\nline two';
			expect(stripEmbeddedSystemPrompt(embedSystemPromptInPrompt(SYSTEM_PROMPT, prompt))).toBe(
				prompt
			);
		});
	});
	describe('stripEmbeddedSystemPrompt', () => {
		it('leaves an ordinary message untouched', () => {
			expect(stripEmbeddedSystemPrompt('just a question')).toBe('just a question');
		});
		it('leaves empty text untouched', () => {
			expect(stripEmbeddedSystemPrompt('')).toBe('');
		});
		it('does not strip a message that OPENS with the heading', () => {
			// Nothing precedes the separator, so this was never wrapped - stripping
			// would delete the user's own first line.
			const text = '# User Request\n\nplease look at the build';
			expect(stripEmbeddedSystemPrompt(text)).toBe(text);
		});
		it('honours the first separator only, so the user can use the marker themselves', () => {
			const prompt = 'compare these two\n\n---\n\n# User Request\n\nsecond one';
			expect(stripEmbeddedSystemPrompt(embedSystemPromptInPrompt(SYSTEM_PROMPT, prompt))).toBe(
				prompt
			);
		});
	});
	describe('hasEmbeddedSystemPrompt', () => {
		it('reports the envelope only when something precedes the separator', () => {
			expect(hasEmbeddedSystemPrompt(embedSystemPromptInPrompt(SYSTEM_PROMPT, 'hi'))).toBe(true);
			expect(hasEmbeddedSystemPrompt('# User Request\n\nhi')).toBe(false);
			expect(hasEmbeddedSystemPrompt('plain message')).toBe(false);
			expect(hasEmbeddedSystemPrompt('')).toBe(false);
		});
	});
});
// Source: src/__tests__/shared/autorunSteering.test.ts
describe('', () => {
	const note = (overrides: Partial<AutoRunSteeringNote> = {}): AutoRunSteeringNote => ({
		id: 'note-1',
		text: 'Important notice: Maestro error.',
		timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
		...overrides,
	});
	describe('normalizeSteeringNoteText', () => {
		it('trims surrounding whitespace', () => {
			expect(normalizeSteeringNoteText('  steer left \n')).toBe('steer left');
		});
		it('reads whitespace-only input as nothing to send', () => {
			expect(normalizeSteeringNoteText('   \n\t ')).toBe('');
		});
		it('caps a paste so one note cannot dominate the turn it was meant to nudge', () => {
			const long = 'x'.repeat(MAX_STEERING_NOTE_LENGTH + 500);
			expect(normalizeSteeringNoteText(long)).toHaveLength(MAX_STEERING_NOTE_LENGTH);
		});
	});
	describe('formatSteeringNotesBlock', () => {
		it('returns an empty string with no notes so callers can prepend unconditionally', () => {
			expect(formatSteeringNotesBlock([])).toBe('');
		});
		it('wraps the notes in the marked block', () => {
			const block = formatSteeringNotesBlock([note()]);
			expect(block.startsWith(STEERING_BLOCK_START)).toBe(true);
			expect(block.endsWith(STEERING_BLOCK_END)).toBe(true);
			expect(block).toContain('Important notice: Maestro error.');
		});
		it('numbers several notes in the order they were sent', () => {
			const block = formatSteeringNotesBlock([
				note({ id: 'a', text: 'first' }),
				note({ id: 'b', text: 'second' }),
			]);
			expect(block).toMatch(/1\. \([^)]+\) first/);
			expect(block).toMatch(/2\. \([^)]+\) second/);
			expect(block).toContain('Conductor steering notes');
		});
		it('uses the singular heading for one note', () => {
			expect(formatSteeringNotesBlock([note()])).toContain(
				'Conductor steering note - read this first'
			);
		});
		it('indents continuation lines so a multi-line note stays inside its own item', () => {
			const block = formatSteeringNotesBlock([note({ text: 'line one\nline two' })]);
			expect(block).toContain('\n   line two');
		});
		it('leaves template syntax in a note alone - it is the operator literal text', () => {
			const block = formatSteeringNotesBlock([note({ text: 'check {{GIT_BRANCH}}' })]);
			expect(block).toContain('check {{GIT_BRANCH}}');
		});
	});
});
// Source: src/__tests__/shared/normalizeChatDisplayMath.test.ts
describe('', () => {
	describe('normalizeChatDisplayMath', () => {
		it('moves hugging delimiters of a multi-line block onto their own lines', () => {
			const input = '$$\\begin{aligned}\na &= b\n\\end{aligned}$$';
			expect(normalizeChatDisplayMath(input)).toBe(
				'$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$'
			);
		});
		it('leaves single-line $$...$$ untouched (inline -> promote path)', () => {
			const input = 'before $$x + y$$ after';
			expect(normalizeChatDisplayMath(input)).toBe(input);
		});
		it('is idempotent for blocks already on their own lines', () => {
			const input = '$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$';
			expect(normalizeChatDisplayMath(input)).toBe(input);
		});
		it('normalizes only the opening delimiter when the close is already clean', () => {
			const input = '$$\\begin{aligned}\na &= b\n\\end{aligned}\n$$';
			expect(normalizeChatDisplayMath(input)).toBe(
				'$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$'
			);
		});
		it('normalizes multiple multi-line blocks independently', () => {
			const input = '$$a\nb$$\n\ntext\n\n$$c\nd$$';
			expect(normalizeChatDisplayMath(input)).toBe('$$\na\nb\n$$\n\ntext\n\n$$\nc\nd\n$$');
		});
		it('does not touch $$ inside a fenced code block', () => {
			const input = '```\n$$a\nb$$\n```';
			expect(normalizeChatDisplayMath(input)).toBe(input);
		});
		it('does not touch $$ inside a tilde-fenced code block', () => {
			const input = '~~~\n$$a\nb$$\n~~~';
			expect(normalizeChatDisplayMath(input)).toBe(input);
		});
		it('does not touch $$ inside an inline code span', () => {
			const input = 'use `$$a$$` literally';
			expect(normalizeChatDisplayMath(input)).toBe(input);
		});
		it('returns input unchanged when there is no $$', () => {
			const input = 'plain text with $5 and $HOME';
			expect(normalizeChatDisplayMath(input)).toBe(input);
		});
		it('leaves an unbalanced trailing $$ alone', () => {
			const input = '$$a\nb$$ tail $$';
			// First pair (multi-line) is normalized; the lone trailing $$ is left.
			expect(normalizeChatDisplayMath(input)).toBe('$$\na\nb\n$$ tail $$');
		});
		it('trims spaces hugging the delimiters but preserves inner newlines', () => {
			const input = '$$  a\nb  $$';
			expect(normalizeChatDisplayMath(input)).toBe('$$\na\nb\n$$');
		});
	});
});
// Source: src/__tests__/shared/claudeTokenModeLabel.test.ts
describe('', () => {
	describe('getTokenSourcePill', () => {
		describe('label', () => {
			it('labels an interactive turn "TUI Wrapper"', () => {
				expect(getTokenSourcePill({ mode: 'interactive' }).label).toBe('TUI Wrapper');
			});
			it('labels an api turn "claude -p"', () => {
				expect(getTokenSourcePill({ mode: 'api' }).label).toBe('claude -p');
			});
			it('prefixes "Dynamic " when adaptive is set', () => {
				expect(getTokenSourcePill({ mode: 'interactive', adaptive: true }).label).toBe(
					'Dynamic TUI Wrapper'
				);
				expect(getTokenSourcePill({ mode: 'api', adaptive: true }).label).toBe('Dynamic claude -p');
			});
			it('omits the "Dynamic " prefix when adaptive is false or omitted', () => {
				expect(getTokenSourcePill({ mode: 'interactive', adaptive: false }).label).toBe(
					'TUI Wrapper'
				);
				expect(getTokenSourcePill({ mode: 'api' }).label).toBe('claude -p');
			});
		});
		describe('isTui flag', () => {
			it('is true for interactive and false for api', () => {
				expect(getTokenSourcePill({ mode: 'interactive' }).isTui).toBe(true);
				expect(getTokenSourcePill({ mode: 'api' }).isTui).toBe(false);
			});
		});
		describe('title', () => {
			it('describes the maestro-p TUI capture for interactive turns', () => {
				expect(getTokenSourcePill({ mode: 'interactive' }).title).toBe(
					'Captured via maestro-p driving the Claude TUI'
				);
			});
			it('describes the claude --print capture for api turns', () => {
				expect(getTokenSourcePill({ mode: 'api' }).title).toBe('Captured via claude --print');
			});
			it('notes Dynamic Mode in the tooltip when adaptive is set', () => {
				expect(getTokenSourcePill({ mode: 'interactive', adaptive: true }).title).toBe(
					'Captured via maestro-p driving the Claude TUI (Dynamic Mode enabled)'
				);
				expect(getTokenSourcePill({ mode: 'api', adaptive: true }).title).toBe(
					'Captured via claude --print (Dynamic Mode enabled - switched from the TUI)'
				);
			});
			it('uses the forced-fallback wording when reason is "limit", regardless of mode', () => {
				const forced = "Forced fallback: the plan's 5-hour or weekly limit was hit.";
				expect(getTokenSourcePill({ mode: 'api', reason: 'limit' }).title).toBe(forced);
				expect(getTokenSourcePill({ mode: 'interactive', reason: 'limit' }).title).toBe(forced);
			});
		});
	});
});
// Source: src/__tests__/shared/statsActiveAgents.test.ts
describe('', () => {
	/** `bySessionByDay` slice: session id -> per-day rows carrying a count. */
	const aggregation = (byId: Record<string, number[]>): BySessionByDay =>
		Object.fromEntries(
			Object.entries(byId).map(([id, counts]) => [
				id,
				counts.map((count, i) => ({ date: `2026-01-0${i + 1}`, count })),
			])
		) as BySessionByDay;
	describe('isAgentActiveInRange', () => {
		it('is true for an agent with queries in the range', () => {
			expect(isAgentActiveInRange('a', aggregation({ a: [0, 3] }))).toBe(true);
		});
		it('is false for an agent absent from the aggregation', () => {
			expect(isAgentActiveInRange('missing', aggregation({ a: [3] }))).toBe(false);
		});
		it('is false for an agent present with only zeroed days', () => {
			// Presence alone would nearly always be enough; the count sum guards
			// against a future aggregation emitting an empty or zeroed day series.
			expect(isAgentActiveInRange('a', aggregation({ a: [0, 0] }))).toBe(false);
		});
		it('is false for an empty day series', () => {
			expect(isAgentActiveInRange('a', aggregation({ a: [] }))).toBe(false);
		});
		it('is false when there is no aggregation at all', () => {
			expect(isAgentActiveInRange('a', undefined)).toBe(false);
		});
	});
	describe('countActiveAgents', () => {
		it('counts only the agents that recorded work themselves', () => {
			const agents = [{ id: 'busy' }, { id: 'idle' }, { id: 'never-ran' }];
			const data = aggregation({ busy: [5], idle: [0] });
			// `never-ran` shares a provider with `busy` in the real dashboard; that
			// must not lend it activity it did not have.
			expect(countActiveAgents(agents, data)).toBe(1);
		});
		it('is zero for an empty fleet', () => {
			expect(countActiveAgents([], aggregation({ a: [9] }))).toBe(0);
		});
		it('is zero when no aggregation has loaded yet', () => {
			expect(countActiveAgents([{ id: 'a' }], undefined)).toBe(0);
		});
	});
});
// Source: src/__tests__/shared/jsonUtils.test.ts
describe('', () => {
	describe('jsonUtils', () => {
		it('strips a leading UTF-8 BOM', () => {
			expect(stripJsonBom('\uFEFF{"ok":true}')).toBe('{"ok":true}');
		});
		it('does not strip non-leading BOM characters', () => {
			expect(stripJsonBom('{"value":"\uFEFF"}')).toBe('{"value":"\uFEFF"}');
		});
		it('parses BOM-prefixed JSON', () => {
			expect(
				parseJsonWithBom<{
					ok: boolean;
				}>('\uFEFF{"ok":true}')
			).toEqual({ ok: true });
		});
	});
	describe('assertSerializedJsonIsSafe', () => {
		// Payloads over 1MB skip the round-trip parse; anything at or under it keeps
		// the full check. Both sides of that threshold need covering.
		const big = (inner: string): string => `{"pad":"${'x'.repeat(1200000)}"${inner}`;
		it('accepts well-formed small payloads', () => {
			expect(() => assertSerializedJsonIsSafe('{"ok":true}', 'store')).not.toThrow();
			expect(() => assertSerializedJsonIsSafe('[]', 'store')).not.toThrow();
		});
		it('rejects the undefined that JSON.stringify returns for undefined input', () => {
			expect(() => assertSerializedJsonIsSafe(JSON.stringify(undefined), 'store')).toThrow(
				'empty/undefined'
			);
		});
		it('rejects an empty payload', () => {
			expect(() => assertSerializedJsonIsSafe('', 'store')).toThrow('empty/undefined');
		});
		it('names the target in the error so a bad write is traceable', () => {
			expect(() => assertSerializedJsonIsSafe(undefined, '/data/runs.json')).toThrow(
				'/data/runs.json'
			);
		});
		it('still parses small payloads, catching malformed text', () => {
			expect(() => assertSerializedJsonIsSafe('{not json', 'store')).toThrow('unparseable');
		});
		it('accepts a large well-formed payload without parsing it', () => {
			expect(() => assertSerializedJsonIsSafe(big('}'), 'store')).not.toThrow();
		});
		it('tolerates trailing whitespace on a large payload', () => {
			// The agent-run store appends a newline to every file it writes.
			expect(() => assertSerializedJsonIsSafe(`${big('}')}\n`, 'store')).not.toThrow();
		});
		it('rejects a large payload whose delimiters do not balance', () => {
			expect(() => assertSerializedJsonIsSafe(big(''), 'store')).toThrow('malformed');
			expect(() => assertSerializedJsonIsSafe(`${'y'.repeat(1200000)}`, 'store')).toThrow(
				'malformed'
			);
		});
		it('accepts a large top-level array', () => {
			expect(() => assertSerializedJsonIsSafe(`["${'z'.repeat(1200000)}"]`, 'store')).not.toThrow();
		});
	});
	describe('serializedJsonByteLength', () => {
		it('counts the UTF-8 bytes of the JSON text', () => {
			expect(serializedJsonByteLength({ a: 1 })).toBe(7);
			expect(serializedJsonByteLength('é')).toBe(4); // 2-byte character plus quotes
			expect(serializedJsonByteLength('€')).toBe(5); // 3-byte character plus quotes
			expect(serializedJsonByteLength('\u{1F600}')).toBe(6); // 4-byte character (a surrogate pair)
		});
		it('returns null for a value JSON cannot hold, instead of throwing', () => {
			expect(serializedJsonByteLength(undefined)).toBeNull();
			expect(serializedJsonByteLength(() => 1)).toBeNull();
			expect(serializedJsonByteLength(BigInt(1))).toBeNull();
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			expect(serializedJsonByteLength(circular)).toBeNull();
		});
		it('is the function the plugin contract re-exports (the plugin SDK drift test reads that export)', () => {
			expect(contributionsByteLength).toBe(serializedJsonByteLength);
		});
	});
});
// Source: src/__tests__/shared/encoreFeatures.test.ts
describe('', () => {
	describe('ENCORE_FEATURE_DEFAULTS', () => {
		it('ships every graduated feature on', () => {
			expect(ENCORE_FEATURE_DEFAULTS).toMatchObject({
				directorNotes: true,
				usageStats: true,
				symphony: true,
				maestroCue: true,
				quickChat: true,
			});
		});
		it('ships the Throughput Gauge off', () => {
			expect(ENCORE_FEATURE_DEFAULTS.throughputGauge).toBe(false);
		});
		it('ships Dataview off', () => {
			expect(ENCORE_FEATURE_DEFAULTS.dataview).toBe(false);
		});
	});
	describe('resolveEncoreFeatures', () => {
		it('returns the defaults when nothing is persisted', () => {
			expect(resolveEncoreFeatures(undefined)).toEqual(ENCORE_FEATURE_DEFAULTS);
			expect(resolveEncoreFeatures(null)).toEqual(ENCORE_FEATURE_DEFAULTS);
			expect(resolveEncoreFeatures({})).toEqual(ENCORE_FEATURE_DEFAULTS);
		});
		it('honors a flag the user switched off', () => {
			expect(resolveEncoreFeatures({ maestroCue: false })).toEqual({
				...ENCORE_FEATURE_DEFAULTS,
				maestroCue: false,
			});
		});
		it('leaves a flag the stored object predates at its default', () => {
			// A settings file written before a flag existed must not read as off.
			const stored = { symphony: false };
			expect(resolveEncoreFeatures(stored)).toEqual({
				...ENCORE_FEATURE_DEFAULTS,
				symphony: false,
			});
		});
		it('ignores non-boolean values rather than coercing them', () => {
			const resolved = resolveEncoreFeatures({
				directorNotes: 'false',
				usageStats: 0,
				maestroCue: null,
			});
			expect(resolved).toEqual(ENCORE_FEATURE_DEFAULTS);
		});
		it('drops keys that are not Encore flags', () => {
			const resolved = resolveEncoreFeatures({ telepathy: true }) as unknown as Record<
				string,
				unknown
			>;
			expect(resolved.telepathy).toBeUndefined();
			expect(resolved).toEqual(ENCORE_FEATURE_DEFAULTS);
		});
		it('does not mutate the shared default object', () => {
			const resolved = resolveEncoreFeatures({ symphony: false });
			expect(resolved).not.toBe(ENCORE_FEATURE_DEFAULTS);
			expect(ENCORE_FEATURE_DEFAULTS.symphony).toBe(true);
		});
	});
	describe('isEncoreFeatureEnabled / requireEncoreFeature', () => {
		const storeWith = (encoreFeatures: unknown) => ({
			get: (key: string) => (key === 'encoreFeatures' ? encoreFeatures : undefined),
		});
		it('reads through the defaults, so an unsaved default-on flag is on', () => {
			expect(isEncoreFeatureEnabled(storeWith(undefined), 'maestroCue')).toBe(true);
			expect(isEncoreFeatureEnabled(storeWith(undefined), 'coworking')).toBe(false);
			expect(isEncoreFeatureEnabled(storeWith({ maestroCue: false }), 'maestroCue')).toBe(false);
		});
		it('throws the given code only when the flag is off', () => {
			expect(() =>
				requireEncoreFeature(storeWith({ symphony: true }), 'symphony', 'X')
			).not.toThrow();
			expect(() => requireEncoreFeature(storeWith({ symphony: false }), 'symphony', 'X')).toThrow(
				new Error('X')
			);
		});
	});
});
