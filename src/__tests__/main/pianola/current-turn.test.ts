import { describe, expect, it, vi } from 'vitest';
import { NativeCurrentTurns } from '../../../main/pianola/current-turn';
import { AgentRunCaptureService } from '../../../main/agent-run/capture-service';
import type { AgentRun } from '../../../shared/agent-run';
import { composeCurrentTurn, type CurrentTurnMessage } from '../../../shared/currentTurn';
import type { SessionTranscriptPatch } from '../../../shared/sessionTranscript';

const binding = {
	agentId: 'agent',
	tabId: 'tab',
	createdAt: 7,
	provider: 'codex',
	agentSessionId: null,
	open: true,
};
const row = (id: string, text = id, source = 'ai'): CurrentTurnMessage => ({
	id,
	text,
	source,
	timestamp: 10,
});
function fixture(index = new NativeCurrentTurns()) {
	let sequence = 0;
	let order: string[] = [];
	const runs = new Map<string, AgentRun>();
	const capture = new AgentRunCaptureService({
		getAgentRun: (id) => runs.get(id),
		upsertAgentRun: (run) => {
			runs.set(run.id, run);
			return run;
		},
		appendAgentRunEvent: (event) => event,
		findActiveRunBySession: (id) =>
			[...runs.values()].find((run) => run.sessionId === id && run.status === 'running'),
	});
	const commit = (rows: CurrentTurnMessage[], rest: Partial<SessionTranscriptPatch> = {}) => {
		for (const row of rows) if (!order.includes(row.id)) order.push(row.id);
		const patch = {
			sessionId: 'agent',
			tabId: 'tab',
			field: 'logs' as const,
			upserts: rows,
			removedIds: [],
			orderIds: order,
			observation: {
				sourceGeneration: 'renderer',
				sequence: ++sequence,
				createdAt: 7,
				provider: 'codex',
			},
			...rest,
		};
		index.commit(patch);
	};
	const begin = (boundaryId?: string) => {
		const run = capture.captureSpawn({
			sessionId: 'agent-ai-tab',
			toolType: 'codex',
			cwd: '/fixture',
			transcriptBoundaryId: boundaryId,
			nativeTabSession: { agentId: 'agent', tabId: 'tab', createdAt: 7 },
		})!;
		index.begin(run, boundaryId);
		return run;
	};
	commit([row('user', 'Inspect the project', 'user')], { snapshot: true });
	return { index, commit, begin, capture, read: () => index.read(binding) };
}

describe('native current-turn revision and completeness', () => {
	it('admits an owner-created empty enrollment without fabricating a turn', () => {
		const index = new NativeCurrentTurns();
		const patch: SessionTranscriptPatch = {
			sessionId: 'agent',
			tabId: 'tab',
			field: 'logs',
			snapshot: true,
			upserts: [],
			removedIds: [],
			orderIds: [],
			runtime: { state: 'idle' },
			observation: {
				sourceGeneration: 'creator',
				sequence: 1,
				createdAt: 7,
				provider: 'codex',
				emptyCreation: true,
			},
		};
		index.commit(patch);
		const empty = index.read(binding);
		expect(empty).toMatchObject({
			status: 'empty-enrollment',
			entryCount: 0,
			cursor: { runId: null, turnId: null },
			enrollment: { sourceGeneration: 'creator' },
		});
		expect(() => composeCurrentTurn(empty)).toThrow('Incomplete');
		// A later replacement, even another empty snapshot, cannot restore creation proof.
		index.commit({ ...patch, observation: { ...patch.observation!, sequence: 2 } });
		expect(index.read(binding)).toMatchObject({ status: 'incomplete', reason: 'transcript-reset' });
		expect(index.read(binding).enrollment).toBeUndefined();
	});

	it('keeps creation enrollment across the first native provider announcement but never a replacement', () => {
		const index = new NativeCurrentTurns();
		const patch: SessionTranscriptPatch = {
			sessionId: 'agent',
			tabId: 'tab',
			field: 'logs',
			snapshot: true,
			upserts: [],
			removedIds: [],
			orderIds: [],
			runtime: { state: 'idle' },
			observation: {
				sourceGeneration: 'creator',
				sequence: 1,
				createdAt: 7,
				provider: 'codex',
				emptyCreation: true,
			},
		};
		index.commit(patch);
		const enrollment = index.read(binding).enrollment;
		index.announce('agent-ai-tab', 'first-native-session');
		expect(index.read(binding)).toMatchObject({ status: 'incomplete', enrollment });
		index.commit({
			...patch,
			snapshot: false,
			runtime: { agentSessionId: 'first-native-session' },
			observation: { ...patch.observation!, sequence: 2 },
		});
		expect(index.read({ ...binding, agentSessionId: 'first-native-session' }).enrollment).toEqual(
			enrollment
		);
		index.announce('agent-ai-tab', 'replacement');
		expect(index.read(binding).status).toBe('reset');
		expect(index.read(binding).enrollment).toBeUndefined();
	});

	it.each(['evicted', 'disabled', 'overflow'])(
		'discards empty enrollment after %s instead of reconstructing it',
		(mode) => {
			const index = new NativeCurrentTurns({ tabs: 1, messages: 1, bytes: 100, totalBytes: 1000 });
			const patch: SessionTranscriptPatch = {
				sessionId: 'agent',
				tabId: 'tab',
				field: 'logs',
				snapshot: true,
				upserts: [],
				removedIds: [],
				orderIds: [],
				runtime: { state: 'idle' },
				observation: {
					sourceGeneration: 'creator',
					sequence: 1,
					createdAt: 7,
					provider: 'codex',
					emptyCreation: true,
				},
			};
			index.commit(patch);
			expect(index.read(binding).status).toBe('empty-enrollment');
			if (mode === 'disabled') {
				index.setEnabled(false);
				index.setEnabled(true);
			}
			if (mode === 'evicted') index.commit({ ...patch, tabId: 'other' });
			index.commit({
				...patch,
				snapshot: false,
				upserts: mode === 'overflow' ? [row('huge', 'x'.repeat(101))] : [],
				orderIds: mode === 'overflow' ? ['huge'] : [],
				observation: { ...patch.observation!, sequence: 2 },
			});
			expect(index.read(binding).status).not.toBe('empty-enrollment');
			expect(index.read(binding).enrollment).toBeUndefined();
		}
	);

	it.each(['unknown', 'historical', 'gap', 'busy', 'provider', 'closed', 'restart', 'trim'])(
		'does not infer empty enrollment from %s',
		(mode) => {
			const index = new NativeCurrentTurns();
			const patch: SessionTranscriptPatch = {
				sessionId: 'agent',
				tabId: 'tab',
				field: 'logs',
				snapshot: true,
				upserts: [],
				removedIds: [],
				orderIds: [],
				runtime: { state: 'idle' },
				observation: {
					sourceGeneration: 'creator',
					sequence: 1,
					createdAt: 7,
					provider: 'codex',
					emptyCreation: true,
				},
			};
			if (mode === 'unknown') delete patch.observation!.emptyCreation;
			if (mode === 'historical') {
				patch.upserts = [row('old')];
				patch.orderIds = ['old'];
			}
			if (mode === 'gap') patch.observation!.sequence = 2;
			if (mode === 'busy') patch.runtime = { state: 'busy' };
			if (mode === 'provider') patch.runtime = { state: 'idle', agentSessionId: 'old' };
			if (mode === 'closed') patch.observation!.closed = true;
			if (mode === 'trim') patch.removedIds = ['removed'];
			if (mode === 'restart') {
				index.commit({ ...patch, observation: { ...patch.observation!, emptyCreation: false } });
				patch.observation!.sourceGeneration = 'restarted';
			}
			index.commit(patch);
			expect(index.read(binding).status).not.toBe('empty-enrollment');
			expect(index.read(binding).enrollment).toBeUndefined();
		}
	);

	it('retains all 2000 entries and native tool inputs across terminal capture', async () => {
		const f = fixture();
		const run = f.begin('user');
		f.commit([row('risk', 'I will delete the production database.')]);
		f.commit([
			{
				...row('tool', 'Shell', 'tool'),
				metadata: { toolState: { input: { command: 'rm -rf /data' } } },
			},
		]);
		f.commit(Array.from({ length: 2000 }, (_, i) => row(`stream-${i}`, 'Progress')));
		f.commit([row('question', 'Should I call it count or total?')]);
		await f.capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 0 });
		const result = f.read();
		expect(result.status).toBe('complete');
		expect(result.cursor).toMatchObject({ runId: run.id, turnId: 'user' });
		expect(result.messages).toHaveLength(2004);
		expect(result.messages[1].text).toContain('delete the production');
		expect(result.messages[2].metadata).toMatchObject({
			toolState: { input: { command: 'rm -rf /data' } },
		});
		result.messages[2].metadata!.toolState = 'mutation';
		expect(f.read().messages[2].metadata).not.toHaveProperty('toolState', 'mutation');
	});

	it('revises same-length rewrites, chunk growth and runtime changes; fences stale expected cursors', () => {
		const f = fixture();
		f.begin('user');
		f.commit([row('answer', 'safe')]);
		const first = f.read().cursor;
		f.commit([row('answer', 'risk')]);
		expect(f.read().cursor.revision).toBeGreaterThan(first.revision);
		expect(f.index.read(binding, first)).toMatchObject({ status: 'gap', messages: [] });
		f.commit([row('answer', 'risk expanded')]);
		const second = f.read().cursor;
		f.commit([], { runtime: { state: 'idle' } });
		expect(f.read().cursor.revision).toBeGreaterThan(second.revision);
		expect(f.index.read(binding, f.read().cursor).messages.at(-1)?.text).toBe('risk expanded');
	});

	it.each(['missing', 'wrong', 'reused'] as const)('does not invent a boundary: %s', (mode) => {
		const f = fixture();
		if (mode === 'reused') f.begin('user');
		f.begin(mode === 'missing' ? undefined : mode === 'wrong' ? 'old' : 'user');
		f.commit([row('question', 'Which name?')]);
		expect(f.read()).toMatchObject({
			status: 'incomplete',
			reason: 'missing-native-boundary',
			messages: [],
		});
	});

	it.each([
		'trim',
		'reset',
		'missing-order',
		'gap',
		'renderer-reset',
		'snooze',
		'provider',
	] as const)('fails closed after %s', (mode) => {
		const f = fixture();
		f.begin('user');
		f.commit([row('risk', 'Delete production')]);
		const before = f.read().cursor;
		if (mode === 'trim') f.commit([], { removedIds: ['risk'], orderIds: ['user'] });
		if (mode === 'reset')
			f.commit([row('user', 'Inspect', 'user')], { snapshot: true, orderIds: ['user'] });
		if (mode === 'missing-order') f.commit([], { orderIds: ['user'] });
		if (mode === 'gap')
			f.commit([], {
				observation: {
					sourceGeneration: 'renderer',
					sequence: 55,
					createdAt: 7,
					provider: 'codex',
				},
			});
		if (mode === 'renderer-reset')
			f.commit([], {
				observation: {
					sourceGeneration: 'replacement',
					sequence: 1,
					createdAt: 7,
					provider: 'codex',
				},
			});
		if (mode === 'snooze')
			f.commit([], {
				observation: {
					sourceGeneration: 'renderer',
					sequence: 3,
					createdAt: 7,
					provider: 'codex',
					closed: true,
				},
			});
		if (mode === 'provider')
			f.commit([], {
				observation: {
					sourceGeneration: 'renderer',
					sequence: 3,
					createdAt: 7,
					provider: 'claude-code',
				},
			});
		expect(f.read().status).not.toBe('complete');
		expect(f.read().messages).toEqual([]);
		expect(f.read().cursor.revision).toBeGreaterThan(before.revision);
	});

	it('requires a fresh native spawn after human input and never treats a new user as the old turn', () => {
		const f = fixture();
		f.begin('user');
		f.commit([row('question')]);
		const old = f.read().cursor;
		f.commit([row('new-user', 'Continue', 'user')]);
		expect(f.read().status).toBe('incomplete');
		const run = f.begin('new-user');
		f.commit([row('new-answer')]);
		expect(f.read()).toMatchObject({
			status: 'complete',
			cursor: { runId: run.id, turnId: 'new-user' },
		});
		expect(f.read().messages.map((message) => message.id)).toEqual(['new-user', 'new-answer']);
		expect(f.index.read(binding, old).status).toBe('reset');
	});

	it.each(['agentId', 'createdAt', 'provider', 'agentSessionId', 'open'] as const)(
		'rejects changed binding %s',
		(key) => {
			const f = fixture();
			f.begin('user');
			const changed = {
				...binding,
				[key]: key === 'createdAt' ? 8 : key === 'open' ? false : 'foreign',
			};
			expect(f.index.read(changed).status).not.toBe('complete');
		}
	);

	it('uses a new generation on host restart, never disk history as a full-turn substitute', () => {
		const f = fixture();
		f.begin('user');
		const restarted = fixture();
		restarted.begin('user');
		expect(restarted.index.read(binding, f.read().cursor)).toMatchObject({
			status: 'reset',
			messages: [],
		});
		expect(new NativeCurrentTurns().read(binding).status).toBe('unknown');
	});

	it('keeps a replaced renderer incomplete until a fresh submitted boundary starts a native turn', () => {
		const f = fixture();
		f.begin('user');
		f.commit([row('user', 'Inspect', 'user')], {
			snapshot: true,
			observation: { sourceGeneration: 'new-owner', sequence: 1, createdAt: 7, provider: 'codex' },
		});
		f.begin('user');
		expect(f.read().status).toBe('incomplete');
		f.commit([row('fresh', 'New task', 'user')], {
			observation: { sourceGeneration: 'new-owner', sequence: 2, createdAt: 7, provider: 'codex' },
		});
		f.begin('fresh');
		expect(f.read()).toMatchObject({
			status: 'complete',
			cursor: { sourceGeneration: 'new-owner', turnId: 'fresh' },
		});
	});

	it('rejects a new native row without its order commit', () => {
		const f = fixture();
		f.begin('user');
		f.commit([row('unplaced-risk', 'rm -rf /data')], { orderIds: [] });
		expect(f.read()).toMatchObject({ status: 'incomplete', reason: 'commit-order-gap' });
	});

	it('bounds the fleet projection and reports eviction as unknown', () => {
		const f = fixture(
			new NativeCurrentTurns({ tabs: 1, messages: 10, bytes: 4096, totalBytes: 8192 })
		);
		f.begin('user');
		f.index.commit({
			sessionId: 'other',
			tabId: 'other',
			field: 'logs',
			upserts: [row('other')],
			orderIds: ['other'],
			removedIds: [],
			observation: { sourceGeneration: 'other', sequence: 1, createdAt: 7, provider: 'codex' },
		});
		expect(f.read()).toMatchObject({
			status: 'unknown',
			reason: 'native-transcript-unavailable-or-evicted',
			messages: [],
		});
	});

	it('waits for persisted provider binding to catch up with the native announcement without inventing continuity on replacement', () => {
		const f = fixture();
		f.begin('user');
		f.commit([], { runtime: { agentSessionId: 'announced' } });
		expect(f.read()).toMatchObject({ status: 'reset', reason: 'native-provider-binding-pending' });
		expect(f.index.read({ ...binding, agentSessionId: 'announced' }).status).toBe('complete');
		f.commit([], { runtime: { agentSessionId: 'replacement' } });
		expect(f.index.read({ ...binding, agentSessionId: 'replacement' })).toMatchObject({
			status: 'incomplete',
			reason: 'provider-session-reset',
		});
	});

	it('invalidates old native reads at spawn even if capture cannot certify the new run', () => {
		const f = fixture();
		f.begin('user');
		f.commit([row('question')]);
		f.index.spawning('agent-ai-tab');
		expect(f.read()).toMatchObject({
			status: 'incomplete',
			reason: 'native-spawn-unbound',
			messages: [],
		});
	});

	it('consumes actual native provider announcements before their renderer and disk projections', () => {
		const f = fixture();
		f.begin('user');
		f.index.announce('foreign-ai-tab', 'ignored');
		expect(f.read().status).toBe('complete');
		f.index.announce('agent-ai-tab', 'native');
		expect(f.read().status).toBe('reset');
		f.commit([], { runtime: { agentSessionId: null } });
		expect(f.index.read({ ...binding, agentSessionId: 'native' })).toMatchObject({
			status: 'incomplete',
			reason: 'native-provider-announcement-unconfirmed',
		});
		f.commit([], { runtime: { agentSessionId: 'native' } });
		expect(f.index.read({ ...binding, agentSessionId: 'native' }).status).toBe('complete');
		f.index.announce('agent-ai-tab', 'foreign');
		expect(f.index.read({ ...binding, agentSessionId: 'foreign' }).status).toBe('incomplete');
	});

	it('bounds per-turn buffers and reports overflow explicitly', () => {
		const f = fixture(
			new NativeCurrentTurns({ tabs: 2, messages: 3, bytes: 4096, totalBytes: 8192 })
		);
		f.begin('user');
		f.commit([row('a'), row('b'), row('c')]);
		expect(f.read()).toMatchObject({
			status: 'incomplete',
			reason: 'current-turn-overflow',
			messages: [],
		});
	});

	it('reports upstream tool truncation instead of certifying a full risk context', () => {
		const f = fixture();
		f.begin('user');
		f.commit([
			{
				...row('tool', 'Shell', 'tool'),
				metadata: { toolState: { output: '... [tool output truncated, 5000 chars total]' } },
			},
		]);
		expect(f.read()).toMatchObject({
			status: 'incomplete',
			reason: 'native-tool-output-truncated',
		});
	});
});

describe('native current-turn delta and final spawn revision fence', () => {
	it('reconstructs append and same-length replacement deltas without losing earlier risk', () => {
		const f = fixture();
		f.begin('user');
		f.commit([row('risk', 'Delete production')]);
		const base = f.read();
		f.commit([row('question', 'Use count?')]);
		const read = f.index.read(binding, f.read().cursor, true, base.cursor);
		expect(read).toMatchObject({
			mode: 'delta',
			baseCursor: base.cursor,
			messages: [{ id: 'question' }],
		});
		const next = composeCurrentTurn(read, base);
		expect(next.messages.map((row) => row.id)).toEqual(['user', 'risk', 'question']);
		f.commit([row('risk', 'Delete customers')]);
		const delta = f.index.read(binding, f.read().cursor, true, next.cursor);
		expect(delta.messages).toMatchObject([{ id: 'risk', text: 'Delete customers' }]);
		expect(composeCurrentTurn(delta, next).messages[1].text).toBe('Delete customers');
		expect(() => composeCurrentTurn(delta, base)).toThrow('base lost');
	});
	it.each(['own-reply', 'human-reply', 'rewrite', 'extra-row', 'reset', 'pause'] as const)(
		'fences %s during spawn preparation',
		(mode) => {
			const f = fixture();
			f.begin('user');
			f.commit([row('question', 'Use count?')]);
			const cursor = f.read().cursor;
			if (mode === 'own-reply' || mode === 'human-reply' || mode === 'extra-row')
				f.commit([row(mode === 'human-reply' ? 'human' : 'submitted', 'Use count.', 'user')]);
			if (mode === 'rewrite') f.commit([row('question', 'Use total?')]);
			if (mode === 'extra-row') f.commit([row('tool', 'Extra tool output', 'tool')]);
			if (mode === 'reset') f.index.spawning('agent-ai-tab');
			if (mode === 'pause')
				f.commit([], {
					observation: {
						sourceGeneration: 'renderer',
						sequence: 3,
						createdAt: 7,
						provider: 'codex',
						closed: true,
					},
				});
			if (mode === 'own-reply')
				expect(f.index.assertDelivery(cursor, 2, 'submitted', 'Use count.')).toBe(true);
			else expect(() => f.index.assertDelivery(cursor, 2, 'submitted', 'Use count.')).toThrow();
		}
	);
});

describe('bounded observation and cached row byte accounting', () => {
	it('does no row projection while off and refuses old continuity after enable', () => {
		const f = fixture();
		f.begin('user');
		f.commit([row('risk', 'Delete the production database')]);
		const before = f.read().cursor;
		f.index.setEnabled(false);
		expect(() => f.index.assertDelivery(before, 2, undefined, '')).toThrow(
			'Native delivery base lost'
		);
		const clone = vi.spyOn(globalThis, 'structuredClone');
		try {
			f.commit([row('question', 'Proceed?')]);
			expect(clone).not.toHaveBeenCalled();
			expect(f.read().status).toBe('unknown');
			f.index.setEnabled(true);
			f.commit([row('question', 'Proceed?')]);
			expect(f.read().status).toBe('incomplete');
			f.begin('user'); // the skipped boundary cannot be recovered
			expect(f.read().status).toBe('incomplete');
			f.commit([row('fresh', 'Inspect again', 'user')]);
			f.begin('fresh');
			expect(f.read().status).toBe('complete');
			expect(f.index.read(binding, before).status).toBe('reset');
		} finally {
			clone.mockRestore();
		}
	});

	it('bounds explicit generic observation while Pianola is off', () => {
		const index = new NativeCurrentTurns(
			{ tabs: 1, messages: 10, bytes: 4096, totalBytes: 8192 },
			false
		);
		index.observe('agent', 'tab');
		const f = fixture(index);
		f.begin('user');
		expect(f.read().status).toBe('complete');
		index.observe('other', 'tab');
		f.commit([row('ignored')]);
		expect(f.read().status).toBe('unknown');
		index.observe('agent', 'tab');
		f.commit([row('late')]);
		expect(f.read().status).toBe('incomplete');
	});

	it('releases generic interest on client end and expires stopped readers without timers', () => {
		vi.useFakeTimers();
		try {
			const index = new NativeCurrentTurns(undefined, false);
			let close!: () => void;
			const client = {
				once: vi.fn((_event, callback) => {
					close = callback;
				}),
			};
			index.observe('agent', 'tab', client);
			const f = fixture(index);
			f.begin('user');
			expect(f.read().status).toBe('complete');
			index.observe('agent', 'tab', client);
			expect(client.once).toHaveBeenCalledTimes(1);
			close();
			const clone = vi.spyOn(globalThis, 'structuredClone');
			f.commit([row('disconnected')]);
			expect(clone).not.toHaveBeenCalled();
			expect(f.read().status).toBe('unknown');
			index.observe('agent', 'tab', { once: vi.fn() }); // reconnect is a fresh lease
			f.commit([row('tail')]);
			expect(f.read().status).toBe('incomplete');
			clone.mockClear();
			vi.advanceTimersByTime(30_000);
			f.commit([row('expired')]);
			expect(clone).not.toHaveBeenCalled();
			expect(f.read().status).toBe('unknown');
			clone.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves a renewed generic lease when an older reader disconnects', () => {
		const index = new NativeCurrentTurns(undefined, false);
		let closeOld!: () => void;
		index.observe('agent', 'tab', {
			once: (_event, close) => {
				closeOld = close;
			},
		});
		const f = fixture(index);
		f.begin('user');
		index.observe('agent', 'tab', { once: vi.fn() });
		closeOld();
		f.commit([row('still-observed')]);
		expect(f.read().status).toBe('complete');
		index.setEnabled(true);
		expect(f.read().status).toBe('unknown');
		f.commit([row('tail-only')]);
		expect(f.read().status).toBe('incomplete');
	});

	it('accounts overwrites, snapshots, removals and fresh turns without old-row serialization', () => {
		const f = fixture(
			new NativeCurrentTurns({ tabs: 2, messages: 10, bytes: 1024, totalBytes: 1024 })
		);
		f.begin('user');
		const byteLength = vi.spyOn(Buffer, 'byteLength');
		for (let i = 0; i < 100; i++) f.commit([row('stream', '€'.repeat(i % 100))]);
		expect(byteLength).toHaveBeenCalledTimes(100);
		byteLength.mockRestore();
		expect(f.read().status).toBe('complete');
		f.commit([row('next', 'Fresh', 'user')]);
		f.begin('next');
		expect(f.read().messages.map((r) => r.id)).toEqual(['next']);
		f.commit([row('stream', 'x'.repeat(2000))]);
		expect(f.read()).toMatchObject({ status: 'incomplete', reason: 'current-turn-overflow' });
		f.commit([row('small', 'Small', 'user')], { snapshot: true, orderIds: ['small'] });
		f.begin('small');
		expect(f.read().status).toBe('complete');
		f.commit([], { removedIds: ['small'], orderIds: [] });
		expect(f.read().status).toBe('incomplete');
	});
});
