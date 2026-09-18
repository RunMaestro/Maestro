import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useAgentMentionCompletion,
	buildKnownMentionNameSet,
	type AgentMentionSuggestion,
} from '../../../renderer/hooks/input/useAgentMentionCompletion';
import type { Session, Group } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

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
	const { result } = renderHook(() =>
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
		expect(suggestions.map((s) => s.value)).toEqual(expect.arrayContaining(['@Alpha ', '@Beta ']));
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
