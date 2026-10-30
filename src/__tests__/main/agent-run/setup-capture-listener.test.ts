import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunEvent } from '../../../shared/agent-run';
import type { ProcessManager } from '../../../main/process-manager';

const { runs, events, storeMocks } = vi.hoisted(() => {
	const runs = new Map<string, AgentRun>();
	const events: AgentRunEvent[] = [];
	return {
		runs,
		events,
		storeMocks: {
			getAgentRun: (id: string) => runs.get(id),
			upsertAgentRun: (run: AgentRun) => {
				runs.set(run.id, run);
				return run;
			},
			appendAgentRunEvent: (event: AgentRunEvent) => {
				events.push(event);
				return event;
			},
			findActiveRunBySession: (sessionId: string) =>
				[...runs.values()].find(
					(run) =>
						run.sessionId === sessionId &&
						['queued', 'running', 'waiting', 'needs_review', 'fixing'].includes(run.status)
				),
		},
	};
});

vi.mock('../../../cli/services/agent-run-store', () => storeMocks);
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/agent-run/broadcast', () => ({
	broadcastRunUpdated: vi.fn(),
	broadcastEventAppended: vi.fn(),
}));
vi.mock('../../../main/agent-run/producers', () => ({ buildEnrichHook: () => () => ({}) }));

import { setupAgentRunCapture } from '../../../main/agent-run/setup-capture-listener';

function spawn(manager: EventEmitter, sessionId = 'worker-ai-tab') {
	manager.emit('spawn', { sessionId, toolType: 'codex', cwd: '/fixture', tabId: 'tab' });
	return [...runs.values()].filter((run) => run.sessionId === sessionId).at(-1)!;
}

describe('ProcessManager -> AgentRun capture', () => {
	beforeEach(() => {
		runs.clear();
		events.length = 0;
	});

	it.each(['rate_limited', 'auth_expired'])(
		'keeps structured %s failure when the process exits zero',
		async (type) => {
			const manager = new EventEmitter();
			setupAgentRunCapture(manager as ProcessManager, { enrich: () => ({}) });
			const run = spawn(manager);
			manager.emit('agent-error', run.sessionId, {
				type,
				message: 'Provider refused token=super-secret-value',
				recoverable: true,
				agentId: 'codex',
				timestamp: 100,
				raw: { stderr: 'private raw output' },
			});
			expect(runs.get(run.id)?.metadata?.agentError).toMatchObject({ type });
			expect(JSON.stringify(runs.get(run.id))).not.toContain('super-secret-value');
			expect(JSON.stringify(runs.get(run.id))).not.toContain('private raw output');
			manager.emit('exit', run.sessionId, 0);
			await vi.waitFor(() => expect(runs.get(run.id)?.status).toBe('failed'));
		}
	);

	it.each([
		['interrupted', 'cancelled'],
		['crashed', 'failed'],
	])('preserves a zero-exit %s settlement as %s', async (outcome, status) => {
		const manager = new EventEmitter();
		setupAgentRunCapture(manager as ProcessManager, { enrich: () => ({}) });
		const run = spawn(manager);
		manager.emit('exit', run.sessionId, 0, undefined, { outcome, answerCaptured: false });
		await vi.waitFor(() => expect(runs.get(run.id)?.status).toBe(status));
		expect(runs.get(run.id)?.metadata?.outcome).toBe(outcome);
	});

	it('cannot overwrite a structured error or checks arriving while exit enrichment waits', async () => {
		let finish!: (value: Partial<AgentRun>) => void;
		const manager = new EventEmitter();
		setupAgentRunCapture(manager as ProcessManager, {
			enrich: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const run = spawn(manager);
		manager.emit('exit', run.sessionId, 0);
		manager.emit('agent-error', run.sessionId, {
			type: 'rate_limited',
			message: 'Quota exhausted',
			agentId: 'codex',
			recoverable: true,
			timestamp: 100,
		});
		const current = runs.get(run.id)!;
		runs.set(run.id, { ...current, checks: [{ name: 'acceptance', status: 'failed' }] });
		finish({ touchedFiles: ['result.ts'] });
		await vi.waitFor(() =>
			expect(runs.get(run.id)?.metadata?.completedAt).toEqual(expect.any(Number))
		);
		expect(runs.get(run.id)?.status).toBe('failed');
		expect(runs.get(run.id)?.checks).toEqual([{ name: 'acceptance', status: 'failed' }]);
	});

	it('does not resurrect a superseded run after delayed enrichment', async () => {
		let finish!: (value: Partial<AgentRun>) => void;
		const manager = new EventEmitter();
		setupAgentRunCapture(manager as ProcessManager, {
			enrich: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const first = spawn(manager);
		manager.emit('exit', first.sessionId, 0);
		const second = spawn(manager);
		finish({});
		await Promise.resolve();
		await Promise.resolve();
		expect(runs.get(first.id)?.status).toBe('cancelled');
		expect(runs.get(second.id)?.status).toBe('running');
	});

	it('treats a signal exit reported as code zero as failure', async () => {
		const manager = new EventEmitter();
		setupAgentRunCapture(manager as ProcessManager, { enrich: () => ({}) });
		const run = spawn(manager);
		manager.emit('exit', run.sessionId, 0, 9);
		await vi.waitFor(() => expect(runs.get(run.id)?.status).toBe('failed'));
		expect(runs.get(run.id)?.metadata?.signal).toBe(9);
	});

	it('keeps concurrent review findings when the producer returns a stale review snapshot', async () => {
		let finish!: (value: Partial<AgentRun>) => void;
		const manager = new EventEmitter();
		setupAgentRunCapture(manager as ProcessManager, {
			enrich: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const run = spawn(manager);
		manager.emit('exit', run.sessionId, 0);
		const current = runs.get(run.id)!;
		runs.set(run.id, {
			...current,
			reviews: [
				{
					severity: 'high',
					category: 'correctness',
					message: 'Acceptance missing',
					status: 'open',
				},
			],
		});
		finish({ reviews: [] });
		await vi.waitFor(() => expect(runs.get(run.id)?.status).toBe('needs_review'));
		expect(runs.get(run.id)?.reviews).toHaveLength(1);
	});
});
