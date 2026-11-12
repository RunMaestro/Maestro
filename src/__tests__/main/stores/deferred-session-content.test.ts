import { describe, it, expect } from 'vitest';
import {
	mergeDeferredSessionContent,
	projectWebSession,
	readDeferredContent,
} from '../../../main/stores/deferred-session-content';
import type { StoredSession } from '../../../main/stores/types';

function storedAgent(overrides: Partial<StoredSession> = {}): StoredSession {
	return {
		id: 'agent-1',
		name: 'Agent',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
		createdAt: 1000,
		activeTabId: 'tab-a',
		aiTabs: [
			{ id: 'tab-a', logs: [{ id: 'a1', timestamp: 1 }] },
			{ id: 'tab-b', logs: [{ id: 'b1', timestamp: 2 }] },
		],
		snoozedTabs: [{ type: 'ai', tab: { id: 'tab-s', logs: [{ id: 's1', timestamp: 3 }] } }],
		unifiedTabOrder: [
			{ type: 'ai', id: 'tab-a' },
			{ type: 'ai', id: 'tab-b' },
		],
		aiLogs: [{ id: 'legacy-1' }],
		shellLogs: [{ id: 'sh1' }],
		agentCommands: [{ command: '/ship' }],
		aiCommandHistory: ['one'],
		...overrides,
	};
}

describe('projectWebSession', () => {
	it('strips every transcript and marks what was left behind, including snoozed tabs', () => {
		const projected = projectWebSession(storedAgent());
		expect(projected.aiTabs.map((t: { logs: unknown[] }) => t.logs)).toEqual([[], []]);
		expect(projected.snoozedTabs[0].tab.logs).toEqual([]);
		expect(projected.aiLogs).toEqual([]);
		expect(projected.shellLogs).toEqual([]);
		expect(projected.agentCommands).toBeUndefined();
		expect(projected.aiCommandHistory).toBeUndefined();
		expect(projected.deferredContent).toEqual({
			tabIds: ['tab-a', 'tab-b', 'tab-s'],
			commands: true,
		});
	});

	it('derives createdAt for a legacy agent from the oldest log it is about to drop', () => {
		const projected = projectWebSession(storedAgent({ createdAt: undefined }));
		expect(projected.createdAt).toBe(1);
	});
});

describe('readDeferredContent', () => {
	it('returns a snoozed tab transcript and the command content', () => {
		expect(readDeferredContent(storedAgent(), 'agent-1', 'tab-s', true)).toEqual({
			logs: [{ id: 's1', timestamp: 3 }],
			shellLogs: [{ id: 'sh1' }],
			agentCommands: [{ command: '/ship' }],
			aiCommandHistory: ['one'],
		});
	});

	it('throws for a missing agent or tab rather than answering empty', () => {
		expect(() => readDeferredContent(undefined, 'gone', null, true)).toThrow(/no longer exists/);
		expect(() => readDeferredContent(storedAgent(), 'agent-1', 'gone', false)).toThrow(
			/no longer exists/
		);
	});
});

describe('mergeDeferredSessionContent', () => {
	it('passes an unmarked record through untouched', () => {
		const incoming = storedAgent();
		expect(mergeDeferredSessionContent(incoming, undefined)).toBe(incoming);
	});

	it('restores unloaded transcripts and folds in entries the browser appended', () => {
		const stored = storedAgent();
		const incoming = {
			...projectWebSession(stored),
			name: 'Renamed',
			aiTabs: [
				{ id: 'tab-a', logs: [{ id: 'a2', timestamp: 9 }] },
				{ id: 'tab-b', logs: [] },
			],
		};
		const merged = mergeDeferredSessionContent(incoming, stored);
		expect(merged.name).toBe('Renamed');
		expect(merged.aiTabs[0].logs.map((l: { id: string }) => l.id)).toEqual(['a1', 'a2']);
		expect(merged.aiTabs[1].logs.map((l: { id: string }) => l.id)).toEqual(['b1']);
		expect(merged.snoozedTabs[0].tab.logs.map((l: { id: string }) => l.id)).toEqual(['s1']);
		expect(merged.aiLogs).toEqual([{ id: 'legacy-1' }]);
		expect(merged.shellLogs).toEqual([{ id: 'sh1' }]);
		expect(merged.agentCommands).toEqual([{ command: '/ship' }]);
		expect(merged.aiCommandHistory).toEqual(['one']);
		expect(merged.deferredContent).toBeUndefined();
	});

	it('drops a deferred tab another client closed instead of resurrecting it', () => {
		const stored = storedAgent({
			aiTabs: [{ id: 'tab-a', logs: [{ id: 'a1' }] }],
			unifiedTabOrder: [{ type: 'ai', id: 'tab-a' }],
			activeTabId: 'tab-a',
		});
		const incoming = { ...projectWebSession(storedAgent()), activeTabId: 'tab-b' };
		const merged = mergeDeferredSessionContent(incoming, stored);
		expect(merged.aiTabs.map((t: { id: string }) => t.id)).toEqual(['tab-a']);
		expect(merged.unifiedTabOrder).toEqual([{ type: 'ai', id: 'tab-a' }]);
		expect(merged.activeTabId).toBe('tab-a');
	});

	it('refuses a marked record with no stored counterpart', () => {
		expect(() => mergeDeferredSessionContent(projectWebSession(storedAgent()), undefined)).toThrow(
			/invalid deferred content/
		);
	});
});
