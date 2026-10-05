import { describe, expect, it } from 'vitest';

import { baselineOf } from '../../../shared/maestro-lib/agents/fold-builder';
import {
	applyRuntimeAgentRecord,
	sessionFromRecord,
} from '../../../renderer/utils/runtimeAgentRecord';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { Session } from '../../../renderer/types';

const tab = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: null,
	starred: false,
	agentSessionId: null,
	logs: [] as unknown[],
	inputValue: '',
	stagedImages: [] as string[],
	state: 'idle',
	...extra,
});

const local = (extra: Record<string, unknown> = {}): Session =>
	({
		id: 'a1',
		name: 'One',
		toolType: 'claude-code',
		cwd: '/p',
		fullPath: '/p',
		projectRoot: '/p',
		shellCwd: '/p',
		state: 'idle',
		inputMode: 'ai',
		scrollPos: 7,
		executionQueue: [],
		activeTabId: 't1',
		aiTabs: [tab('t1')],
		unifiedTabOrder: [{ type: 'ai', id: 't1' }],
		...extra,
	}) as unknown as Session;

const record = (extra: Record<string, unknown> = {}): AgentRecord =>
	({
		id: 'a1',
		name: 'One',
		toolType: 'claude-code',
		cwd: '/p',
		fullPath: '/p',
		projectRoot: '/p',
		activeTabId: 't1',
		aiTabs: [{ id: 't1', name: null, starred: false, agentSessionId: null }],
		unifiedTabOrder: [{ type: 'ai', id: 't1' }],
		...extra,
	}) as unknown as AgentRecord;

describe('applyRuntimeAgentRecord', () => {
	it('returns the same object when nothing differs, so an echo re-renders nothing', () => {
		const session = local();
		expect(applyRuntimeAgentRecord(session, record())).toBe(session);
	});

	it('takes domain keys and leaves view, workspace, and turn keys alone', () => {
		const session = local({ state: 'busy' });
		const next = applyRuntimeAgentRecord(
			session,
			record({
				name: 'Renamed',
				bookmarked: true,
				state: 'idle',
				inputMode: 'terminal',
				scrollPos: 99,
			})
		);
		expect(next.name).toBe('Renamed');
		expect(next.bookmarked).toBe(true);
		expect(next.state).toBe('busy');
		expect(next.inputMode).toBe('ai');
		expect((next as unknown as Record<string, unknown>).scrollPos).toBe(7);
	});

	it('removes a domain key the record no longer has', () => {
		const next = applyRuntimeAgentRecord(local({ groupId: 'g1', nudgeMessage: 'hi' }), record());
		expect(next).not.toHaveProperty('groupId');
		expect(next).not.toHaveProperty('nudgeMessage');
	});

	it('moves the five path fields together when the working directory changes', () => {
		const next = applyRuntimeAgentRecord(
			local({ fileTree: [{ name: 'x' }] }),
			record({ cwd: '/q', fullPath: '/q', projectRoot: '/q' })
		);
		expect(next).toMatchObject({
			cwd: '/q',
			fullPath: '/q',
			projectRoot: '/q',
			shellCwd: '/q',
			fileTree: [],
		});
	});

	it('runs the provider swap on the local copy so the parked slots follow it', () => {
		const withSession = local({
			aiTabs: [tab('t1', { agentSessionId: 'resume-me' })],
			customModel: 'opus',
		});
		const next = applyRuntimeAgentRecord(
			withSession,
			record({
				toolType: 'codex',
				providerOverrides: { 'claude-code': { customModel: 'opus' } },
				aiTabs: [
					{
						id: 't1',
						name: null,
						starred: false,
						agentSessionId: null,
						providerSessions: { 'claude-code': { agentSessionId: 'resume-me' } },
					},
				],
			})
		);
		expect(next.toolType).toBe('codex');
		expect(next.customModel).toBeUndefined();
		expect(next.aiTabs[0].agentSessionId).toBeNull();
		expect(next.aiTabs[0].providerSessions).toMatchObject({
			'claude-code': { agentSessionId: 'resume-me' },
		});
	});

	it('takes the Auto Run reload keys only when the folder changed', () => {
		const same = applyRuntimeAgentRecord(
			local({ autoRunFolderPath: '/p/pb', autoRunContent: 'draft' }),
			record({ autoRunFolderPath: '/p/pb', autoRunContent: 'stale', autoRunContentVersion: 3 })
		);
		expect(same.autoRunContent).toBe('draft');
		const moved = applyRuntimeAgentRecord(
			local({ autoRunFolderPath: '/p/pb', autoRunContent: 'draft', autoRunSelectedFile: 'old' }),
			record({
				autoRunFolderPath: '/p/other',
				autoRunSelectedFile: 'new',
				autoRunContentVersion: 4,
			})
		);
		expect(moved).toMatchObject({
			autoRunFolderPath: '/p/other',
			autoRunSelectedFile: 'new',
			autoRunContentVersion: 4,
		});
		expect(moved.autoRunContent).toBeUndefined();
	});

	describe('the tab set', () => {
		it('adds a tab the runtime holds that this window lacks, with empty transcript and composer state', () => {
			const next = applyRuntimeAgentRecord(
				local(),
				record({
					aiTabs: [
						{ id: 't1', name: null, starred: false },
						{ id: 't2', name: 'New', starred: true, agentSessionId: null },
					],
					unifiedTabOrder: [
						{ type: 'ai', id: 't1' },
						{ type: 'ai', id: 't2' },
					],
				})
			);
			expect(next.aiTabs.map((t) => t.id)).toEqual(['t1', 't2']);
			expect(next.aiTabs[1]).toMatchObject({
				name: 'New',
				starred: true,
				logs: [],
				inputValue: '',
				stagedImages: [],
			});
			expect(next.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 't1' },
				{ type: 'ai', id: 't2' },
			]);
		});

		it('merges tab domain keys and keeps the tab transcript', () => {
			const withLogs = local({ aiTabs: [tab('t1', { logs: [{ id: 'l' }] })] });
			const next = applyRuntimeAgentRecord(
				withLogs,
				record({ aiTabs: [{ id: 't1', name: 'Named', starred: true }] })
			);
			expect(next.aiTabs[0]).toMatchObject({ name: 'Named', starred: true, logs: [{ id: 'l' }] });
		});

		it('drops a tab the previous record held and the new one lacks, but never a busy one', () => {
			const two = local({
				aiTabs: [tab('t1'), tab('t2'), tab('t3', { state: 'busy' })],
				unifiedTabOrder: [
					{ type: 'ai', id: 't1' },
					{ type: 'ai', id: 't2' },
					{ type: 'ai', id: 't3' },
				],
			});
			const previous = baselineOf(
				record({
					aiTabs: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
					unifiedTabOrder: [
						{ type: 'ai', id: 't1' },
						{ type: 'ai', id: 't2' },
						{ type: 'ai', id: 't3' },
					],
				})
			);
			const next = applyRuntimeAgentRecord(two, record(), previous);
			expect(next.aiTabs.map((t) => t.id)).toEqual(['t1', 't3']);
			expect(next.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 't1' },
				{ type: 'ai', id: 't3' },
			]);
		});

		it('keeps a tab only this window holds (created here, not folded yet) and its place in the order', () => {
			const withNew = local({
				aiTabs: [tab('t1'), tab('fresh')],
				unifiedTabOrder: [
					{ type: 'ai', id: 't1' },
					{ type: 'ai', id: 'fresh' },
				],
			});
			const previous = baselineOf(record());
			const next = applyRuntimeAgentRecord(withNew, record({ name: 'Other' }), previous);
			expect(next.aiTabs.map((t) => t.id)).toEqual(['t1', 'fresh']);
			expect(next.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 't1' },
				{ type: 'ai', id: 'fresh' },
			]);
		});

		it('keeps this window own file, terminal, and browser refs in the order the runtime sets', () => {
			const withFile = local({
				filePreviewTabs: [{ id: 'f1' }],
				unifiedTabOrder: [
					{ type: 'ai', id: 't1' },
					{ type: 'file', id: 'f1' },
				],
			});
			const next = applyRuntimeAgentRecord(withFile, record());
			expect(next.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 't1' },
				{ type: 'file', id: 'f1' },
			]);
		});

		it('re-points the active tab when its tab went away', () => {
			const two = local({
				activeTabId: 't2',
				aiTabs: [tab('t1'), tab('t2')],
				unifiedTabOrder: [
					{ type: 'ai', id: 't1' },
					{ type: 'ai', id: 't2' },
				],
			});
			const previous = baselineOf(record({ aiTabs: [{ id: 't1' }, { id: 't2' }] }));
			const next = applyRuntimeAgentRecord(two, record({ activeTabId: 't1' }), previous);
			expect(next.activeTabId).toBe('t1');
		});
	});
});

describe('sessionFromRecord', () => {
	it('gives every tab an empty transcript and composer, and keeps the record keys', () => {
		const session = sessionFromRecord(record({ bookmarked: true }));
		expect(session).toMatchObject({ id: 'a1', bookmarked: true });
		expect(session.aiTabs[0]).toMatchObject({
			id: 't1',
			logs: [],
			inputValue: '',
			stagedImages: [],
			state: 'idle',
		});
	});

	it('tolerates a record with no tabs', () => {
		expect(sessionFromRecord(record({ aiTabs: undefined })).aiTabs).toEqual([]);
	});
});
