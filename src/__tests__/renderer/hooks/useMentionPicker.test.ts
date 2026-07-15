import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useMentionPicker,
	buildMentionAccept,
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
}) {
	const { result } = renderHook(() =>
		useMentionPicker({
			filter: params.filter ?? '',
			category: params.category ?? 'all',
			sessions: params.sessions ?? [],
			groups: params.groups,
			currentSessionId: params.currentSessionId ?? 'current',
			fileSuggestions: params.fileSuggestions ?? [],
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

	it('quotes file and directory tokens whose path carries spaces', () => {
		const { items } = pick({
			category: 'all',
			fileSuggestions: [
				fileSug('Meetings/MEET-07-13 - Diagnostics App.md', 'file'),
				fileSug('My Notes', 'folder'),
			],
		});

		const file = items.find((i) => i.kind === 'file');
		const dir = items.find((i) => i.kind === 'directory');
		// Quoted, so the whole path scans back out as ONE mention instead of dying
		// at the first space.
		expect(file?.value).toBe('@"Meetings/MEET-07-13 - Diagnostics App.md" ');
		expect(dir?.value).toBe('@"My Notes/"');
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
});

describe('buildMentionAccept', () => {
	function fileItem(path: string): MentionPickerItem {
		return { kind: 'file', value: `@${path} `, displayText: path, fullPath: path, score: 0 };
	}
	function dirItem(path: string): MentionPickerItem {
		return { kind: 'directory', value: `@${path}/`, displayText: path, fullPath: path, score: 0 };
	}
	function agentItem(name: string): MentionPickerItem {
		return { kind: 'agent', value: `@${name} `, displayText: name, score: 0 };
	}

	it('splices a file token and closes the picker', () => {
		// "look at @te" with the `@` at index 8, filter "te"
		const res = buildMentionAccept('look at @te', 8, 'te', fileItem('test.ts'));
		expect(res.value).toBe('look at @test.ts ');
		expect(res.keepOpen).toBe(false);
		// Caret lands past the token's trailing space so typing continues cleanly.
		expect(res.caretPos).toBe(res.value.length);
		expect(res.value[res.caretPos - 1]).toBe(' ');
	});

	it('splices an agent token (single-at) and closes', () => {
		const res = buildMentionAccept('ping @al', 5, 'al', agentItem('Alpha'));
		expect(res.value).toBe('ping @Alpha ');
		expect(res.keepOpen).toBe(false);
		expect(res.caretPos).toBe(res.value.length);
	});

	it('drills into a directory: keeps open and re-filters inside it', () => {
		const res = buildMentionAccept('@sr', 0, 'sr', dirItem('src'));
		expect(res.value).toBe('@src/');
		expect(res.keepOpen).toBe(true);
		expect(res.nextFilter).toBe('src/');
		// Caret sits just past the `/` so the drill-in filter keeps typing inside it.
		expect(res.caretPos).toBe('@src/'.length);
	});

	it('splices a quoted file token over a quoted filter', () => {
		const quotedFile: MentionPickerItem = {
			kind: 'file',
			value: '@"my notes.md" ',
			displayText: 'my notes.md',
			fullPath: 'my notes.md',
			score: 0,
		};
		const res = buildMentionAccept('see @"my no', 4, '"my no', quotedFile);
		expect(res.value).toBe('see @"my notes.md" ');
		expect(res.caretPos).toBe(res.value.length);
		expect(res.keepOpen).toBe(false);
	});

	it('drills into a quoted directory with the caret parked inside the quotes', () => {
		const quotedDir: MentionPickerItem = {
			kind: 'directory',
			value: '@"My Notes/"',
			displayText: 'My Notes',
			fullPath: 'My Notes',
			score: 0,
		};
		const res = buildMentionAccept('@My', 0, 'My', quotedDir);
		expect(res.value).toBe('@"My Notes/"');
		expect(res.keepOpen).toBe(true);
		// Re-filter keeps the opening quote (it is part of the raw span), and the
		// caret sits BEFORE the closing quote so the next keystrokes land inside it.
		expect(res.nextFilter).toBe('"My Notes/');
		expect(res.caretPos).toBe('@"My Notes/'.length);
	});

	it('swallows the stale closing quote when accepting inside a quoted directory', () => {
		const quotedFile: MentionPickerItem = {
			kind: 'file',
			value: '@"My Notes/todo list.md" ',
			displayText: 'todo list.md',
			fullPath: 'My Notes/todo list.md',
			score: 0,
		};
		// Mid drill-in: caret sits before the directory token's closing quote.
		const res = buildMentionAccept('@"My Notes/to"', 0, '"My Notes/to', quotedFile);
		// The accepted token brings its own closing quote - the stale one is consumed,
		// not doubled.
		expect(res.value).toBe('@"My Notes/todo list.md" ');
		expect(res.caretPos).toBe(res.value.length);
	});

	it('preserves text after the mention when accepting', () => {
		// caret splice replaces only the `@filter` span, keeping the trailing text
		const res = buildMentionAccept('@te done', 0, 'te', fileItem('test.ts'));
		expect(res.value).toBe('@test.ts  done');
		// Caret lands right after the inserted token (not jumped to end of field),
		// so a mid-text mention keeps typing where the user was.
		expect(res.caretPos).toBe('@test.ts '.length);
		expect(res.value.slice(0, res.caretPos)).toBe('@test.ts ');
	});
});
