import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useMentionPicker,
	buildMentionAccept,
	getMentionCategoryCycle,
	MENTION_CATEGORY_CYCLE,
	type MentionCategory,
	type MentionPickerItem,
} from '../../../renderer/hooks/input/useMentionPicker';
import type { AtMentionSuggestion } from '../../../renderer/hooks/input/useAtMentionCompletion';
import type { Session, Group } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

// =============================================================================
// HELPERS
// =============================================================================

function fileSug(path: string, type: 'file' | 'folder', score = 0): AtMentionSuggestion {
	const name = path.split('/').pop() || path;
	return { value: path, type, displayText: name, fullPath: path, score };
}

function agent(id: string, name: string, overrides: Partial<Session> = {}): Session {
	return createMockSession({ id, name, toolType: 'claude-code', ...overrides });
}

function pick(params: {
	filter?: string;
	category?: MentionCategory;
	sessions?: Session[];
	groups?: Group[];
	currentSessionId?: string | null;
	fileSuggestions?: AtMentionSuggestion[];
	crossAgentMentionsEnabled?: boolean;
}) {
	const { result } = renderHook(() =>
		useMentionPicker({
			filter: params.filter ?? '',
			category: params.category ?? 'all',
			sessions: params.sessions ?? [],
			groups: params.groups,
			currentSessionId: params.currentSessionId ?? 'current',
			fileSuggestions: params.fileSuggestions ?? [],
			// Default the Encore flag on so existing coverage exercises the full
			// (ungated) picker; the gating case is covered explicitly below.
			crossAgentMentionsEnabled: params.crossAgentMentionsEnabled ?? true,
		})
	);
	return result.current;
}

// =============================================================================
// TESTS
// =============================================================================

describe('useMentionPicker', () => {
	it('exposes the four-category cycle in the documented order', () => {
		expect(MENTION_CATEGORY_CYCLE).toEqual(['all', 'files', 'directories', 'agents']);
	});

	it('tags file vs directory suggestions with the right token shape', () => {
		const { items } = pick({
			category: 'all',
			fileSuggestions: [fileSug('src/index.ts', 'file'), fileSug('src/lib', 'folder')],
		});

		const file = items.find((i) => i.kind === 'file');
		const dir = items.find((i) => i.kind === 'directory');
		// Files close with a trailing space; directories drill in with a slash.
		expect(file?.value).toBe('@src/index.ts ');
		expect(dir?.value).toBe('@src/lib/');
	});

	it('computes per-category counts independent of the active category', () => {
		const { counts } = pick({
			category: 'files',
			fileSuggestions: [fileSug('a.ts', 'file'), fileSug('b.ts', 'file'), fileSug('dir', 'folder')],
			sessions: [agent('a', 'Alpha')],
		});

		expect(counts.files).toBe(2);
		expect(counts.directories).toBe(1);
		expect(counts.agents).toBe(1);
		expect(counts.all).toBe(4);
	});

	it('narrows items to the active category', () => {
		const base = {
			fileSuggestions: [fileSug('a.ts', 'file'), fileSug('dir', 'folder')],
			sessions: [agent('a', 'Alpha')],
		};

		expect(pick({ ...base, category: 'files' }).items.every((i) => i.kind === 'file')).toBe(true);
		expect(
			pick({ ...base, category: 'directories' }).items.every((i) => i.kind === 'directory')
		).toBe(true);
		expect(pick({ ...base, category: 'agents' }).items.every((i) => i.kind === 'agent')).toBe(true);
	});

	it('surfaces agents + groups together under the agents category', () => {
		const sessions = [agent('a', 'Alpha', { groupId: 'g1' })];
		const groups: Group[] = [{ id: 'g1', name: 'Squad', emoji: '', collapsed: false }];
		const { items } = pick({ category: 'agents', sessions, groups });
		const kinds = new Set(items.map((i) => i.kind));
		expect(kinds.has('agent')).toBe(true);
		expect(kinds.has('group')).toBe(true);
	});

	it("interleaves every kind in the 'all' view", () => {
		const { items } = pick({
			category: 'all',
			fileSuggestions: [fileSug('a.ts', 'file'), fileSug('dir', 'folder')],
			sessions: [agent('a', 'Alpha')],
		});
		const kinds = new Set(items.map((i) => i.kind));
		expect(kinds.has('file')).toBe(true);
		expect(kinds.has('directory')).toBe(true);
		expect(kinds.has('agent')).toBe(true);
	});

	it('suppresses agents/groups entirely when the Encore flag is off', () => {
		const sessions = [agent('a', 'Alpha', { groupId: 'g1' })];
		const groups: Group[] = [{ id: 'g1', name: 'Squad', emoji: '', collapsed: false }];

		const gated = pick({
			category: 'all',
			crossAgentMentionsEnabled: false,
			fileSuggestions: [fileSug('a.ts', 'file'), fileSug('dir', 'folder')],
			sessions,
			groups,
		});

		// No agent/group rows; files/directories still counted.
		expect(gated.items.every((i) => i.kind === 'file' || i.kind === 'directory')).toBe(true);
		expect(gated.counts.agents).toBe(0);
		expect(gated.counts.all).toBe(2);
	});

	it("falls back an 'agents' scope to files/directories when gated off", () => {
		const gated = pick({
			category: 'agents',
			crossAgentMentionsEnabled: false,
			fileSuggestions: [fileSug('a.ts', 'file')],
			sessions: [agent('a', 'Alpha')],
		});
		// The picker never collapses to empty just because the flag is off.
		expect(gated.items.map((i) => i.kind)).toContain('file');
	});
});

describe('getMentionCategoryCycle', () => {
	it('includes agents when the Encore flag is on', () => {
		expect(getMentionCategoryCycle(true)).toEqual(['all', 'files', 'directories', 'agents']);
	});

	it('drops agents when the Encore flag is off', () => {
		expect(getMentionCategoryCycle(false)).toEqual(['all', 'files', 'directories']);
	});
});

describe('buildMentionAccept', () => {
	function fileItem(path: string): MentionPickerItem {
		return { kind: 'file', value: `@${path} `, displayText: path, fullPath: path, score: 0 };
	}
	function dirItem(path: string): MentionPickerItem {
		return { kind: 'directory', value: `@${path}/`, displayText: path, fullPath: path, score: 0 };
	}
	function agentItem(name: string): MentionPickerItem {
		return { kind: 'agent', value: `@@${name} `, displayText: name, score: 0 };
	}

	it('splices a file token and closes the picker', () => {
		// "look at @te" with the `@` at index 8, filter "te"
		const res = buildMentionAccept('look at @te', 8, 'te', fileItem('test.ts'));
		expect(res.value).toBe('look at @test.ts ');
		expect(res.keepOpen).toBe(false);
	});

	it('splices an agent token (double-at) and closes', () => {
		const res = buildMentionAccept('ping @al', 5, 'al', agentItem('Alpha'));
		expect(res.value).toBe('ping @@Alpha ');
		expect(res.keepOpen).toBe(false);
	});

	it('drills into a directory: keeps open and re-filters inside it', () => {
		const res = buildMentionAccept('@sr', 0, 'sr', dirItem('src'));
		expect(res.value).toBe('@src/');
		expect(res.keepOpen).toBe(true);
		expect(res.nextFilter).toBe('src/');
	});

	it('preserves text after the mention when accepting', () => {
		// caret splice replaces only the `@filter` span, keeping the trailing text
		const res = buildMentionAccept('@te done', 0, 'te', fileItem('test.ts'));
		expect(res.value).toBe('@test.ts  done');
	});
});
