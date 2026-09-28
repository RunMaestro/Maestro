import { describe, it, expect } from 'vitest';
import { resolveMentionedTargetSessionIds } from '../../../renderer/hooks/input/useAgentMentionCompletion';
import type { Session, Group } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

/**
 * The send-path resolver that turns `@mention` tokens into target session ids.
 * Shares its agent/group builder with the `@` picker, so a typed mention
 * resolves the same as one chosen from the popover.
 */

function agent(id: string, name: string, overrides: Partial<Session> = {}): Session {
	return createMockSession({ id, name, toolType: 'claude-code', ...overrides });
}

const group = (id: string, name: string): Group => ({ id, name, emoji: '', collapsed: false });

describe('resolveMentionedTargetSessionIds', () => {
	it('returns [] when the message has no mentions', () => {
		expect(
			resolveMentionedTargetSessionIds('hello world', [agent('a', 'Alpha')], [], 'cur')
		).toEqual([]);
	});

	it('resolves a single @agent mention to its session id', () => {
		const sessions = [agent('a', 'Alpha'), agent('b', 'Beta')];
		expect(resolveMentionedTargetSessionIds('@Beta hi', sessions, [], 'a')).toEqual(['b']);
	});

	it('is case-insensitive and matches normalized (hyphenated) names', () => {
		const sessions = [agent('r', 'Review Bot')];
		expect(
			resolveMentionedTargetSessionIds('@review-bot take a look', sessions, [], 'cur')
		).toEqual(['r']);
	});

	it('resolves an emoji-named agent (the @☁-Substrate regression)', () => {
		const sessions = [agent('sub', '☁ Substrate'), agent('other', 'Other')];
		expect(
			resolveMentionedTargetSessionIds(
				"@☁-Substrate what's the last thing you did?",
				sessions,
				[],
				'cur'
			)
		).toEqual(['sub']);
	});

	it('resolves accented and CJK agent names', () => {
		const sessions = [agent('c', 'Café Bot'), agent('j', '日本語 Agent')];
		expect(
			resolveMentionedTargetSessionIds('@café-Bot and @日本語-agent', sessions, [], 'cur')
		).toEqual(['c', 'j']);
	});

	it('excludes the source session (an agent cannot mention itself)', () => {
		const sessions = [agent('self', 'Self'), agent('other', 'Other')];
		expect(resolveMentionedTargetSessionIds('@Self hey', sessions, [], 'self')).toEqual([]);
	});

	// Groups are shorthand the picker expands into member `@name` tokens at accept
	// time, never a message target. A group token that reaches dispatch was typed
	// by hand and resolves to nothing.
	it('does not dispatch a @group mention to its members', () => {
		const sessions = [
			agent('a', 'Alpha', { groupId: 'g' }),
			agent('b', 'Beta', { groupId: 'g' }),
			agent('c', 'Gamma'),
		];
		expect(
			resolveMentionedTargetSessionIds('@Squad go', sessions, [group('g', 'Squad')], 'cur')
		).toEqual([]);
	});

	it('routes the expanded member tokens a picked group inserts', () => {
		// What the composer actually carries after picking the Squad row.
		const sessions = [agent('a', 'Alpha', { groupId: 'g' }), agent('b', 'Beta', { groupId: 'g' })];
		expect(
			resolveMentionedTargetSessionIds(
				'@Alpha @Beta please',
				sessions,
				[group('g', 'Squad')],
				'cur'
			)
		).toEqual(['a', 'b']);
	});

	it('sends to the AGENT when a group shares its name, never to the group', () => {
		// The reported bug: groups are built first, so a group used to win a name it
		// shared with an agent - the user picked the agent they could see and the
		// message fanned out to every member of the like-named group.
		const sessions = [
			agent('ops', 'Ops'),
			agent('a', 'Alpha', { groupId: 'g' }),
			agent('b', 'Beta', { groupId: 'g' }),
		];
		expect(
			resolveMentionedTargetSessionIds('@Ops ping', sessions, [group('g', 'Ops')], 'cur')
		).toEqual(['ops']);
	});

	it('resolves multiple distinct agent mentions in message order', () => {
		const sessions = [agent('a', 'Alpha'), agent('b', 'Beta'), agent('c', 'Gamma')];
		expect(resolveMentionedTargetSessionIds('@Gamma then @Alpha', sessions, [], 'cur')).toEqual([
			'c',
			'a',
		]);
	});

	it('resolves an agent whose name contains a dot (the @RunMaestro.ai regression)', () => {
		const sessions = [agent('rm', 'RunMaestro.ai'), agent('other', 'Other')];
		expect(resolveMentionedTargetSessionIds('@RunMaestro.ai status?', sessions, [], 'cur')).toEqual(
			['rm']
		);
	});

	it('routes all three when a dotted agent name is mentioned alongside two others', () => {
		// The exact reported case: `@RunMaestro.ai` used to drop because the dot
		// classified it as a file, so only 2 of the 3 agents responded.
		const sessions = [
			agent('mm', 'Maestro-Marketing'),
			agent('rm', 'RunMaestro.ai'),
			agent('pp', 'PedTome-Pedsidian'),
		];
		expect(
			resolveMentionedTargetSessionIds(
				'where are we at? @Maestro-Marketing @RunMaestro.ai @PedTome-Pedsidian',
				sessions,
				[],
				'cur'
			)
		).toEqual(['mm', 'rm', 'pp']);
	});
});
