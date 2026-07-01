import { describe, it, expect } from 'vitest';
import { resolveMentionedTargetSessionIds } from '../../../renderer/hooks/input/useAgentMentionCompletion';
import type { Session, Group } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

/**
 * The send-path resolver that turns `@@mention` tokens into target session ids.
 * Shares its agent/group builder with the `@` picker, so a typed mention
 * resolves the same as one chosen from the popover.
 */

function agent(id: string, name: string, overrides: Partial<Session> = {}): Session {
	return createMockSession({ id, name, toolType: 'claude-code', ...overrides });
}

const group = (id: string, name: string): Group => ({ id, name, emoji: '', collapsed: false });

describe('resolveMentionedTargetSessionIds', () => {
	it('returns [] when the message has no mentions', () => {
		expect(resolveMentionedTargetSessionIds('hello world', [agent('a', 'Alpha')], [], 'cur')).toEqual(
			[]
		);
	});

	it('resolves a single @@agent mention to its session id', () => {
		const sessions = [agent('a', 'Alpha'), agent('b', 'Beta')];
		expect(resolveMentionedTargetSessionIds('@@Beta hi', sessions, [], 'a')).toEqual(['b']);
	});

	it('is case-insensitive and matches normalized (hyphenated) names', () => {
		const sessions = [agent('r', 'Review Bot')];
		expect(resolveMentionedTargetSessionIds('@@review-bot take a look', sessions, [], 'cur')).toEqual(
			['r']
		);
	});

	it('excludes the source session (an agent cannot mention itself)', () => {
		const sessions = [agent('self', 'Self'), agent('other', 'Other')];
		expect(resolveMentionedTargetSessionIds('@@Self hey', sessions, [], 'self')).toEqual([]);
	});

	it('expands a @@group mention to its non-terminal member session ids', () => {
		const sessions = [
			agent('a', 'Alpha', { groupId: 'g' }),
			agent('b', 'Beta', { groupId: 'g' }),
			agent('c', 'Gamma'),
		];
		expect(
			resolveMentionedTargetSessionIds('@@Squad go', sessions, [group('g', 'Squad')], 'cur').sort()
		).toEqual(['a', 'b']);
	});

	it('dedupes when an agent and a group containing it are both mentioned', () => {
		const sessions = [agent('a', 'Alpha', { groupId: 'g' }), agent('b', 'Beta', { groupId: 'g' })];
		const ids = resolveMentionedTargetSessionIds(
			'@@Alpha and @@Squad please',
			sessions,
			[group('g', 'Squad')],
			'cur'
		);
		// Alpha resolved first from the direct mention, then Beta from the group;
		// Alpha is not repeated by the group expansion.
		expect(ids).toEqual(['a', 'b']);
	});

	it('resolves multiple distinct agent mentions in message order', () => {
		const sessions = [agent('a', 'Alpha'), agent('b', 'Beta'), agent('c', 'Gamma')];
		expect(resolveMentionedTargetSessionIds('@@Gamma then @@Alpha', sessions, [], 'cur')).toEqual([
			'c',
			'a',
		]);
	});
});
