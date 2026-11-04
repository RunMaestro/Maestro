// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/useAgentCapabilities.test.ts
// Source: src/__tests__/renderer/hooks/useAgentErrorRecovery.test.ts
// Source: src/__tests__/renderer/hooks/useAgentMentionCompletion.test.ts
// Source: src/__tests__/renderer/hooks/useAgentRun.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	renderHook as s1_renderHook,
	act as s1_act,
	waitFor as s1_waitFor,
} from '@testing-library/react';
import {
	useAgentCapabilities,
	clearCapabilitiesCache,
	DEFAULT_CAPABILITIES,
} from '../../../renderer/hooks';
import {
	hasCapabilityCached,
	setCapabilitiesCache,
	getCachedCapabilities,
	primeCapabilitiesCache,
} from '../../../renderer/hooks/agent/useAgentCapabilities';
import { useCapabilitiesPriming } from '../../../renderer/hooks/agent/useCapabilitiesPriming';
import { renderHook as s2_renderHook, act as s2_act } from '@testing-library/react';
import { useAgentErrorRecovery } from '../../../renderer/hooks';
import type { AgentError } from '../../../shared/types';
import { renderHook as s3_renderHook } from '@testing-library/react';
import {
	useAgentMentionCompletion,
	buildKnownMentionNameSet,
	type AgentMentionSuggestion,
} from '../../../renderer/hooks/input/useAgentMentionCompletion';
import type { Session, Group } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import {
	act as s4_act,
	renderHook as s4_renderHook,
	waitFor as s4_waitFor,
} from '@testing-library/react';
import type { AgentRun, AgentRunEvent } from '../../../shared/agent-run';
import type { Campaign } from '../../../shared/campaign';
import { useAgentRun } from '../../../renderer/hooks/agentRun/useAgentRun';
// Source: src/__tests__/renderer/hooks/useAgentCapabilities.test.ts
describe('', () => {
	const baseCapabilities = {
		supportsResume: true,
		supportsReadOnlyMode: true,
		supportsJsonOutput: true,
		supportsSessionId: true,
		supportsImageInput: true,
		supportsImageInputOnResume: true,
		supportsSlashCommands: true,
		supportsSessionStorage: true,
		supportsCostTracking: true,
		supportsUsageStats: true,
		supportsBatchMode: true,
		requiresPromptToStart: false,
		supportsStreaming: true,
		supportsResultMessages: true,
		supportsModelSelection: false,
		supportsStreamJsonInput: true,
		supportsPromptViaStdin: true,
		supportsThinkingDisplay: false, // Added in Show Thinking feature
		supportsContextMerge: false,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: false,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false,
	};
	describe('useAgentCapabilities', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			clearCapabilitiesCache();
		});
		it('exposes translated project memory per agent without changing the provider cache', () => {
			setCapabilitiesCache('codex', baseCapabilities);
			const { result } = s1_renderHook(() =>
				useAgentCapabilities('codex', '/project/.maestro/provider-knowledge/managed')
			);
			expect(result.current.hasCapability('supportsProjectMemory')).toBe(true);
			expect(hasCapabilityCached('codex', 'supportsProjectMemory')).toBe(false);
		});
		it('loads capabilities and caches results', async () => {
			vi.mocked(window.maestro.agents.getCapabilities).mockResolvedValueOnce(baseCapabilities);
			const { result } = s1_renderHook(() => useAgentCapabilities('claude-code'));
			await s1_waitFor(() => {
				expect(result.current.loading).toBe(false);
			});
			expect(result.current.capabilities).toEqual(baseCapabilities);
			expect(window.maestro.agents.getCapabilities).toHaveBeenCalledTimes(1);
			const { result: result2 } = s1_renderHook(() => useAgentCapabilities('claude-code'));
			await s1_waitFor(() => {
				expect(result2.current.loading).toBe(false);
			});
			expect(result2.current.capabilities).toEqual(baseCapabilities);
			expect(window.maestro.agents.getCapabilities).toHaveBeenCalledTimes(1);
		});
		it('refreshes capabilities by bypassing cache', async () => {
			const updatedCapabilities = {
				...baseCapabilities,
				supportsImageInput: false,
			};
			vi.mocked(window.maestro.agents.getCapabilities)
				.mockResolvedValueOnce(baseCapabilities)
				.mockResolvedValueOnce(updatedCapabilities);
			const { result } = s1_renderHook(() => useAgentCapabilities('claude-code'));
			await s1_waitFor(() => {
				expect(result.current.capabilities).toEqual(baseCapabilities);
			});
			await s1_act(async () => {
				await result.current.refresh();
			});
			expect(result.current.capabilities).toEqual(updatedCapabilities);
			expect(window.maestro.agents.getCapabilities).toHaveBeenCalledTimes(2);
		});
		it('clears error state when agentId is unset', async () => {
			vi.mocked(window.maestro.agents.getCapabilities).mockRejectedValue(new Error('boom'));
			const { result, rerender } = s1_renderHook(
				({ agentId }: { agentId?: string }) => useAgentCapabilities(agentId),
				{ initialProps: { agentId: 'claude-code' } }
			);
			await s1_waitFor(() => {
				expect(result.current.error).toBe('boom');
			});
			rerender({ agentId: undefined });
			await s1_waitFor(() => {
				expect(result.current.error).toBeNull();
				expect(result.current.capabilities).toEqual(DEFAULT_CAPABILITIES);
			});
		});
	});
	describe('hasCapabilityCached', () => {
		beforeEach(() => {
			clearCapabilitiesCache();
		});
		it('returns DEFAULT_CAPABILITIES value when agent is not cached', () => {
			expect(hasCapabilityCached('uncached-agent', 'supportsResume')).toBe(false);
			expect(hasCapabilityCached('uncached-agent', 'supportsBatchMode')).toBe(false);
		});
		it('returns correct value from cached capabilities', () => {
			setCapabilitiesCache('test-agent', {
				...DEFAULT_CAPABILITIES,
				supportsResume: true,
				supportsBatchMode: true,
				supportsWizard: true,
			});
			expect(hasCapabilityCached('test-agent', 'supportsResume')).toBe(true);
			expect(hasCapabilityCached('test-agent', 'supportsBatchMode')).toBe(true);
			expect(hasCapabilityCached('test-agent', 'supportsWizard')).toBe(true);
			expect(hasCapabilityCached('test-agent', 'supportsSlashCommands')).toBe(false);
		});
		it('returns false for new capability flags when not set', () => {
			setCapabilitiesCache('test-agent', { ...DEFAULT_CAPABILITIES });
			expect(hasCapabilityCached('test-agent', 'supportsWizard')).toBe(false);
			expect(hasCapabilityCached('test-agent', 'supportsGroupChatModeration')).toBe(false);
			expect(hasCapabilityCached('test-agent', 'usesJsonLineOutput')).toBe(false);
			expect(hasCapabilityCached('test-agent', 'usesCombinedContextWindow')).toBe(false);
		});
		it('falls back to defaults after cache is cleared', () => {
			setCapabilitiesCache('test-agent', {
				...DEFAULT_CAPABILITIES,
				supportsResume: true,
			});
			expect(hasCapabilityCached('test-agent', 'supportsResume')).toBe(true);
			clearCapabilitiesCache();
			expect(hasCapabilityCached('test-agent', 'supportsResume')).toBe(false);
		});
	});
	describe('getCachedCapabilities', () => {
		beforeEach(() => {
			clearCapabilitiesCache();
		});
		it('returns undefined for an agent that was never looked up', () => {
			expect(getCachedCapabilities('uncached-agent')).toBeUndefined();
		});
		// The distinction hasCapabilityCached cannot make: a cached `false` is an
		// answer, a miss is not. Conflating them is what silently dropped CLI
		// dispatches to agent types the user had not opened.
		it('distinguishes a cached false from a miss', () => {
			setCapabilitiesCache('test-agent', {
				...DEFAULT_CAPABILITIES,
				supportsBatchMode: false,
			});
			expect(getCachedCapabilities('test-agent')?.supportsBatchMode).toBe(false);
			expect(getCachedCapabilities('other-agent')).toBeUndefined();
			// Both look identical through hasCapabilityCached.
			expect(hasCapabilityCached('test-agent', 'supportsBatchMode')).toBe(false);
			expect(hasCapabilityCached('other-agent', 'supportsBatchMode')).toBe(false);
		});
	});
	describe('primeCapabilitiesCache', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			clearCapabilitiesCache();
		});
		it('populates the cache for every returned agent id', async () => {
			vi.mocked(window.maestro.agents.getAllCapabilities).mockResolvedValueOnce({
				opencode: { ...DEFAULT_CAPABILITIES, supportsBatchMode: true },
				terminal: { ...DEFAULT_CAPABILITIES, supportsBatchMode: false },
			});
			const primed = await primeCapabilitiesCache();
			expect(primed).toBe(2);
			expect(getCachedCapabilities('opencode')?.supportsBatchMode).toBe(true);
			expect(getCachedCapabilities('terminal')?.supportsBatchMode).toBe(false);
			expect(hasCapabilityCached('opencode', 'supportsBatchMode')).toBe(true);
		});
		it('merges partial capability payloads over the defaults', async () => {
			vi.mocked(window.maestro.agents.getAllCapabilities).mockResolvedValueOnce({
				opencode: { supportsBatchMode: true } as any,
			});
			await primeCapabilitiesCache();
			expect(getCachedCapabilities('opencode')).toEqual({
				...DEFAULT_CAPABILITIES,
				supportsBatchMode: true,
			});
		});
		it('returns 0 and leaves the cache untouched when the fetch fails', async () => {
			setCapabilitiesCache('opencode', { ...DEFAULT_CAPABILITIES, supportsBatchMode: true });
			vi.mocked(window.maestro.agents.getAllCapabilities).mockRejectedValueOnce(
				new Error('IPC down')
			);
			await expect(primeCapabilitiesCache()).resolves.toBe(0);
			expect(getCachedCapabilities('opencode')?.supportsBatchMode).toBe(true);
		});
	});
	describe('useCapabilitiesPriming', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			clearCapabilitiesCache();
		});
		it('primes the cache once on mount', async () => {
			vi.mocked(window.maestro.agents.getAllCapabilities).mockResolvedValue({
				opencode: { ...DEFAULT_CAPABILITIES, supportsBatchMode: true },
			});
			const { rerender } = s1_renderHook(() => useCapabilitiesPriming());
			rerender();
			await s1_waitFor(() => {
				expect(getCachedCapabilities('opencode')?.supportsBatchMode).toBe(true);
			});
			expect(window.maestro.agents.getAllCapabilities).toHaveBeenCalledTimes(1);
		});
		it('does not throw when priming fails', async () => {
			vi.mocked(window.maestro.agents.getAllCapabilities).mockRejectedValue(new Error('IPC down'));
			expect(() => s1_renderHook(() => useCapabilitiesPriming())).not.toThrow();
			await s1_waitFor(() => {
				expect(window.maestro.agents.getAllCapabilities).toHaveBeenCalled();
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/useAgentErrorRecovery.test.ts
describe('', () => {
	const baseError: AgentError = {
		type: 'auth_expired',
		message: 'Authentication required',
		recoverable: true,
		agentId: 'claude-code',
		timestamp: 1700000000000,
	};
	describe('useAgentErrorRecovery', () => {
		it('creates claude-code auth actions naming the login command, plus new session', () => {
			const onAuthenticate = vi.fn();
			const onNewSession = vi.fn();
			const { result } = s2_renderHook(() =>
				useAgentErrorRecovery({
					error: baseError,
					agentId: 'claude-code',
					sessionId: 's1',
					onAuthenticate,
					onNewSession,
				})
			);
			const [authAction, newSessionAction] = result.current.recoveryActions;
			expect(authAction.id).toBe('authenticate');
			expect(authAction.label).toBe('Re-authenticate');
			// The login runs inside Maestro now, so the description names the command
			// rather than telling the user to go find a terminal.
			expect(authAction.description).toBe('Run "claude /login" here');
			expect(authAction.primary).toBe(true);
			expect(newSessionAction.id).toBe('new-session');
			s2_act(() => {
				authAction.onClick();
				newSessionAction.onClick();
			});
			expect(onAuthenticate).toHaveBeenCalledTimes(1);
			expect(onNewSession).toHaveBeenCalledTimes(1);
		});
		it('offers restart + new session for agent crashes', () => {
			const onRestartAgent = vi.fn();
			const onNewSession = vi.fn();
			const { result } = s2_renderHook(() =>
				useAgentErrorRecovery({
					error: { ...baseError, type: 'agent_crashed' },
					agentId: 'claude-code',
					sessionId: 's1',
					onRestartAgent,
					onNewSession,
				})
			);
			const [restartAction, newSessionAction] = result.current.recoveryActions;
			expect(restartAction.id).toBe('restart-agent');
			expect(restartAction.primary).toBe(true);
			expect(newSessionAction.id).toBe('new-session');
			s2_act(() => {
				restartAction.onClick();
				newSessionAction.onClick();
			});
			expect(onRestartAgent).toHaveBeenCalledTimes(1);
			expect(onNewSession).toHaveBeenCalledTimes(1);
		});
		it('returns retry action for rate limits', () => {
			const onRetry = vi.fn();
			const { result } = s2_renderHook(() =>
				useAgentErrorRecovery({
					error: { ...baseError, type: 'rate_limited' },
					agentId: 'claude-code',
					sessionId: 's1',
					onRetry,
				})
			);
			expect(result.current.recoveryActions).toHaveLength(1);
			expect(result.current.recoveryActions[0].id).toBe('retry');
			s2_act(() => {
				result.current.recoveryActions[0].onClick();
			});
			expect(onRetry).toHaveBeenCalledTimes(1);
		});
	});
});
// Source: src/__tests__/renderer/hooks/useAgentMentionCompletion.test.ts
describe('', () => {
	// =============================================================================
	// HELPERS
	// =============================================================================
	function agent(id: string, name: string, overrides: Partial<Session> = {}): Session {
		return createMockSession({ id, name, toolType: 'claude-code', ...overrides });
	}
	function getSuggestions(
		sessions: Session[],
		groups: Group[] | undefined,
		currentSessionId: string | null,
		filter = ''
	): AgentMentionSuggestion[] {
		const { result } = s3_renderHook(() =>
			useAgentMentionCompletion(sessions, groups, currentSessionId)
		);
		return result.current.getSuggestions(filter);
	}
	// =============================================================================
	// TESTS
	// =============================================================================
	describe('useAgentMentionCompletion', () => {
		it('produces a `@name ` token for each mentionable agent', () => {
			const suggestions = getSuggestions([agent('a', 'Alpha'), agent('b', 'Beta')], [], 'current');
			expect(suggestions).toHaveLength(2);
			expect(suggestions.every((s) => s.kind === 'agent')).toBe(true);
			expect(suggestions.map((s) => s.value)).toEqual(
				expect.arrayContaining(['@Alpha ', '@Beta '])
			);
			// Token carries a single-at prefix, a single trailing space, and no `@@`.
			for (const s of suggestions) {
				expect(s.value.startsWith('@')).toBe(true);
				expect(s.value.startsWith('@@')).toBe(false);
				expect(s.value.endsWith(' ')).toBe(true);
			}
		});
		it('normalizes spaces in agent names to hyphens in the token', () => {
			const suggestions = getSuggestions([agent('a', 'Review Bot')], [], 'current');
			expect(suggestions[0].value).toBe('@Review-Bot ');
			expect(suggestions[0].displayText).toBe('Review Bot');
		});
		it('excludes the current session (an agent cannot mention itself)', () => {
			const suggestions = getSuggestions(
				[agent('self', 'Self'), agent('other', 'Other')],
				[],
				'self'
			);
			expect(suggestions).toHaveLength(1);
			expect(suggestions[0].displayText).toBe('Other');
		});
		it('excludes terminal-only sessions', () => {
			const suggestions = getSuggestions(
				[agent('a', 'Alpha'), agent('t', 'Term', { toolType: 'terminal' })],
				[],
				'current'
			);
			expect(suggestions).toHaveLength(1);
			expect(suggestions[0].displayText).toBe('Alpha');
		});
		it('carries targetSessionId + toolType for agents', () => {
			const [only] = getSuggestions([agent('a', 'Alpha', { toolType: 'codex' })], [], 'current');
			expect(only.targetSessionId).toBe('a');
			expect(only.toolType).toBe('codex');
		});
		it('flags SSH agents with their remote id, and leaves local agents unflagged', () => {
			const suggestions = getSuggestions(
				[
					agent('local', 'Local'),
					agent('remote', 'Remote', {
						sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					}),
					// Configured but switched off: the message runs locally, so no pill.
					agent('off', 'Off', {
						sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' },
					}),
				],
				[],
				'current'
			);
			const byName = new Map(suggestions.map((s) => [s.displayText, s]));
			expect(byName.get('Remote')?.isSshRemote).toBe(true);
			expect(byName.get('Remote')?.sshRemoteId).toBe('remote-1');
			expect(byName.get('Local')?.isSshRemote).toBe(false);
			expect(byName.get('Local')?.sshRemoteId).toBeNull();
			expect(byName.get('Off')?.isSshRemote).toBe(false);
		});
		it('surfaces groups with at least one non-terminal member, carrying member ids', () => {
			const sessions = [
				agent('a', 'Alpha', { groupId: 'g1' }),
				agent('b', 'Beta', { groupId: 'g1' }),
			];
			const groups: Group[] = [{ id: 'g1', name: 'Squad', emoji: '', collapsed: false }];
			const suggestions = getSuggestions(sessions, groups, 'current');
			const group = suggestions.find((s) => s.kind === 'group');
			expect(group).toBeDefined();
			expect(group?.value).toBe('@Squad ');
			expect(group?.groupId).toBe('g1');
			expect(group?.memberSessionIds).toEqual(['a', 'b']);
		});
		it('carries a member expansion so accepting a group inserts its agents, not the group', () => {
			const sessions = [
				agent('a', 'Alpha', { groupId: 'g1' }),
				agent('b', 'Beta', { groupId: 'g1' }),
				agent('c', 'Gamma'),
			];
			const groups: Group[] = [{ id: 'g1', name: 'Squad', emoji: '', collapsed: false }];
			const suggestions = getSuggestions(sessions, groups, 'current');
			const group = suggestions.find((s) => s.kind === 'group');
			// Only the group's own members, in roster order, with a trailing space.
			expect(group?.memberMentionValue).toBe('@Alpha @Beta ');
			// Each expanded token is byte-identical to picking that agent's own row.
			const alpha = suggestions.find((s) => s.displayText === 'Alpha');
			expect(group?.memberMentionValue?.startsWith(alpha?.value.trimEnd() ?? '')).toBe(true);
		});
		it('skips groups with no non-terminal members', () => {
			const sessions = [agent('t', 'Term', { groupId: 'g1', toolType: 'terminal' })];
			const groups: Group[] = [{ id: 'g1', name: 'Empty', emoji: '', collapsed: false }];
			const suggestions = getSuggestions(sessions, groups, 'current');
			expect(suggestions.find((s) => s.kind === 'group')).toBeUndefined();
		});
		it('ranks groups above individual agents on a score tie', () => {
			const sessions = [agent('a', 'Match', { groupId: 'g1' })];
			const groups: Group[] = [{ id: 'g1', name: 'Match', emoji: '', collapsed: false }];
			// Both fuzzy-match 'match' identically; the group must sort first.
			const suggestions = getSuggestions(sessions, groups, 'current', 'match');
			expect(suggestions[0].kind).toBe('group');
		});
		it('fuzzy-filters by name', () => {
			const suggestions = getSuggestions(
				[agent('a', 'Claude'), agent('b', 'Codex')],
				[],
				'current',
				'cla'
			);
			expect(suggestions).toHaveLength(1);
			expect(suggestions[0].displayText).toBe('Claude');
		});
		it('caps results at 15', () => {
			const many = Array.from({ length: 30 }, (_, i) => agent(`a${i}`, `Agent${i}`));
			const suggestions = getSuggestions(many, [], 'current');
			expect(suggestions.length).toBe(15);
		});
		it('returns empty when there is nothing mentionable', () => {
			expect(getSuggestions([agent('self', 'Self')], [], 'self')).toEqual([]);
		});
	});
	/**
	 * The roster the chip overlay, the transcript plugin, and the leading-mention
	 * check all read. It is AGENT-only: a group is not a message target, so a
	 * chipped `@Squad` would promise a dispatch that never happens - and a message
	 * LEADING with one would suppress the local send and be addressed to nobody.
	 */
	describe('buildKnownMentionNameSet', () => {
		const squad: Group[] = [{ id: 'g1', name: 'Squad', emoji: '', collapsed: false }];
		it('carries every mentionable agent name, lowercased', () => {
			const names = buildKnownMentionNameSet(
				[agent('a', 'Alpha'), agent('b', 'Review Bot')],
				[],
				'current'
			);
			expect(names.has('alpha')).toBe(true);
			// Spaces normalize to hyphens, matching the token the picker inserts.
			expect(names.has('review-bot')).toBe(true);
		});
		it('leaves group names out entirely', () => {
			const names = buildKnownMentionNameSet(
				[agent('a', 'Alpha', { groupId: 'g1' }), agent('b', 'Beta', { groupId: 'g1' })],
				squad,
				'current'
			);
			expect(names.has('squad')).toBe(false);
			expect(names.has('alpha')).toBe(true);
		});
		it('still knows an agent that shares its name with a group', () => {
			const names = buildKnownMentionNameSet(
				[agent('ops', 'Squad'), agent('a', 'Alpha', { groupId: 'g1' })],
				squad,
				'current'
			);
			expect(names.has('squad')).toBe(true);
		});
		it('excludes the mentioning agent itself', () => {
			const names = buildKnownMentionNameSet([agent('self', 'Self')], [], 'self');
			expect(names.has('self')).toBe(false);
		});
		/**
		 * The set is cached because building it is O(agents^2) Unicode normalizations
		 * and `remarkMentionChips` asks for it at the top of EVERY markdown transform.
		 * These pin the two ways the cache can be wrong: never hitting (the store
		 * hands out a fresh `sessions` array on every streaming flush, so identity is
		 * not a usable key) and going stale (a renamed, added, or removed agent has to
		 * produce a new set).
		 */
		describe('roster caching', () => {
			it('reuses the set across calls with an equal but non-identical roster', () => {
				const first = buildKnownMentionNameSet([agent('a', 'Alpha')], [], 'current');
				// A fresh array with fresh session objects, exactly like the store
				// rebuilding `sessions` on a streaming flush from an unrelated agent.
				const second = buildKnownMentionNameSet([agent('a', 'Alpha')], [], 'current');
				expect(second).toBe(first);
			});
			it('rebuilds when an agent is renamed', () => {
				const before = buildKnownMentionNameSet([agent('a', 'Alpha')], [], 'current');
				const after = buildKnownMentionNameSet([agent('a', 'Renamed')], [], 'current');
				expect(after).not.toBe(before);
				expect(after.has('renamed')).toBe(true);
				expect(after.has('alpha')).toBe(false);
			});
			it('rebuilds when an agent joins or leaves', () => {
				const one = buildKnownMentionNameSet([agent('a', 'Alpha')], [], 'current');
				const two = buildKnownMentionNameSet(
					[agent('a', 'Alpha'), agent('b', 'Beta')],
					[],
					'current'
				);
				expect(two).not.toBe(one);
				expect(two.has('beta')).toBe(true);
				const back = buildKnownMentionNameSet([agent('a', 'Alpha')], [], 'current');
				expect(back.has('beta')).toBe(false);
			});
			it('keeps a separate entry per mentioning agent', () => {
				// The transcript plugin excludes nobody while a composer excludes its own
				// agent, and both run in the same frame - one shared entry would hand the
				// composer a set containing the agent it belongs to.
				const roster = [agent('a', 'Alpha'), agent('b', 'Beta')];
				const fromA = buildKnownMentionNameSet(roster, [], 'a');
				const fromNobody = buildKnownMentionNameSet(roster, [], undefined);
				expect(fromA.has('alpha')).toBe(false);
				expect(fromNobody.has('alpha')).toBe(true);
				// Both are still cached, keyed apart.
				expect(buildKnownMentionNameSet(roster, [], 'a')).toBe(fromA);
				expect(buildKnownMentionNameSet(roster, [], undefined)).toBe(fromNobody);
			});
			it('rebuilds when two rosters differ only in where a name boundary falls', () => {
				// Fields are NUL-separated so an id/name pair cannot be re-cut into a
				// different pair with the same fingerprint.
				const first = buildKnownMentionNameSet([agent('a', 'b c')], [], 'current');
				const second = buildKnownMentionNameSet([agent('a b', 'c')], [], 'current');
				expect(second).not.toBe(first);
			});
			it('rebuilds when only a group is renamed', () => {
				const roster = [agent('a', 'Alpha', { groupId: 'g1' })];
				const before = buildKnownMentionNameSet(
					roster,
					[{ id: 'g1', name: 'Squad', emoji: '', collapsed: false }],
					'current'
				);
				const after = buildKnownMentionNameSet(
					roster,
					[{ id: 'g1', name: 'Crew', emoji: '', collapsed: false }],
					'current'
				);
				expect(after).not.toBe(before);
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/useAgentRun.test.ts
describe('', () => {
	const run: AgentRun = {
		id: 'run-1',
		createdAt: 100,
		updatedAt: 200,
		provider: 'claude-code',
		status: 'running',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
	};
	const event: AgentRunEvent = {
		id: 'event-1',
		runId: 'run-1',
		timestamp: 300,
		type: 'status',
		message: 'Run started',
	};
	const campaign: Campaign = {
		id: 'campaign-1',
		title: 'Ship parser',
		createdAt: 100,
		updatedAt: 200,
		status: 'running',
		runIds: ['run-1'],
		tasks: [],
	};
	function agentRunApi() {
		return window.maestro.agentRun as unknown as {
			list: ReturnType<typeof vi.fn>;
			show: ReturnType<typeof vi.fn>;
			events: ReturnType<typeof vi.fn>;
			campaigns: {
				list: ReturnType<typeof vi.fn>;
				show: ReturnType<typeof vi.fn>;
			};
		};
	}
	describe('useAgentRun', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			agentRunApi().list.mockResolvedValue({ success: true, runs: [run] });
			agentRunApi().show.mockResolvedValue({ success: true, run });
			agentRunApi().events.mockResolvedValue({ success: true, events: [event] });
			agentRunApi().campaigns.list.mockResolvedValue({ success: true, campaigns: [campaign] });
			agentRunApi().campaigns.show.mockResolvedValue({ success: true, campaign });
		});
		it('loads runs and campaigns on mount', async () => {
			const { result } = s4_renderHook(() => useAgentRun());
			await s4_waitFor(() => expect(result.current.loading).toBe(false));
			expect(result.current.runs).toEqual([run]);
			expect(result.current.campaigns).toEqual([campaign]);
			expect(agentRunApi().list).toHaveBeenCalledWith(undefined);
			expect(agentRunApi().campaigns.list).toHaveBeenCalledWith(undefined);
		});
		it('passes filter options into manual refreshes', async () => {
			const { result } = s4_renderHook(() => useAgentRun({ loadOnMount: false }));
			await s4_act(async () => {
				await result.current.refreshRuns({ status: 'running', campaign: 'campaign-1', limit: 2 });
				await result.current.refreshCampaigns({ status: 'running', limit: 3 });
			});
			expect(agentRunApi().list).toHaveBeenCalledWith({
				status: 'running',
				campaign: 'campaign-1',
				limit: 2,
			});
			expect(agentRunApi().campaigns.list).toHaveBeenCalledWith({ status: 'running', limit: 3 });
			expect(result.current.runs).toEqual([run]);
			expect(result.current.campaigns).toEqual([campaign]);
		});
		it('shows a run and loads its events on demand', async () => {
			const { result } = s4_renderHook(() => useAgentRun({ loadOnMount: false }));
			await s4_act(async () => {
				await result.current.showRun('run-1');
				await result.current.loadRunEvents('run-1');
			});
			expect(agentRunApi().show).toHaveBeenCalledWith('run-1');
			expect(agentRunApi().events).toHaveBeenCalledWith('run-1');
			expect(result.current.selectedRun).toEqual(run);
			expect(result.current.selectedRunEvents).toEqual([event]);
		});
		it('shows one campaign and clears selected state', async () => {
			const { result } = s4_renderHook(() => useAgentRun({ loadOnMount: false }));
			await s4_act(async () => {
				await result.current.showCampaign('campaign-1');
			});
			expect(result.current.selectedCampaign).toEqual(campaign);
			s4_act(() => {
				result.current.clearSelection();
			});
			expect(result.current.selectedRun).toBeNull();
			expect(result.current.selectedRunEvents).toEqual([]);
			expect(result.current.selectedCampaign).toBeNull();
		});
		it('surfaces service errors without replacing current state', async () => {
			const { result } = s4_renderHook(() => useAgentRun({ loadOnMount: false }));
			await s4_act(async () => {
				await result.current.refreshRuns();
			});
			agentRunApi().list.mockResolvedValue({ success: false, error: 'read failed' });
			await s4_act(async () => {
				const runs = await result.current.refreshRuns();
				expect(runs).toEqual([]);
			});
			expect(result.current.runs).toEqual([run]);
			expect(result.current.error).toBe('read failed');
		});
	});
});
