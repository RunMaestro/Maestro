import { describe, expect, it } from 'vitest';
import type { Group } from '../../shared/types';
import {
	canCreateGroupInside,
	canSetGroupParent,
	normalizeGroupHierarchy,
	removeGroupAndPromoteChildren,
	setGroupParent,
} from '../../shared/groupHierarchy';

const group = (id: string, parentGroupId?: string): Group => ({
	id,
	name: id.toUpperCase(),
	emoji: '📁',
	collapsed: false,
	...(parentGroupId ? { parentGroupId } : {}),
});

describe('group hierarchy', () => {
	it('nests a root group below another root group', () => {
		const groups = [group('company'), group('project')];

		expect(setGroupParent(groups, 'project', 'company')).toEqual([
			group('company'),
			group('project', 'company'),
		]);
	});

	it('moves a child group back to the top level', () => {
		const groups = [group('company'), group('project', 'company')];

		expect(setGroupParent(groups, 'project', undefined)).toEqual([
			group('company'),
			group('project'),
		]);
	});

	it('rejects adding a third hierarchy level', () => {
		const groups = [group('company'), group('project', 'company'), group('service')];

		expect(canSetGroupParent(groups, 'service', 'project')).toBe(false);
		expect(setGroupParent(groups, 'service', 'project')).toBe(groups);
	});

	it('rejects nesting a group that already has children', () => {
		const groups = [group('company'), group('project', 'company'), group('portfolio')];

		expect(canSetGroupParent(groups, 'company', 'portfolio')).toBe(false);
		expect(setGroupParent(groups, 'company', 'portfolio')).toBe(groups);
	});

	it('rejects a group becoming its own ancestor', () => {
		const groups = [group('company'), group('project', 'company')];

		expect(canSetGroupParent(groups, 'company', 'project')).toBe(false);
		expect(setGroupParent(groups, 'company', 'project')).toBe(groups);
	});

	it('allows creating a child only inside an existing root group', () => {
		const groups = [group('company'), group('project', 'company')];

		expect(canCreateGroupInside(groups, 'company')).toBe(true);
		expect(canCreateGroupInside(groups, 'project')).toBe(false);
	});

	it('promotes direct children when deleting their parent', () => {
		const groups = [group('company'), group('project', 'company'), group('personal')];

		expect(removeGroupAndPromoteChildren(groups, 'company')).toEqual([
			group('project'),
			group('personal'),
		]);
	});

	it('normalizes invalid persisted parent relationships without changing valid children', () => {
		const groups = [
			group('company'),
			group('project', 'company'),
			group('orphan', 'missing'),
			group('self', 'self'),
			group('grandchild', 'project'),
		];

		expect(normalizeGroupHierarchy(groups)).toEqual([
			group('company'),
			group('project', 'company'),
			group('orphan'),
			group('self'),
			group('grandchild'),
		]);
	});
});
