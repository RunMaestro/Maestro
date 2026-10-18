import { describe, it, expect } from 'vitest';
import {
	leftBarAgentOrder,
	orderLeftBarGroups,
	type LeftBarAgentOrderInput,
} from '../../../renderer/utils/leftBarOrder';
import { createMockSession } from '../../helpers/mockSession';
import type { Group, Session } from '../../../renderer/types';

const agent = (id: string, overrides: Partial<Session> = {}) =>
	createMockSession({ id, name: id, groupId: undefined, ...overrides });
const group = (id: string, name: string, overrides: Partial<Group> = {}): Group => ({
	id,
	name,
	emoji: '',
	collapsed: false,
	...overrides,
});

function order(sessions: Session[], groups: Group[], opts: Partial<LeftBarAgentOrderInput> = {}) {
	return leftBarAgentOrder({
		sessions,
		groups,
		nestedGroups: false,
		pianolaEnabled: false,
		showHiddenGroups: false,
		activeSessionId: null,
		...opts,
	}).map((s) => s.id);
}

describe('orderLeftBarGroups', () => {
	const parent = group('p', 'Parent');
	const child = group('c', 'Child', { parentGroupId: 'p' });
	const other = group('o', 'Other');
	const sorted = [child, other, parent];
	const byId = new Map(sorted.map((g) => [g.id, g]));

	it('keeps the alphabetical order when nesting is off', () => {
		expect(orderLeftBarGroups(sorted, byId, false).orderedGroups.map((g) => g.id)).toEqual([
			'c',
			'o',
			'p',
		]);
	});

	it('puts each nested group right after its parent when nesting is on', () => {
		const { orderedGroups, childrenByParentId } = orderLeftBarGroups(sorted, byId, true);
		expect(orderedGroups.map((g) => g.id)).toEqual(['o', 'p', 'c']);
		expect(childrenByParentId.get('p')?.map((g) => g.id)).toEqual(['c']);
	});

	it('draws a child as a root when its parent is known but not drawn', () => {
		expect(orderLeftBarGroups([child, other], byId, true).orderedGroups.map((g) => g.id)).toEqual([
			'c',
			'o',
		]);
	});

	it('draws a child as a root when its parent is not in the map', () => {
		const orphan = group('x', 'Orphan', { parentGroupId: 'gone' });
		expect(
			orderLeftBarGroups([orphan], new Map([[orphan.id, orphan]]), true).orderedGroups
		).toEqual([orphan]);
	});
});

describe('leftBarAgentOrder', () => {
	it('orders groups then agents alphabetically, ignoring leading emojis, with Ungrouped last', () => {
		const sessions = [
			agent('loose'),
			agent('🚀 beta-2', { groupId: 'b' }),
			agent('alpha-1', { groupId: 'a' }),
			agent('beta-1', { groupId: 'b' }),
		];
		expect(order(sessions, [group('b', 'Beta'), group('a', '🐙 Alpha')])).toEqual([
			'alpha-1',
			'beta-1',
			'🚀 beta-2',
			'loose',
		]);
	});

	it('leaves worktree children out', () => {
		const sessions = [agent('main'), agent('main-wt', { parentSessionId: 'main' })];
		expect(order(sessions, [])).toEqual(['main']);
	});

	it('lists a bookmarked agent once, in the Bookmarks position', () => {
		const sessions = [agent('a', { groupId: 'g' }), agent('z', { groupId: 'g', bookmarked: true })];
		expect(order(sessions, [group('g', 'G')])).toEqual(['z', 'a']);
	});

	it('pins Pianola first only while its Encore Feature is on', () => {
		const sessions = [agent('a'), agent('pianola', { isPianola: true })];
		expect(order(sessions, [], { pianolaEnabled: true })).toEqual(['pianola', 'a']);
		expect(order(sessions, [], { pianolaEnabled: false })).toEqual(['a']);
	});

	it('drops hidden groups unless Show Hidden is on or the active agent is in one', () => {
		const sessions = [agent('a'), agent('h', { groupId: 'hid' })];
		const groups = [group('hid', 'Hidden', { hidden: true })];
		expect(order(sessions, groups)).toEqual(['a']);
		expect(order(sessions, groups, { showHiddenGroups: true })).toEqual(['h', 'a']);
		expect(order(sessions, groups, { activeSessionId: 'h' })).toEqual(['h', 'a']);
	});

	it('nests groups when Groups+ is on', () => {
		const sessions = [agent('in-child', { groupId: 'c' }), agent('in-zed', { groupId: 'z' })];
		const groups = [group('z', 'Zed'), group('c', 'Child', { parentGroupId: 'z' })];
		expect(order(sessions, groups)).toEqual(['in-child', 'in-zed']);
		expect(order(sessions, groups, { nestedGroups: true })).toEqual(['in-zed', 'in-child']);
	});

	it('treats an agent whose group no longer exists as ungrouped', () => {
		const sessions = [agent('stray', { groupId: 'deleted' }), agent('a', { groupId: 'g' })];
		expect(order(sessions, [group('g', 'G')])).toEqual(['a', 'stray']);
	});
});
