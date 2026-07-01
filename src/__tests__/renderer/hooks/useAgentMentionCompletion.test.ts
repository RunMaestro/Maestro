import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useAgentMentionCompletion,
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
	it('produces a `@@name ` token for each mentionable agent', () => {
		const suggestions = getSuggestions([agent('a', 'Alpha'), agent('b', 'Beta')], [], 'current');

		expect(suggestions).toHaveLength(2);
		expect(suggestions.every((s) => s.kind === 'agent')).toBe(true);
		expect(suggestions.map((s) => s.value)).toEqual(
			expect.arrayContaining(['@@Alpha ', '@@Beta '])
		);
		// Token carries the double-at prefix and a single trailing space.
		for (const s of suggestions) {
			expect(s.value.startsWith('@@')).toBe(true);
			expect(s.value.endsWith(' ')).toBe(true);
		}
	});

	it('normalizes spaces in agent names to hyphens in the token', () => {
		const suggestions = getSuggestions([agent('a', 'Review Bot')], [], 'current');
		expect(suggestions[0].value).toBe('@@Review-Bot ');
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

	it('surfaces groups with at least one non-terminal member, carrying member ids', () => {
		const sessions = [
			agent('a', 'Alpha', { groupId: 'g1' }),
			agent('b', 'Beta', { groupId: 'g1' }),
		];
		const groups: Group[] = [{ id: 'g1', name: 'Squad', emoji: '', collapsed: false }];
		const suggestions = getSuggestions(sessions, groups, 'current');

		const group = suggestions.find((s) => s.kind === 'group');
		expect(group).toBeDefined();
		expect(group?.value).toBe('@@Squad ');
		expect(group?.groupId).toBe('g1');
		expect(group?.memberSessionIds).toEqual(['a', 'b']);
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
