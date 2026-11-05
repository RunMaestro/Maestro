import * as os from 'os';
import { performance as realPerformance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createPianolaScopeWorkerDeps } from '../../../cli/commands/pianola-scope-watch';
import type { MaestroClient } from '../../../cli/services/maestro-client';
import { NativeCurrentTurns } from '../../../main/pianola/current-turn';
import { handleGetSessionHistory } from '../../../main/web-server/handlers/messageHandlers/sessions';
import { composeCurrentTurn, type CurrentTurnRead } from '../../../shared/currentTurn';
import type { AgentRun } from '../../../shared/agent-run';
import type { SessionTranscriptPatch } from '../../../shared/sessionTranscript';

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
function fixture(provider = 'codex') {
	const index = new NativeCurrentTurns();
	let sequence = 0;
	let order: string[] = [];
	const commit = (
		rows: Array<{ id: string; text: string; source: string; timestamp: number }>,
		rest: Partial<SessionTranscriptPatch> = {}
	) => {
		for (const row of rows) if (!order.includes(row.id)) order.push(row.id);
		if (rest.orderIds) order = [...rest.orderIds];
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
				provider,
			},
			...rest,
		});
	};
	const row = (id: string, text: string, source = 'ai') => ({ id, text, source, timestamp: 10 });
	commit([row('user', 'Inspect project', 'user')]);
	index.begin(
		{
			id: 'run',
			provider,
			sessionId: 'agent-ai-tab',
			tabId: 'tab',
			metadata: { nativeTabSession: { agentId: 'agent', tabId: 'tab', createdAt: 7 } },
		} as unknown as AgentRun,
		'user'
	);
	// Capture through the actual AgentRun envelope shape used by nativeTabSession.
	return {
		index,
		commit,
		row,
		orderIds: () => [...order],
		read: () => index.read({ ...binding, provider }),
	};
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
		'ordered-append',
		'stale-admission',
		'stale-receipt',
		'append-reorder',
		'reorder-restore',
		'after-claim-reorder',
		'risk',
		'tool-risk',
		'human-read',
		'late-rewrite',
		'late-human',
		'disable',
		'rule-revoked',
		'historical-busy',
		'stream-answer',
		'stream-late-rewrite',
		'stream-late-human',
		'stream-unchanged',
		'stream-historical-prefix',
		'stream-historical-inline-prefix',
		'stream-historical-whitespace',
		'stream-historical-metadata',
		'stream-historical-suffix',
		'stream-historical-format',
		'stream-new-question',
		'stream-new-question-restart',
		'stream-historical-restart',
		'stream-historical-earlier',
		'stream-ambiguous-baseline',
		'stream-overflow-baseline',
		'stream-legacy-proof',
		'stream-timestamp',
		'stream-restore',
		'stream-risk',
		'stream-prefix-risk',
		'stream-risk-removed-before-read',
		'stream-tool-risk-removed-before-read',
		'stream-risk-removed-between-reads',
		'stream-risk-removed-restart',
		'stream-risk-missing-proof',
		'stream-risk-removed-quote',
		'stream-risk-removed-new-turn',
		'stream-risk-removed-renderer-boundary',
		'stream-risk-removed-after-classification',
		'stream-handover',
		'stream-resume',
		'stream-renew',
		'stream-snapshot',
		'stream-gap',
		'stream-tool',
		'stream-source',
		'unknown',
	] as const)('preserves the observation and final boundary for %s', async (mode) => {
		const f = fixture();
		const root = os.tmpdir();
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
		const append = store.appendDecision;
		let injected = false;
		const interleave = (record: Parameters<typeof store.appendDecision>[0]) => {
			if (
				!injected &&
				record.lifecycle &&
				((mode === 'stale-admission' && record.deliveryStatus === 'admitted') ||
					(mode === 'stale-receipt' && record.lifecycle.delivery === 'accepted'))
			) {
				injected = true;
				const current = store.readDecisions().find((row) => row.id === record.id)!;
				append({
					...current,
					lifecycle: {
						...current.lifecycle!,
						status: 'done',
						nextActor: 'none',
						nextAction: 'Resolved concurrently',
						source: { kind: 'manager', actorId: 'manager' },
					},
				});
			}
		};
		store.appendDecision = (record) => {
			interleave(record);
			append(record);
		};
		const appendAsync = store.appendDecisionAsync;
		store.appendDecisionAsync = async (record) => {
			interleave(record);
			await appendAsync(record);
		};
		const callbacks: Partial<MessageHandlerCallbacks> = {};
		const scopeId = '11111111-1111-4111-8111-111111111111';
		let busy = false;
		const sessions = [
			{
				id: 'agent',
				name: 'Agent',
				cwd: directory,
				toolType: 'codex',
				aiTabs: [{ id: 'tab', createdAt: 7, logs: [] }],
			},
			{
				id: 'manager',
				name: 'Manager',
				cwd: directory,
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
				scopeId: directory,
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
			if (mode === 'stream-risk-missing-proof')
				delete (result as { currentTurn?: CurrentTurnRead }).currentTurn?.observedRisk;
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
			if (mode === 'stream-risk-removed-after-classification') {
				f.commit([f.row('prefix', 'I will DROP DATABASE production.')]);
				f.commit([f.row('prefix', 'Inspecting files.')]);
			}
			if (mode === 'disable') settings.enabled = false;
			if (mode === 'rule-revoked') store.writeRules([]);
			if (mode === 'late-human' || mode === 'stream-late-human')
				f.commit([f.row('human', 'Stop', 'user')]);
			if (mode === 'late-rewrite')
				f.commit([f.row('progress-0', 'I will delete the production database.')]);
			if (mode === 'stream-late-rewrite') f.commit([f.row('question', 'Delete production?')]);
			const originalOrder = f.orderIds();
			const reordered = [...originalOrder];
			[reordered[reordered.length - 2], reordered[reordered.length - 1]] = [
				reordered.at(-1)!,
				reordered.at(-2)!,
			];
			// Only the new own reply is upserted: all old row objects remain unchanged.
			f.commit([f.row('submitted', text, 'user')], {
				orderIds: [
					...(mode === 'append-reorder' || mode === 'reorder-restore' ? reordered : originalOrder),
					'submitted',
				],
			});
			if (mode === 'reorder-restore') f.commit([], { orderIds: [...originalOrder, 'submitted'] });
			const claim = pianolaNewTabSpawns.claim('agent-ai-tab', dispatchId, undefined, 'submitted');
			try {
				if (mode === 'after-claim-reorder') f.commit([], { orderIds: [...reordered, 'submitted'] });
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
			const streaming = mode.startsWith('stream-');
			if (streaming) {
				if (mode.includes('risk-removed') && mode !== 'stream-risk-removed-after-classification')
					f.commit([
						f.row(
							'prefix',
							mode === 'stream-risk-removed-quote'
								? '> `I will DROP DATABASE production.`'
								: 'I will DROP DATABASE production.',
							mode === 'stream-tool-risk-removed-before-read' ? 'tool' : 'ai'
						),
					]);
				if (mode === 'stream-prefix-risk') f.commit([f.row('prefix', 'Inspecting files.')]);
				let baselineText = [
					'stream-unchanged',
					'stream-historical-prefix',
					'stream-historical-inline-prefix',
					'stream-historical-whitespace',
					'stream-historical-metadata',
					'stream-historical-suffix',
					'stream-historical-format',
					'stream-new-question',
					'stream-new-question-restart',
					'stream-historical-restart',
					'stream-timestamp',
					'stream-restore',
					'stream-tool',
					'stream-source',
				].includes(mode)
					? 'Should I name it count or total?'
					: 'Working.';
				if (mode === 'stream-ambiguous-baseline') baselineText = 'Ready?';
				if (mode === 'stream-overflow-baseline') baselineText = 'Should I run tests? '.repeat(33);
				if (mode === 'stream-historical-earlier')
					baselineText = 'Should I name it count or total? Should I name it amount or sum?';
				f.commit([f.row('question', baselineText)]);
				busy = true;
			}
			if (mode === 'historical-busy') {
				f.commit([f.row('question', 'Should I name it count or total?')]);
				busy = true;
			}
			await cycle(); // Native current-turn enrollment barrier.
			if (streaming) expect(sendCommand).not.toHaveBeenCalled(); // Worker never reads baseline prose.
			expect(sendCommand).not.toHaveBeenCalled();
			busy = false;
			if (mode.endsWith('-restart')) {
				deps.readTranscript = createPianolaScopeWorkerDeps({ sendCommand } as unknown as Pick<
					MaestroClient,
					'sendCommand'
				>).readTranscript;
			}
			if (
				mode === 'stream-risk-removed-new-turn' ||
				mode === 'stream-risk-removed-renderer-boundary'
			) {
				f.commit([f.row('new-user', 'Inspect the next task', 'user')]);
				if (mode === 'stream-risk-removed-new-turn')
					f.index.begin(
						{
							id: 'new-run',
							provider: 'codex',
							sessionId: 'agent-ai-tab',
							tabId: 'tab',
							metadata: { nativeTabSession: { agentId: 'agent', tabId: 'tab', createdAt: 7 } },
						} as unknown as AgentRun,
						'new-user'
					);
			}
			if (mode === 'stream-legacy-proof') {
				const checkpoint = store.readScopeCheckpoint(scopeId)!;
				delete checkpoint.tabs[0].baseline!.questionSignatures;
				store.writeScopeCheckpoint(checkpoint);
			}
			const orderRegression = [
				'ordered-append',
				'append-reorder',
				'reorder-restore',
				'after-claim-reorder',
			].includes(mode);
			if (!streaming && mode !== 'historical-busy' && !orderRegression)
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
			if (!streaming) f.commit([f.row('finished', 'The implementation is finished.')]);
			if (mode === 'stream-resume' || mode === 'stream-handover') {
				const checkpoint = store.readScopeCheckpoint(scopeId)!;
				checkpoint.status = 'suspended';
				if (mode === 'stream-handover') checkpoint.tabs[0].nativeStreamingBaseline = false;
				store.writeScopeCheckpoint(checkpoint);
			}
			if (mode === 'stream-renew') {
				const scopes = store.readSupervisorTargets();
				scopes[0].managerAgentId = 'other-manager';
				store.writeSupervisorTargets(scopes);
			}
			if (mode === 'stream-snapshot') f.commit([], { snapshot: true });
			if (mode === 'stream-gap')
				f.commit([], {
					observation: {
						sourceGeneration: 'renderer',
						sequence: 999,
						createdAt: 7,
						provider: 'codex',
					},
				});
			if (
				mode.includes('risk-removed') &&
				mode !== 'stream-risk-removed-after-classification' &&
				!mode.endsWith('-new-turn') &&
				!mode.endsWith('-renderer-boundary')
			) {
				if (mode === 'stream-risk-removed-between-reads')
					await deps.readTranscript(
						{ agentId: 'agent', tabId: 'tab', projectPath: '/project' },
						f.read().cursor
					);
				f.commit([
					f.row(
						'prefix',
						'Inspecting files.',
						mode === 'stream-tool-risk-removed-before-read' ? 'tool' : 'ai'
					),
				]);
			}
			if (mode === 'stream-prefix-risk')
				f.commit([f.row('prefix', 'I will DROP DATABASE production.')]);
			if (mode === 'stream-restore') f.commit([f.row('question', 'Working again.')]);
			const questionUpdates: Record<string, string> = {
				'stream-historical-inline-prefix': 'Progress complete: Should I name it count or total?',
				'stream-historical-whitespace': '  Should I name it  count\n or total?  ',
				'stream-historical-prefix': 'Progress complete. Should I name it count or total?',
				'stream-historical-restart': 'Progress complete. Should I name it count or total?',
				'stream-historical-suffix': 'Should I name it count or total? Progress complete.',
				'stream-historical-format': '**Should I** name it  count\n or `total`?  ',
				'stream-new-question': 'Should I name it amount or sum?',
				'stream-new-question-restart': 'Should I name it amount or sum?',
				'stream-risk': 'Delete production data. Should I name it count or total?',
			};
			f.commit([
				{
					...f.row(
						mode === 'stream-risk-removed-new-turn' ? 'new-question' : 'question',
						questionUpdates[mode] ?? 'Should I name it count or total?'
					),
					...(mode === 'stream-timestamp' ? { timestamp: 999999 } : {}),
					...(mode === 'stream-source' ? { source: 'stdout' } : {}),
					...(mode === 'stream-historical-metadata'
						? { metadata: { toolUpdate: 'complete' } }
						: {}),
				},
			]);
			if (mode === 'stream-tool') f.commit([f.row('tool-update', 'Completed', 'tool')]);
			if (orderRegression)
				expect(f.read().messages.map((row) => row.id)).toEqual(['user', 'finished', 'question']);
			if (mode === 'human-read') humanDuringRead = true;
			await cycle();
			expect(sends).toHaveBeenCalledTimes(
				mode === 'answer' ||
					mode === 'stream-answer' ||
					mode === 'stream-new-question' ||
					mode === 'stream-new-question-restart' ||
					mode === 'stream-risk-removed-new-turn' ||
					mode === 'ordered-append' ||
					mode === 'unknown' ||
					mode === 'stale-receipt'
					? 1
					: 0
			);
			if (mode === 'stream-late-rewrite' || mode === 'stream-late-human')
				expect(assert.mock.results.at(-1)?.type).toBe('throw');
			if (orderRegression) {
				if (mode === 'ordered-append') expect(assert.mock.results.at(-1)?.value).toBe(true);
				else {
					expect(assert.mock.results.at(-1)?.type).toBe('throw');
					expect(assert.mock.results.at(-1)?.value.message).toBe(
						'Native turn changed during delivery'
					);
				}
			}
			const calls = sendCommand.mock.calls.length;
			await cycle();
			expect(sends).toHaveBeenCalledTimes(
				mode === 'answer' ||
					mode === 'stream-answer' ||
					mode === 'stream-new-question' ||
					mode === 'stream-new-question-restart' ||
					mode === 'stream-risk-removed-new-turn' ||
					mode === 'ordered-append' ||
					mode === 'unknown' ||
					mode === 'stale-receipt'
					? 1
					: 0
			);
			if (mode === 'answer') {
				expect(sendCommand.mock.calls.length).toBe(calls); // unchanged tabs never read history
				f.commit([f.row('tool-append', 'Done', 'tool')]);
				await cycle();
				expect(sends).toHaveBeenCalledTimes(1); // tool appends never replay a question
			}
			if (mode === 'stale-admission' || mode === 'stale-receipt') {
				expect(injected).toBe(true);
				expect(store.readDecisions().at(-1)?.lifecycle?.status).toBe('done');
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

import { MaestroClient as ScopeClient } from '../../../cli/services/maestro-client';
import * as cliStorage from '../../../cli/services/storage';
import * as scopeStore from '../../../cli/services/pianola-store';
import { PianolaScopeWakeups, pianolaWatchScope } from '../../../cli/commands/pianola-scope-watch';
import type { BridgeConnectionOptions } from '../../../shared/maestro-lib/client/bridge-connection';

// Opt-in diagnostics around real worker segments; fake-clock durations are reported separately.
function measureWorkerSegment() {
	if (process.env.PIANOLA_RECORD_MEASUREMENTS !== '1') return () => {};
	const cpu = process.cpuUsage(),
		rss = process.memoryUsage().rss,
		start = realPerformance.now();
	const counts = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
	const read = fs.readFileSync,
		write = fs.writeFileSync;
	const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
		...args: Parameters<typeof read>
	) => {
		const value = Reflect.apply(read, fs, args) as string | Buffer;
		counts.reads++;
		counts.readBytes += Buffer.byteLength(value);
		return value;
	}) as typeof read);
	const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
		...args: Parameters<typeof write>
	) => {
		counts.writes++;
		counts.writeBytes += Buffer.byteLength(args[1] as string);
		return Reflect.apply(write, fs, args);
	}) as typeof write);
	syncBuiltinESMExports();
	return (name: string, work: Record<string, number>) => {
		readSpy.mockRestore();
		writeSpy.mockRestore();
		syncBuiltinESMExports();
		fs.writeFileSync(
			path.join(
				process.env.PIANOLA_MEASUREMENTS_DIR ?? os.tmpdir(),
				`K04-${name}-MEASUREMENTS.json`
			),
			JSON.stringify(
				{
					name,
					...counts,
					work,
					elapsedMs: realPerformance.now() - start,
					cpu: process.cpuUsage(cpu),
					rssBefore: rss,
					rssAfter: process.memoryUsage().rss,
					modelCalls: 0,
					eventLoop: 'not measured in fake-clock segment; see real-time streaming benchmark',
				},
				null,
				2
			)
		);
	};
}

describe('production scope loop event drain', () => {
	it.each(['cursor', 'history'])(
		'uses recovery censuses for an expired manager deadline with unavailable %s',
		async (failure) => {
			vi.useFakeTimers();
			vi.setSystemTime(100000);
			// Isolate deadline scheduling from OS file-event delivery; the store and worker are real.
			vi.spyOn(fs, 'watch').mockReturnValue({ on: vi.fn(), close: vi.fn() } as never);
			const root = os.tmpdir();
			fs.mkdirSync(root, { recursive: true });
			const directory = fs.mkdtempSync(path.join(root, 'K01-deadline-'));
			vi.spyOn(cliStorage, 'getConfigDirectory').mockReturnValue(directory);
			vi.spyOn(cliStorage, 'getSyncDir').mockReturnValue(directory);
			vi.spyOn(cliStorage, 'readSettingValue').mockImplementation(() => ({
				pianola: settings.enabled,
			}));
			const store = createPianolaFsStore({
				resolveDir: () => directory,
				indent: 2,
				trailingNewline: true,
			});
			const scopeId = '11111111-1111-4111-8111-111111111111';
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
			vi.spyOn(scopeStore, 'readPianolaSupervisorTargets').mockImplementation(
				store.readSupervisorTargets
			);
			vi.spyOn(scopeStore, 'readPianolaScopeCheckpoint').mockImplementation(
				store.readScopeCheckpoint
			);
			vi.spyOn(scopeStore, 'writePianolaScopeCheckpoint').mockImplementation(
				store.writeScopeCheckpoint
			);
			vi.spyOn(scopeStore, 'readPianolaDecisions').mockImplementation(store.readDecisions);
			vi.spyOn(scopeStore, 'appendPianolaDecision').mockImplementation(store.appendDecision);
			vi.spyOn(scopeStore, 'readPianolaRules').mockReturnValue([]);
			vi.spyOn(scopeStore, 'getPianolaProfile').mockReturnValue({ entry: undefined } as never);
			vi.spyOn(ScopeClient.prototype, 'connect').mockResolvedValue();
			vi.spyOn(ScopeClient.prototype, 'isOpen', 'get').mockReturnValue(true);
			vi.spyOn(ScopeClient.prototype, 'disconnect').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const f = fixture();
			let unavailable = false;
			let censuses = 0;
			vi.spyOn(ScopeClient.prototype, 'sendCommand').mockImplementation(async (message) => {
				if (message.type === 'list_desktop_sessions') {
					censuses++;
					return {
						success: true,
						supervisionVersion: 1,
						complete: true,
						capturedAt: Date.now(),
						owners: [
							{
								id: 'agent',
								cwd: directory,
								isPianola: false,
								remote: false,
								parentSessionId: null,
							},
						],
						sessions: [
							{
								agentId: 'agent',
								tabId: 'tab',
								createdAt: 7,
								supervision: {
									cwd: directory,
									parentSessionId: null,
									isPianola: false,
									remote: false,
									lineageComplete: true,
									paused: false,
									busy: false,
									consult: false,
									ephemeral: false,
									cursorAvailable: !(unavailable && failure === 'cursor'),
									currentTurn:
										unavailable && failure === 'cursor'
											? { ...f.read(), status: 'unavailable' }
											: f.read(),
								},
							},
						],
					} as never;
				}
				if (message.type === 'get_session_history') {
					if (unavailable && failure === 'history') throw new Error('History unavailable');
					return {
						success: true,
						agentId: 'agent',
						tabId: 'tab',
						currentTurn: f.index.read(
							binding,
							message.expectedCursor as never,
							true,
							message.deltaBase as never
						),
					} as never;
				}
				if (message.type === 'notify_toast') return { success: true } as never;
				throw new Error('Unexpected send: ' + message.type);
			});
			let running: Promise<void> | undefined;
			try {
				await pianolaWatchScope(scopeId, { once: true });
				f.commit([f.row('question', 'Should I name it count or total?')]);
				await pianolaWatchScope(scopeId, { once: true });
				const record = store.readDecisions()[0];
				expect(record.lifecycle?.status).toBe('waiting_human');
				store.appendDecision({
					...record,
					lifecycle: {
						...record.lifecycle!,
						phase: 'judgment',
						delivery: 'accepted',
						status: 'mira_processing',
						deadlineAt: Date.now() - 1,
					},
				});
				unavailable = true;
				censuses = 0;
				const finishMeasurement = measureWorkerSegment();
				running = pianolaWatchScope(scopeId, {});
				await vi.advanceTimersByTimeAsync(0);
				expect(censuses).toBe(1);
				await vi.advanceTimersByTimeAsync(19999);
				expect(censuses).toBe(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(censuses).toBe(2);
				await vi.advanceTimersByTimeAsync(20000);
				expect(censuses).toBe(3);
				finishMeasurement(`expired-${failure}`, { fakeClockMs: 40000, censuses });
				unavailable = false;
				await vi.advanceTimersByTimeAsync(20000);
				expect(store.readDecisions()[0].lifecycle?.status).toBe('waiting_human');
			} finally {
				settings.enabled = false;
				await vi.advanceTimersByTimeAsync(20000);
				await running;
				settings.enabled = true;
				vi.restoreAllMocks();
				syncBuiltinESMExports();
				vi.useRealTimers();
				fs.rmSync(directory, { recursive: true, force: true });
			}
		}
	);

	it('coalesces native commit frames, retains in-cycle signals, recovers idle/disconnect, and stops cleanly', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		vi.spyOn(cliStorage, 'readSettingValue').mockImplementation(() => ({
			pianola: settings.enabled,
		}));
		const root = os.tmpdir();
		fs.mkdirSync(root, { recursive: true });
		const directory = fs.mkdtempSync(path.join(root, 'J02-loop-'));
		vi.spyOn(cliStorage, 'getConfigDirectory').mockReturnValue(directory);
		vi.spyOn(cliStorage, 'getSyncDir').mockReturnValue(directory);
		const store = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		const scopeId = '11111111-1111-4111-8111-111111111111';
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
		vi.spyOn(scopeStore, 'readPianolaSupervisorTargets').mockImplementation(
			store.readSupervisorTargets
		);
		vi.spyOn(scopeStore, 'readPianolaScopeCheckpoint').mockImplementation(
			store.readScopeCheckpoint
		);
		vi.spyOn(scopeStore, 'writePianolaScopeCheckpoint').mockImplementation(
			store.writeScopeCheckpoint
		);
		vi.spyOn(scopeStore, 'readPianolaDecisions').mockImplementation(store.readDecisions);
		vi.spyOn(scopeStore, 'appendPianolaDecision').mockImplementation(store.appendDecision);
		vi.spyOn(scopeStore, 'readPianolaRules').mockReturnValue([]);
		vi.spyOn(scopeStore, 'getPianolaProfile').mockReturnValue({ entry: undefined } as never);
		let bridge: BridgeConnectionOptions;
		vi.spyOn(ScopeClient.prototype, 'connect').mockImplementation(async function () {
			bridge = (this as unknown as { options: BridgeConnectionOptions }).options;
		});
		const open = vi.spyOn(ScopeClient.prototype, 'isOpen', 'get').mockReturnValue(true);
		const disconnect = vi.spyOn(ScopeClient.prototype, 'disconnect').mockImplementation(() => {});
		const f = fixture();
		let censuses = 0;
		let signalDuringRead = false;
		let managerDuringCensus: ReturnType<typeof store.readDecisions>[number] | undefined;
		const send = vi
			.spyOn(ScopeClient.prototype, 'sendCommand')
			.mockImplementation(async (message) => {
				if (message.type === 'list_desktop_sessions') {
					censuses++;
					if (managerDuringCensus) {
						store.appendDecision(managerDuringCensus);
						managerDuringCensus = undefined;
					}
					const turn = f.read();
					return {
						success: true,
						supervisionVersion: 1,
						complete: true,
						capturedAt: Date.now(),
						owners: [
							{
								id: 'agent',
								cwd: directory,
								parentSessionId: null,
								isPianola: false,
								remote: false,
							},
							{
								id: 'unselected',
								cwd: directory,
								parentSessionId: null,
								isPianola: false,
								remote: false,
							},
						],
						sessions: [
							{
								agentId: 'agent',
								tabId: 'tab',
								createdAt: 7,
								supervision: {
									cwd: directory,
									parentSessionId: null,
									isPianola: false,
									remote: false,
									lineageComplete: true,
									paused: false,
									busy: false,
									consult: false,
									ephemeral: false,
									cursorAvailable: true,
									currentTurn: turn,
								},
							},
						],
					} as never;
				}
				if (message.type === 'get_session_history') {
					if (signalDuringRead) {
						signalDuringRead = false;
						bridge!.onFrame!({ type: 'session_state_change' });
					}
					return {
						success: true,
						agentId: 'agent',
						tabId: 'tab',
						currentTurn: f.index.read(
							binding,
							message.expectedCursor as never,
							true,
							message.deltaBase as never
						),
					} as never;
				}
				throw new Error('Unexpected worker command: ' + message.type);
			});
		const listeners = process.listenerCount('SIGTERM');
		const running = pianolaWatchScope(scopeId, { dryRun: true });
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(censuses).toBe(1);
			const finishUnrelatedMeasurement = measureWorkerSegment();
			for (let i = 0; i < 1000; i++)
				bridge!.onFrame!({
					type: 'bridge.event',
					channel: 'sessions:transcriptCommitted',
					args: [{ ...f.read().cursor, agentId: 'unselected' }],
				});
			await vi.advanceTimersByTimeAsync(50);
			expect(censuses).toBe(1);
			finishUnrelatedMeasurement('unrelated-events', { frames: 1000, extraCensuses: censuses - 1 });
			// An unowned sync and provider output are not a native commit wakeup.
			bridge!.onFrame!({ type: 'bridge.event', channel: 'sessions:transcriptSync', args: [{}] });
			await vi.advanceTimersByTimeAsync(5000);
			expect(censuses).toBe(1);
			// A run update before transcript commit is only a dirty hint.
			bridge!.onFrame!({ type: 'bridge.event', channel: 'agentRun:updated' });
			await vi.advanceTimersByTimeAsync(50);
			expect(censuses).toBe(2);
			expect(store.readDecisions()).toHaveLength(0);
			f.commit([f.row('question', 'Should I use count or total?')]);
			signalDuringRead = true;
			for (let i = 0; i < 1000; i++)
				bridge!.onFrame!({
					type: 'bridge.event',
					channel: 'sessions:transcriptCommitted',
					args: [f.read().cursor],
				});
			await vi.advanceTimersByTimeAsync(49);
			expect(censuses).toBe(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(censuses).toBe(3);
			expect(store.readDecisions()).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(50);
			expect(censuses).toBe(4); // signal arriving during transcript await survives
			await vi.advanceTimersByTimeAsync(19999);
			expect(censuses).toBe(4);
			await vi.advanceTimersByTimeAsync(1);
			expect(censuses).toBe(5); // real recovery census, no synthetic timestamp
			open.mockReturnValueOnce(false);
			bridge!.onClose!(1006, 'lost');
			await vi.advanceTimersByTimeAsync(50);
			expect(censuses).toBe(6);
			expect(ScopeClient.prototype.connect).toHaveBeenCalledTimes(2);
			// A manager update to the same decision log wakes the real worker.
			const original = store.readDecisions()[0];
			expect(original).toBeDefined();
			expect(original.lifecycle).toBeDefined();
			const fileEvent = new Promise<void>((resolve) => {
				const observer = fs.watch(directory, (_event, filename) => {
					if (filename?.toString() !== 'pianola-decisions.jsonl') return;
					observer.close();
					resolve();
				});
			});
			managerDuringCensus = {
				...original,
				lifecycle: {
					...original.lifecycle!,
					status: 'done',
					nextActor: 'none',
					nextAction: 'Resolved by manager',
					phase: 'none',
					source: { kind: 'manager', actorId: 'manager' },
				},
			};
			bridge!.onFrame!({ type: 'session_state_change' });
			await vi.advanceTimersByTimeAsync(50);
			await fileEvent;
			await vi.advanceTimersByTimeAsync(50);
			expect(censuses).toBe(8);
			expect(store.readDecisions()[0].lifecycle?.status).toBe('done');
			// A new identity may be a future agent, group member, or worktree child.
			for (const agentId of ['new-future', 'new-group-member', 'new-child']) {
				const previous = censuses;
				bridge!.onFrame!({
					type: 'bridge.event',
					channel: 'sessions:transcriptCommitted',
					args: [{ agentId }],
				});
				await vi.advanceTimersByTimeAsync(50);
				expect(censuses).toBe(previous + 1);
			}
			// A registry edit invalidates the old membership before more hints arrive.
			const target = store.readSupervisorTargets()[0];
			store.writeSupervisorTargets([
				{
					...target,
					selection: {
						...target.selection!,
						mode: 'agents-and-groups',
						agentIds: ['agent', 'unselected'],
						groupIds: [],
						excludedAgentIds: [],
					},
				},
			]);
			bridge!.onFrame!({ type: 'bridge.event', channel: 'settings:externalChange' });
			const previous = censuses;
			bridge!.onFrame!({
				type: 'bridge.event',
				channel: 'sessions:transcriptCommitted',
				args: [{ agentId: 'unselected' }],
			});
			await vi.advanceTimersByTimeAsync(50);
			expect(censuses).toBe(previous + 1);
			bridge!.onFrame!({
				type: 'bridge.event',
				channel: 'sessions:transcriptCommitted',
				args: [{ agentId: 'unselected' }],
			});
			await vi.advanceTimersByTimeAsync(50);
			expect(censuses).toBe(previous + 2);
			settings.enabled = false;
			const settingsEvent = new Promise<void>((resolve) => {
				const observer = fs.watch(directory, (_event, filename) => {
					if (filename?.toString() !== 'maestro-settings.json') return;
					observer.close();
					resolve();
				});
			});
			fs.writeFileSync(path.join(directory, 'maestro-settings.json'), '{}');
			await settingsEvent;
			await vi.advanceTimersByTimeAsync(50);
			await running;
			expect(disconnect).toHaveBeenCalledTimes(1);
			expect(process.listenerCount('SIGTERM')).toBe(listeners);
			expect(vi.getTimerCount()).toBe(0);
			expect(send.mock.calls.some(([m]) => m.type === 'pianola_scope_reply')).toBe(false);
		} finally {
			settings.enabled = false;
			bridge!.onClose?.(1006, 'cleanup');
			await vi.advanceTimersByTimeAsync(20000);
			await running;
			settings.enabled = true;
			vi.restoreAllMocks();
			vi.useRealTimers();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('cancels a waiting drain on stop and bounds a continuous stream by the first signal', async () => {
		vi.useFakeTimers();
		const wakeups = new PianolaScopeWakeups();
		try {
			let woke = false;
			const waiting = wakeups.wait(Date.now() + 20000).then(() => {
				woke = true;
			});
			for (let i = 0; i < 10; i++) {
				wakeups.signal();
				await vi.advanceTimersByTimeAsync(5);
			}
			await waiting;
			expect(woke).toBe(true);
			wakeups.consume();
			const stopped = wakeups.wait(Date.now() + 20000);
			wakeups.dispose();
			await stopped;
			expect(vi.getTimerCount()).toBe(0);
			wakeups.signal();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			wakeups.dispose();
			vi.useRealTimers();
		}
	});

	it('bounds selected busy chunks while deadlines and exit shorten the wait', async () => {
		vi.useFakeTimers();
		const wakeups = new PianolaScopeWakeups();
		try {
			wakeups.setMembership(
				{
					capturedAt: 1,
					complete: true,
					owners: [{ id: 'selected', cwd: '/', isPianola: false, remote: false, groupId: null }],
					tabs: [
						{
							agentId: 'selected',
							tabId: 't',
							busy: true,
							createdAt: 1,
							paused: false,
							consult: false,
							ephemeral: false,
							cursorAvailable: true,
							cursor: null,
						},
					],
				},
				{
					label: 's',
					mode: 'agents-and-groups',
					agentIds: ['selected'],
					groupIds: [],
					excludedAgentIds: [],
				},
				wakeups.generation
			);
			const frame = {
				type: 'bridge.event',
				channel: 'sessions:transcriptCommitted',
				args: [{ agentId: 'selected' }],
			};
			let woke = false;
			const wait = wakeups.wait(Date.now() + 20000).then(() => {
				woke = true;
			});
			for (let i = 0; i < 100; i++) {
				wakeups.onFrame(frame);
				await vi.advanceTimersByTimeAsync(5);
			}
			expect(woke).toBe(false);
			wakeups.onFrame({ type: 'bridge.event', channel: 'process:exit' });
			await vi.advanceTimersByTimeAsync(50);
			await wait;
			expect(woke).toBe(true);
			wakeups.consume();
			woke = false;
			const deadline = wakeups.wait(Date.now() + 25).then(() => {
				woke = true;
			});
			wakeups.onFrame(frame);
			await vi.advanceTimersByTimeAsync(25);
			await deadline;
			expect(woke).toBe(true);
			wakeups.consume();
			woke = false;
			const nativeRequest = wakeups.wait(Date.now() + 20000).then(() => {
				woke = true;
			});
			for (let i = 0; i < 100; i++)
				wakeups.onFrame({ ...frame, args: [{ agentId: 'selected', inputRequest: true }] });
			await vi.advanceTimersByTimeAsync(49);
			expect(woke).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await nativeRequest;
			expect(woke).toBe(true);
		} finally {
			wakeups.dispose();
			vi.useRealTimers();
		}
	});

	it('keeps group, future and descendant identities eligible for a resync', async () => {
		vi.useFakeTimers();
		const wakeups = new PianolaScopeWakeups();
		const owner = (id: string, groupId: string | null, parentSessionId: string | null = null) => ({
			id,
			groupId,
			parentSessionId,
			cwd: path.resolve('.'),
			isPianola: false,
			remote: false,
		});
		const snapshot = {
			capturedAt: 1,
			complete: true,
			tabs: [],
			owners: [
				owner('outside', null),
				owner('selected', null),
				owner('child', null, 'selected'),
				owner('group', 'selected-group'),
				owner('future', null),
			],
		};
		const selection = {
			mode: 'agents-and-groups' as const,
			label: 'Selected',
			agentIds: ['selected'],
			groupIds: ['selected-group'],
			excludedAgentIds: [],
			futureLocalAgents: true,
			futureAgentBaselineIds: ['outside', 'selected', 'child', 'group'],
		};
		try {
			wakeups.setMembership(snapshot, selection, wakeups.generation);
			for (const [id, expected] of [
				['outside', false],
				['selected', true],
				['child', true],
				['group', true],
				['future', true],
				['unknown', true],
			] as const) {
				let woke = false;
				const waiting = wakeups.wait(Date.now() + 1000).then(() => {
					woke = true;
				});
				wakeups.onFrame({
					type: 'bridge.event',
					channel: 'sessions:transcriptCommitted',
					args: [{ agentId: id }],
				});
				await vi.advanceTimersByTimeAsync(50);
				expect(woke, id).toBe(expected);
				if (!expected) await vi.advanceTimersByTimeAsync(950);
				await waiting;
				wakeups.consume();
			}
			const staleGeneration = wakeups.generation;
			wakeups.invalidate();
			wakeups.consume();
			wakeups.setMembership(snapshot, selection, staleGeneration);
			let woke = false;
			const waiting = wakeups.wait(Date.now() + 1000).then(() => {
				woke = true;
			});
			wakeups.onFrame({
				type: 'bridge.event',
				channel: 'sessions:transcriptCommitted',
				args: [{ agentId: 'outside' }],
			});
			await vi.advanceTimersByTimeAsync(50);
			await waiting;
			expect(woke).toBe(true);
		} finally {
			wakeups.dispose();
			vi.useRealTimers();
		}
	});
});

// Equal scheduling windows; real production cycle/store, synthetic census and wire.
describe('equal wall clock recovery and chunk budgets', () => {
	it.each(['idle', 'unselected', 'selected-busy'] as const)(
		'%s: compares 5s polling with event recovery',
		async (scenario) => {
			const root = os.tmpdir();
			fs.mkdirSync(root, { recursive: true });
			const measurements = [];
			for (const mode of ['poll', 'events'] as const) {
				const directory = fs.mkdtempSync(path.join(root, 'l03-window-'));
				const store = createPianolaFsStore({
					resolveDir: () => directory,
					indent: 2,
					trailingNewline: true,
				});
				const wakeups = new PianolaScopeWakeups();
				vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
				vi.setSystemTime(100000);
				const scopeId = '11111111-1111-4111-8111-111111111111';
				const selection = {
					mode: 'agents-and-groups' as const,
					label: 'selected',
					agentIds: ['selected'],
					groupIds: [],
					excludedAgentIds: [],
				};
				store.writeSupervisorTargets([
					{
						id: scopeId,
						kind: 'watch-scope',
						enabled: true,
						createdAt: 1,
						managerAgentId: 'manager',
						selection,
					},
				]);
				const snapshot = {
					capturedAt: Date.now(),
					complete: true,
					owners: ['selected', 'outside'].map((id) => ({
						id,
						cwd: directory,
						isPianola: false,
						remote: false,
						groupId: null,
						parentSessionId: null,
					})),
					tabs: Array.from({ length: 500 }, (_, i) => ({
						agentId: 'selected',
						tabId: `tab-${i}`,
						createdAt: 1,
						paused: false,
						consult: false,
						ephemeral: false,
						busy: scenario === 'selected-busy',
						cursorAvailable: true,
						cursor: null,
					})),
				};
				let cycles = 0,
					wireBytes = 0,
					frames = 0,
					cycleCpu = 0,
					cycleMs = 0,
					hostWireCpu = 0,
					censusWireBytes = 0,
					censusWireCpu = 0;
				const io = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
				const readFile = fs.readFileSync,
					writeFile = fs.writeFileSync;
				const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
					...args: Parameters<typeof readFile>
				) => {
					const value = Reflect.apply(readFile, fs, args) as string | Buffer;
					io.reads++;
					io.readBytes += Buffer.byteLength(value);
					return value;
				}) as typeof readFile);
				const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
					...args: Parameters<typeof writeFile>
				) => {
					io.writes++;
					io.writeBytes += Buffer.byteLength(args[1] as string);
					return Reflect.apply(writeFile, fs, args);
				}) as typeof writeFile);
				syncBuiltinESMExports();
				const deps = {
					store,
					readSnapshot: async () => {
						const cpu = process.cpuUsage();
						const serialized = JSON.stringify(snapshot);
						censusWireBytes += Buffer.byteLength(serialized);
						const response = JSON.parse(serialized);
						const used = process.cpuUsage(cpu);
						censusWireCpu += used.user + used.system;
						return response;
					},
					readTranscript: vi.fn(async () => {
						throw new Error('unchanged/busy transcript must not be read');
					}),
					watch: {
						readRules: () => [],
						recordDecision: store.appendDecision,
						now: () => new Date().toISOString(),
						genId: () => 'unused',
						log: () => {},
						notify: () => {},
					},
					dispatch: vi.fn(),
					requestJudgment: vi.fn(),
				};
				const cycle = async () => {
					snapshot.capturedAt = Date.now();
					const cpu = process.cpuUsage(),
						start = realPerformance.now();
					const result = await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
					const used = process.cpuUsage(cpu);
					cycleCpu += used.user + used.system;
					cycleMs += realPerformance.now() - start;
					expect(result.issues).toEqual([]);
					cycles++;
					wakeups.setMembership(snapshot, selection, wakeups.generation);
				};
				try {
					await cycle(); // enrollment outside observed window
					cycles = 0;
					Object.assign(io, { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 });
					cycleCpu = 0;
					cycleMs = 0;
					censusWireBytes = 0;
					censusWireCpu = 0;
					let due = false;
					let waiting = Promise.resolve();
					const arm = () => {
						due = false;
						waiting = wakeups.wait(Date.now() + (mode === 'poll' ? 5000 : 20000)).then(() => {
							due = true;
						});
					};
					arm();
					for (let elapsed = 50; elapsed <= 60000; elapsed += 50) {
						if (scenario !== 'idle') {
							const cpu = process.cpuUsage();
							for (let i = 0; i < 5; i++) {
								const json = JSON.stringify({
									type: 'bridge.event',
									channel: 'sessions:transcriptCommitted',
									args: [
										{
											agentId: scenario === 'unselected' ? 'outside' : 'selected',
											revision: frames++,
										},
									],
								});
								wireBytes += Buffer.byteLength(json);
								const frame = JSON.parse(json);
								if (mode === 'events') wakeups.onFrame(frame);
							}
							const used = process.cpuUsage(cpu);
							hostWireCpu += used.user + used.system;
						}
						await vi.advanceTimersByTimeAsync(50);
						if (due) {
							await waiting;
							wakeups.consume();
							await cycle();
							arm();
						}
					}
					expect(cycles).toBe(mode === 'poll' || scenario === 'selected-busy' ? 12 : 3);
					expect(deps.readTranscript).not.toHaveBeenCalled();
					expect(deps.dispatch).not.toHaveBeenCalled();
					expect(deps.requestJudgment).not.toHaveBeenCalled();
					measurements.push({
						scenario,
						mode,
						windowMs: 60000,
						io: { ...io },
						cycles,
						frames,
						wireBytes,
						cycleCpuMicros: cycleCpu,
						cycleElapsedMs: cycleMs,
						transportAndHintCpuMicros: hostWireCpu,
						censusWireBytes,
						censusWireCpuMicros: censusWireCpu,
						workerCpuExcludingCensusSerializationMicros: cycleCpu - censusWireCpu,
						decisions: store.readDecisions().length,
						rss: process.memoryUsage().rss,
					});
				} finally {
					readSpy.mockRestore();
					writeSpy.mockRestore();
					syncBuiltinESMExports();
					wakeups.dispose();
					vi.useRealTimers();
					fs.rmSync(directory, { recursive: true, force: true });
				}
			}
			if (process.env.PIANOLA_RECORD_MEASUREMENTS === '1')
				fs.writeFileSync(
					path.join(root, `L03-window-${scenario}.json`),
					JSON.stringify(measurements, null, 2)
				);
		},
		30000
	);
});

describe('active native AskUserQuestion -> wire -> worker -> request response', () => {
	it.each([
		'answer',
		'human',
		'late-human',
		'cancel',
		'late-cancel',
		'risk',
		'risk-rewrite',
		'late-risk',
		'policy',
		'owner',
		'reset',
		'wrong-request',
		'foreign-run',
		'stale-host-generation',
		'stale-question-content',
		'foreign-token',
		'tool-permission',
		'multi-question',
		'multi-select',
		'unsupported-provider',
		'disconnect',
		'feature-off',
		'unknown-receipt',
		'pre-policy',
		'pre-owner',
		'request-risk-header',
	] as const)('consumes only the exact open native question: %s', async (mode) => {
		const { PermissionRelayServer } =
			await import('../../../main/permission-relay/PermissionRelayServer');
		const { registerSpawn, resolvePending, getPendingQuestion } =
			await import('../../../main/permission-relay/registry');
		const net = await import('node:net');
		const provider = mode === 'unsupported-provider' ? 'codex' : 'claude-code';
		const f = fixture(provider);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Q06-'));
		const relay = new PermissionRelayServer();
		const spawn = registerSpawn({ sessionId: 'agent-ai-tab', tabId: 'tab' });
		let socket: import('node:net').Socket | undefined;
		const originalRead = vi
			.spyOn(nativeCurrentTurns, 'read')
			.mockImplementation((...args) => f.index.read(...args));
		const processRead = vi
			.spyOn(nativeCurrentTurns, 'readProcessTurn')
			.mockImplementation((...args) => f.index.readProcessTurn(...args));
		const store = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		const scopeId = '11111111-1111-4111-8111-111111111111';
		const callbacks: Partial<MessageHandlerCallbacks> = {};
		const execute = vi.fn(async () => true);
		callbacks.executeCommand = execute;
		const sessions = [
			{
				id: 'agent',
				name: 'Agent',
				cwd: directory,
				toolType: provider,
				activeTabId: 'tab',
				aiTabs: [{ id: 'tab', createdAt: 7, logs: [] }],
			},
			{
				id: 'manager',
				name: 'Manager',
				cwd: directory,
				toolType: 'codex',
				isPianola: true,
				aiTabs: [],
			},
		];
		registerSessionCallbacks(
			new Proxy(
				{},
				{
					get: (_t, key) => (cb: unknown) => {
						if (key === 'setListDesktopSessionsCallback')
							callbacks.listDesktopSessions = cb as never;
						if (key === 'setGetSessionHistoryCallback') callbacks.getSessionHistory = cb as never;
					},
				}
			) as never,
			{
				sessionsStore: { get: () => sessions },
				groupsStore: { get: () => [] },
				settingsStore: { get: (_k: string, fallback: unknown) => fallback },
				getProcessManager: () => ({
					get: (id: string) => (id === 'agent-ai-tab' ? { sessionId: id } : undefined),
				}),
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
				scopeId: directory,
				match: { kinds: ['question'], maxRisk: 'low' },
				action: 'auto_answer',
				answer: 'Use count.',
				priority: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		let requestId = '';
		let answerResponse: Promise<string> | undefined;
		let mutate = false;
		const replies: Array<{ status: string }> = [];
		relay.setQuestionAuthority(() =>
			JSON.stringify({
				rules: store.readRules(),
				targets: store.readSupervisorTargets(),
				owners: sessions.map((s) => ({ id: s.id, cwd: s.cwd })),
			})
		);
		const sendCommand = vi.fn(async (message: Record<string, unknown>) => {
			if (message.type === 'pianola_scope_reply') {
				if (mode === 'late-human')
					resolvePending(requestId, { behavior: 'deny', message: 'Human selected total.' });
				if (mode === 'policy')
					store.writeRules(store.readRules().map((r) => ({ ...r, updatedAt: 2 })));
				if (mode === 'owner') sessions[0].cwd = directory + '/moved';
				if (mode === 'foreign-run')
					(
						message.guard as { nativeQuestion: { cursor: { runId: string } } }
					).nativeQuestion.cursor.runId = 'foreign-run';
				if (mode === 'stale-host-generation')
					(
						message.guard as { nativeQuestion: { cursor: { generation: string } } }
					).nativeQuestion.cursor.generation = 'old-host';
				if (mode === 'stale-question-content')
					(message.guard as { nativeQuestion: { question: string } }).nativeQuestion.question =
						'Should I use amount?';
				if (mode === 'wrong-request')
					(message.guard as { nativeQuestion: { requestId: string } }).nativeQuestion.requestId =
						'foreign';
				try {
					const response = await deliverPianolaScopeDecision(
						callbacks,
						message.guard,
						message.answer as string,
						false,
						store
					);
					replies.push(response);
					return response;
				} catch {
					const response = { status: 'unknown', error: 'Native refusal or receipt lost' };
					replies.push(response);
					return response;
				}
			}
			let response: unknown;
			handleGetSessionHistory(
				{
					callbacks,
					send: (_c: unknown, v: unknown) => {
						response = v;
					},
				} as never,
				{} as never,
				message as never
			);
			return response;
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
			genId: () => `q06-${++id}`,
			readRules: store.readRules,
			recordDecision: store.appendDecision,
			log: vi.fn(),
			notify: vi.fn(),
		};
		const append = store.appendDecision;
		store.appendDecision = (record) => {
			append(record);
			if (!mutate && record.deliveryStatus === 'admitted') {
				mutate = true;
				if (mode === 'late-cancel') spawn.cleanup();
				if (mode === 'feature-off') settings.enabled = false;
				if (mode === 'late-risk') {
					f.commit([f.row('risk', 'I will DROP DATABASE production.')]);
					f.commit([f.row('risk', 'Inspecting files.')]);
				}
			}
		};
		const appendAsync = store.appendDecisionAsync;
		store.appendDecisionAsync = async (record) => {
			if (mode === 'unknown-receipt' && record.lifecycle?.delivery === 'accepted')
				throw new Error('ENOSPC receipt');
			await appendAsync(record);
		};
		try {
			f.commit([f.row('progress', 'Inspecting files.')]);
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			if (mode === 'risk' || mode === 'risk-rewrite') {
				f.commit([f.row('risk', 'I will DROP DATABASE production.')]);
				if (mode === 'risk-rewrite') f.commit([f.row('risk', 'Inspecting files.')]);
			}
			let committed!: () => void;
			const requestCommitted = new Promise<void>((resolve) => {
				committed = resolve;
			});
			relay.setOnRequest((request) => {
				requestId = request.requestId;
				// Snapshot notification follows actual pending-map commit, not UI parsing.
				if (
					provider === 'claude-code' &&
					!['multi-question', 'multi-select', 'tool-permission'].includes(mode)
				) {
					expect(getPendingQuestion('agent-ai-tab', f.read().cursor)?.requestId).toBe(requestId);
				}
				committed();
			});
			const socketPath = await relay.ensureStarted(directory);
			socket = net.createConnection(socketPath);
			await new Promise<void>((resolve, reject) => {
				socket!.once('connect', resolve);
				socket!.once('error', reject);
			});
			answerResponse = new Promise<string>((resolve) => {
				socket!.once('data', (data) => resolve(data.toString()));
			});
			const question = {
				header: mode === 'request-risk-header' ? 'I will DROP DATABASE production.' : 'Naming',
				question: 'Should I name it count or total?',
				options: [{ label: 'count' }, { label: 'total' }],
				multiSelect: mode === 'multi-select',
			};
			socket.write(
				JSON.stringify({
					type: 'permission-request',
					token: mode === 'foreign-token' ? 'forged' : spawn.token,
					requestId: 'bridge-request',
					toolName: mode === 'tool-permission' ? 'Bash' : 'AskUserQuestion',
					input: { questions: mode === 'multi-question' ? [question, question] : [question] },
				}) + '\n'
			);
			if (mode !== 'foreign-token') await requestCommitted;
			else expect(JSON.parse(await answerResponse).decision.behavior).toBe('deny');
			if (mode === 'pre-policy')
				store.writeRules(store.readRules().map((r) => ({ ...r, updatedAt: 3 })));
			if (mode === 'pre-owner') sessions[0].cwd += '/new-owner';
			if (mode === 'human')
				resolvePending(requestId, { behavior: 'deny', message: 'Human selected total.' });
			if (mode === 'cancel') spawn.cleanup();
			if (mode === 'reset') {
				f.index.setEnabled(false);
				f.index.setEnabled(true);
			}
			if (mode === 'disconnect') {
				socket.destroy();
				await new Promise<void>((resolve) => socket!.once('close', resolve));
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
			}
			const result = await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			if (['late-cancel', 'late-risk', 'feature-off'].includes(mode)) expect(mutate).toBe(true);
			if (
				[
					'late-human',
					'late-cancel',
					'late-risk',
					'policy',
					'owner',
					'wrong-request',
					'feature-off',
				].includes(mode)
			)
				expect(replies).toHaveLength(1);
			expect(execute).not.toHaveBeenCalled();
			const snapshot = callbacks.listDesktopSessions!();
			expect(snapshot && !Array.isArray(snapshot)).toBe(true);
			if (!snapshot || Array.isArray(snapshot)) throw new Error('Versioned snapshot required');
			expect(snapshot.sessions[0].supervision?.busy).toBe(true);
			if (mode === 'answer' || mode === 'unknown-receipt') {
				expect(JSON.parse(await answerResponse)).toMatchObject({
					type: 'permission-response',
					requestId: 'bridge-request',
					decision: { behavior: 'deny', message: 'Use count.' },
				});
				expect(replies).toHaveLength(1);
				const record = store.readDecisions()[0];
				if (mode === 'answer') {
					expect(record).toMatchObject({
						deliveryStatus: 'admitted',
						dispatched: true,
						lifecycle: {
							status: 'done',
							delivery: 'accepted',
							guard: { nativeQuestion: { requestId } },
						},
					});
					expect(result.iterations).toHaveLength(1);
				} else
					expect(record).toMatchObject({
						deliveryStatus: 'admitted',
						lifecycle: { delivery: 'unknown' },
					});
			} else {
				expect(store.readDecisions().some((r) => r.dispatched)).toBe(false);
				if (['risk', 'risk-rewrite', 'request-risk-header'].includes(mode))
					expect(store.readDecisions(), JSON.stringify(result)).toMatchObject([
						{ classification: { risk: 'high' } },
					]);
			}
			if (mode !== 'reset') {
				const restarted = createPianolaScopeWorkerDeps({ sendCommand } as unknown as Pick<
					MaestroClient,
					'sendCommand'
				>);
				Object.assign(restarted, { store, readSnapshot: deps.readSnapshot, watch: deps.watch });
				await runPianolaScopeCycle(scopeId, restarted, { dryRun: false });
			}
			expect(replies.length).toBeLessThanOrEqual(1);
			expect(execute).not.toHaveBeenCalled();
		} finally {
			settings.enabled = true;
			socket?.destroy();
			spawn.cleanup();
			relay.stop();
			originalRead.mockRestore();
			processRead.mockRestore();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
