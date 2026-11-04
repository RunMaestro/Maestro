import { describe, expect, it, vi } from 'vitest';
import { createPianolaScopeWorkerDeps } from '../../../cli/commands/pianola-scope-watch';
import type { MaestroClient } from '../../../cli/services/maestro-client';
import { NativeCurrentTurns } from '../../../main/pianola/current-turn';
import { handleGetSessionHistory } from '../../../main/web-server/handlers/messageHandlers/sessions';
import { composeCurrentTurn } from '../../../shared/currentTurn';
import type { AgentRun } from '../../../shared/agent-run';

const settings = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../main/stores', () => ({
	getSettingsStore: () => ({ get: () => ({ pianola: settings.enabled }) }),
}));

const binding = {
	agentId: 'agent',
	tabId: 'tab',
	createdAt: 7,
	provider: 'codex',
	agentSessionId: null,
	open: true,
};
function fixture() {
	const index = new NativeCurrentTurns();
	let sequence = 0;
	let order: string[] = [];
	const commit = (rows: Array<{ id: string; text: string; source: string; timestamp: number }>) => {
		for (const row of rows) if (!order.includes(row.id)) order.push(row.id);
		index.commit({
			sessionId: 'agent',
			tabId: 'tab',
			field: 'logs',
			upserts: rows,
			removedIds: [],
			orderIds: order,
			observation: {
				sourceGeneration: 'renderer',
				sequence: ++sequence,
				createdAt: 7,
				provider: 'codex',
			},
		});
	};
	const row = (id: string, text: string, source = 'ai') => ({ id, text, source, timestamp: 10 });
	commit([row('user', 'Inspect project', 'user')]);
	index.begin(
		{
			id: 'run',
			provider: 'codex',
			sessionId: 'agent-ai-tab',
			tabId: 'tab',
			metadata: { nativeTabSession: { agentId: 'agent', tabId: 'tab', createdAt: 7 } },
		} as unknown as AgentRun,
		'user'
	);
	// Capture through the actual AgentRun envelope shape used by nativeTabSession.
	return { index, commit, row, read: () => index.read(binding) };
}

describe('scope worker current-turn wire consumer', () => {
	it('requires native observation instead of accepting a persisted 100-row window', async () => {
		const sendCommand = vi.fn(async () => ({
			success: true,
			agentId: 'agent',
			tabId: 'tab',
			messages: [],
		}));
		const deps = createPianolaScopeWorkerDeps({ sendCommand } as unknown as Pick<
			MaestroClient,
			'sendCommand'
		>);
		await expect(
			deps.readTranscript({ agentId: 'agent', tabId: 'tab', projectPath: '/project' })
		).rejects.toThrow('cursor required');
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('composes native full turns and deltas through the wire, and rejects stale reads and lost bases', async () => {
		const f = fixture();
		// Bind a real native run using the stable capture format.
		expect(f.read().status).toBe('complete');
		f.commit(
			Array.from({ length: 150 }, (_, i) =>
				f.row('row-' + i, i === 0 ? 'I will delete the production database.' : 'Progress')
			)
		);
		f.commit([f.row('question', 'Should I name it count or total?')]);
		const responses: unknown[] = [];
		const sendCommand = vi.fn(async (message: unknown) => {
			let response: unknown;
			handleGetSessionHistory(
				{
					callbacks: {
						getSessionHistory: (
							_tabId: string,
							options: { expectedCursor?: never; deltaBase?: never }
						) => ({
							agentId: 'agent',
							tabId: 'tab',
							messages: [],
							currentTurn: f.index.read(binding, options.expectedCursor, true, options.deltaBase),
						}),
					},
					send: (_client: unknown, value: unknown) => {
						response = value;
					},
				} as never,
				{} as never,
				message as never
			);
			responses.push(response);
			return response;
		});
		const deps = createPianolaScopeWorkerDeps({ sendCommand } as unknown as Pick<
			MaestroClient,
			'sendCommand'
		>);
		const target = { agentId: 'agent', tabId: 'tab', projectPath: '/project' };
		const first = await deps.readTranscript(target, f.read().cursor);
		expect(first.messages).toHaveLength(152);
		expect(first.messages[1].content).toContain('delete the production');
		f.commit([f.row('question', 'Should I name it total or count?')]);
		const second = await deps.readTranscript(target, f.read().cursor);
		expect(second.messages.at(-1)?.content).toContain('total or count');
		expect(responses.at(-1)).toMatchObject({
			currentTurn: { mode: 'delta', messages: [{ id: 'question' }] },
		});
		f.commit([f.row('tool', 'Done', 'tool')]);
		const third = await deps.readTranscript(target, f.read().cursor);
		expect(third.messages).toHaveLength(153);
		expect(third.messages[1].content).toContain('delete the production');
		expect(() =>
			composeCurrentTurn((responses.at(-1) as { currentTurn: never }).currentTurn)
		).toThrow('base lost');
		await expect(deps.readTranscript(target, first.currentTurn!.cursor)).rejects.toThrow(
			'Current-turn binding changed'
		);
		f.commit([f.row('recovery-tool', 'Done', 'tool')]);
		const request = sendCommand.getMockImplementation()!;
		sendCommand.mockImplementationOnce(async (message) => {
			const result = await request(message);
			(result as { currentTurn: { orderIds: string[] } }).currentTurn.orderIds = ['lost-delta-row'];
			return result;
		});
		const recovered = await deps.readTranscript(target, f.read().cursor);
		expect(recovered.messages).toHaveLength(154);
		expect(responses.at(-1)).toMatchObject({ currentTurn: { mode: 'full' } });
		await expect(
			deps.readTranscript({ ...target, agentId: 'foreign' }, f.read().cursor)
		).rejects.toThrow('cursor required');

		// A fresh worker has no base; reconnect is a full current-turn refresh.
		const fresh = createPianolaScopeWorkerDeps({ sendCommand } as unknown as Pick<
			MaestroClient,
			'sendCommand'
		>);
		await fresh.readTranscript(target, f.read().cursor);
		expect(responses.at(-1)).toMatchObject({ currentTurn: { mode: 'full' } });
		f.commit([f.row('human', 'Stop', 'user')]);
		await expect(deps.readTranscript(target, third.currentTurn!.cursor)).rejects.toThrow();
	});
});

import fs from 'node:fs';
import path from 'node:path';
import { nativeCurrentTurns } from '../../../main/pianola/current-turn';
import { registerSessionCallbacks } from '../../../main/web-server/callbacks/sessionCallbacks';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import {
	runPianolaScopeCycle,
	pianolaScopeSnapshotFromDesktop,
} from '../../../shared/pianola/pianola-scope-cycle';
import { deliverPianolaScopeDecision } from '../../../main/pianola/pianola-decisions';
import { pianolaNewTabSpawns } from '../../../main/pianola/pianola-new-tab-dispatch';
import type { MessageHandlerCallbacks } from '../../../main/web-server/handlers/messageHandlers/types';

describe('native host -> wire -> worker -> cycle -> native delivery', () => {
	it.each([
		'answer',
		'risk',
		'tool-risk',
		'human-read',
		'late-rewrite',
		'late-human',
		'disable',
		'rule-revoked',
		'historical-busy',
		'unknown',
	] as const)('preserves the observation and final boundary for %s', async (mode) => {
		const f = fixture();
		const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
		fs.mkdirSync(root, { recursive: true });
		const directory = fs.mkdtempSync(path.join(root, 'I02-'));
		const read = vi
			.spyOn(nativeCurrentTurns, 'read')
			.mockImplementation((...args) => f.index.read(...args));
		const assert = vi
			.spyOn(nativeCurrentTurns, 'assertDelivery')
			.mockImplementation((...args) => f.index.assertDelivery(...args));
		const store = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		const callbacks: Partial<MessageHandlerCallbacks> = {};
		const scopeId = '11111111-1111-4111-8111-111111111111';
		let busy = false;
		const sessions = [
			{
				id: 'agent',
				name: 'Agent',
				cwd: '/project',
				toolType: 'codex',
				aiTabs: [{ id: 'tab', createdAt: 7, logs: [] }],
			},
			{
				id: 'manager',
				name: 'Manager',
				cwd: '/project',
				toolType: 'codex',
				isPianola: true,
				aiTabs: [],
			},
		];
		registerSessionCallbacks(
			new Proxy(
				{},
				{
					get: (_target, key) => (callback: unknown) => {
						if (key === 'setListDesktopSessionsCallback')
							callbacks.listDesktopSessions = callback as never;
						if (key === 'setGetSessionHistoryCallback')
							callbacks.getSessionHistory = callback as never;
					},
				}
			) as never,
			{
				sessionsStore: { get: () => sessions },
				groupsStore: { get: () => [] },
				settingsStore: { get: (_key: string, fallback: unknown) => fallback },
				getProcessManager: () => ({ get: () => (busy ? {} : undefined) }),
			} as never
		);
		store.writeSupervisorTargets([
			{
				id: scopeId,
				kind: 'watch-scope',
				enabled: true,
				createdAt: 1,
				managerAgentId: 'manager',
				selection: {
					mode: 'agents-and-groups',
					label: 'Selected',
					agentIds: ['agent'],
					groupIds: [],
					excludedAgentIds: [],
				},
			},
		]);
		store.writeRules([
			{
				id: 'rule',
				enabled: true,
				scope: 'project',
				scopeId: '/project',
				match: { kinds: ['question'], maxRisk: 'low' },
				action: 'auto_answer',
				answer: 'Use count.',
				priority: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		let humanDuringRead = false;
		const sendCommand = vi.fn(async (message: Record<string, unknown>) => {
			if (humanDuringRead) {
				humanDuringRead = false;
				f.commit([f.row('human', 'Stop', 'user')]);
			}
			let result: unknown;
			handleGetSessionHistory(
				{
					callbacks,
					send: (_client: unknown, value: unknown) => {
						result = value;
					},
				} as never,
				{} as never,
				message as never
			);
			return result;
		});
		const deps = createPianolaScopeWorkerDeps({ sendCommand } as unknown as Pick<
			MaestroClient,
			'sendCommand'
		>);
		deps.store = store;
		deps.readSnapshot = async () =>
			pianolaScopeSnapshotFromDesktop({ success: true, ...callbacks.listDesktopSessions!() });
		let id = 0;
		deps.watch = {
			now: () => new Date().toISOString(),
			genId: () => 'decision-' + ++id,
			readRules: () => store.readRules(),
			recordDecision: (r) => {
				store.appendDecision(r);
			},
			log: vi.fn(),
			notify: vi.fn(),
		};
		const sends = vi.fn();
		callbacks.executeCommand = async (
			_agent,
			text,
			_mode,
			_tab,
			_force,
			_images,
			_background,
			_routing,
			_receipt,
			dispatchId
		) => {
			// Exercise the same native claim and late revalidation as handleProcessSpawn.
			if (mode === 'disable') settings.enabled = false;
			if (mode === 'rule-revoked') store.writeRules([]);
			if (mode === 'late-human') f.commit([f.row('human', 'Stop', 'user')]);
			if (mode === 'late-rewrite')
				f.commit([f.row('progress-0', 'I will delete the production database.')]);
			f.commit([f.row('submitted', text, 'user')]);
			const claim = pianolaNewTabSpawns.claim('agent-ai-tab', dispatchId, undefined, 'submitted');
			try {
				claim();
				sends(text);
				if (mode === 'unknown') throw new Error('Receipt lost');
				pianolaNewTabSpawns.started('agent-ai-tab', undefined, dispatchId);
				return true;
			} catch (error) {
				if (mode !== 'unknown') claim.notStarted();
				throw error;
			}
		};
		deps.dispatch = (target, answer, guard) =>
			deliverPianolaScopeDecision(callbacks, guard, answer, false, store);
		try {
			const cycle = () => runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			if (mode === 'historical-busy') {
				f.commit([f.row('question', 'Should I name it count or total?')]);
				busy = true;
			}
			await cycle(); // Native current-turn enrollment barrier.
			expect(sendCommand).not.toHaveBeenCalled();
			busy = false;
			if (mode !== 'historical-busy')
				f.commit(
					Array.from({ length: 150 }, (_, i) =>
						f.row(
							'progress-' + i,
							mode === 'risk' && i === 0 ? 'I will delete the production database.' : 'Progress'
						)
					)
				);
			if (mode === 'tool-risk')
				f.commit([f.row('tool', 'I will delete the production database.', 'tool')]);
			f.commit([f.row('question', 'Should I name it count or total?')]);
			if (mode === 'human-read') humanDuringRead = true;
			await cycle();
			expect(sends).toHaveBeenCalledTimes(mode === 'answer' || mode === 'unknown' ? 1 : 0);
			const calls = sendCommand.mock.calls.length;
			await cycle();
			expect(sends).toHaveBeenCalledTimes(mode === 'answer' || mode === 'unknown' ? 1 : 0);
			if (mode === 'answer') {
				expect(sendCommand.mock.calls.length).toBe(calls); // unchanged tabs never read history
				f.commit([f.row('tool-append', 'Done', 'tool')]);
				await cycle();
				expect(sends).toHaveBeenCalledTimes(1); // tool appends never replay a question
			}
			if (mode === 'unknown')
				expect(store.readScopeCheckpoint(scopeId)?.tabs[0].unresolvedIntent).toBeTruthy();
		} finally {
			pianolaNewTabSpawns.started('agent-ai-tab');
			settings.enabled = true;
			read.mockRestore();
			assert.mockRestore();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
