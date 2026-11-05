import { NativeCurrentTurns } from '../../../main/pianola/current-turn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
	PianolaDispatchAdmissionService,
	type PianolaDispatchAdmissionDeps,
} from '../../../main/pianola/pianola-dispatch-admission';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import {
	runPianolaScopeCycle,
	type PianolaScopeSnapshot,
} from '../../../shared/pianola/pianola-scope-cycle';
import {
	validatePianolaSupervisedTarget,
	type PianolaSupervisedTarget,
} from '../../../shared/pianola/storage';
import { validatePianolaDispatchAdmission } from '../../../shared/pianola/pianola-dispatch';

const scopeId = '11111111-1111-4111-8111-111111111111';
const dispatchId = '22222222-2222-4222-8222-222222222222';
const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
	fs.mkdirSync(root, { recursive: true });
	const dir = fs.mkdtempSync(path.join(root, 'admission-'));
	directories.push(dir);
	const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
	const scope: PianolaSupervisedTarget = {
		id: scopeId,
		kind: 'watch-scope',
		enabled: true,
		createdAt: 1,
		managerAgentId: 'manager',
		selection: {
			label: 'Workers',
			mode: 'agents-and-groups',
			agentIds: ['worker'],
			groupIds: [],
			excludedAgentIds: [],
		},
	};
	store.writeSupervisorTargets([scope]);
	const client = { cliAuthenticated: true };
	const controller = new AbortController();
	const caller = {
		run: { agentId: 'manager', tabId: 'manager-tab', spawnGeneration: 'spawn-1' },
		signal: controller.signal,
		unattended: true,
		assertActive() {
			if (controller.signal.aborted) throw new Error('Revoked');
		},
	};
	const snapshot: PianolaScopeSnapshot = {
		complete: true,
		capturedAt: 100,
		owners: [{ id: 'worker', cwd: process.cwd(), isPianola: false, remote: false, groupId: null }],
		tabs: [
			{
				agentId: 'worker',
				tabId: 'target',
				createdAt: 90,
				busy: false,
				paused: false,
				consult: false,
				ephemeral: false,
				cursorAvailable: true,
				cursor: null,
			},
		],
	};
	const release = vi.fn<PianolaDispatchAdmissionDeps['release']>(async (_receipt, guard) => {
		guard();
		return 'accepted';
	});
	const deps: PianolaDispatchAdmissionDeps = {
		store,
		callers: { resolve: (c) => (c === client ? caller : undefined) },
		featureEnabled: () => true,
		readSnapshot: async () => snapshot,
		ruleSetRevision: () => 'rules-1',
		assertTargetReady: () => {
			if (snapshot.tabs[0].paused) throw new Error('NativeTargetPaused');
		},
		release,
	};
	const service = new PianolaDispatchAdmissionService(deps);
	const request = {
		dispatchId,
		targetAgentId: 'worker',
		intent: { prompt: 'Implement the task', placement: 'new-tab' },
	};
	async function enroll() {
		await service.prepare(client, request);
		await service.bind(client, dispatchId, 'target');
		return service.enroll(client, dispatchId);
	}
	return {
		dir,
		store,
		scope,
		snapshot,
		deps,
		release,
		service,
		client,
		caller,
		controller,
		request,
		enroll,
	};
}

describe('host Pianola dispatch admission', () => {
	it('preserves the native empty-creation barrier in pre-start dispatch enrollment', async () => {
		const f = fixture();
		const native = new NativeCurrentTurns();
		native.commit({
			sessionId: 'worker',
			tabId: 'target',
			field: 'logs',
			snapshot: true,
			upserts: [],
			removedIds: [],
			orderIds: [],
			runtime: { state: 'idle' },
			observation: {
				sourceGeneration: 'creator',
				sequence: 1,
				createdAt: 90,
				provider: 'codex',
				emptyCreation: true,
			},
		});
		const read = native.read({
			agentId: 'worker',
			tabId: 'target',
			createdAt: 90,
			provider: 'codex',
			agentSessionId: null,
			open: true,
		});
		expect(read.status).toBe('empty-enrollment');
		f.snapshot.tabs[0].enrollment = read.enrollment;
		await f.enroll();
		expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0]).toMatchObject({
			baseline: null,
			emptyEnrollment: read.enrollment,
		});
	});

	it('persists enrollment before release and observes a fast first question through the real scope cycle', async () => {
		const f = fixture();
		await f.enroll();
		const question = {
			id: 'first-question',
			role: 'assistant' as const,
			source: 'ai' as const,
			timestamp: '2026-11-04T00:00:00.000Z',
			content: 'Should I name it count or total?',
		};
		f.release.mockImplementation(async (_receipt, guard) => {
			guard();
			expect(f.store.readDispatchAdmission(dispatchId)?.outcome).toBe('unknown');
			expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0].baseline).toBeNull();
			f.snapshot.capturedAt++;
			f.snapshot.tabs[0].cursor = {
				id: question.id,
				count: 1,
				textLength: question.content.length,
			};
			await runPianolaScopeCycle(
				scopeId,
				{
					store: f.store,
					readSnapshot: async () => f.snapshot,
					readTranscript: async () => ({
						agentId: 'worker',
						tabId: 'target',
						messages: [question],
					}),
					watch: {
						readRules: () => [],
						recordDecision: (r) => f.store.appendDecision(r),
						now: () => question.timestamp,
						genId: () => 'decision-1',
						log: vi.fn(),
						notify: vi.fn(),
					},
					dispatch: async () => ({ status: 'accepted' }),
				},
				{ dryRun: false }
			);
			expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0].baseline).toBeNull();
			expect(f.store.readDecisions().some((r) => r.tabId === 'target')).toBe(true);
			return 'accepted';
		});
		expect(await f.service.release(f.client, dispatchId)).toMatchObject({
			outcome: 'accepted',
			supervision: 'enrolled',
		});
	});

	it('serializes duplicate IDs, rejects changed intent/target, and never sends twice', async () => {
		const f = fixture();
		await Promise.all([
			f.service.prepare(f.client, f.request),
			f.service.prepare(f.client, f.request),
		]);
		await expect(
			f.service.prepare(f.client, { ...f.request, intent: 'different' })
		).rejects.toThrow('IntentMismatch');
		await f.service.bind(f.client, dispatchId, 'target');
		await expect(f.service.bind(f.client, dispatchId, 'other')).rejects.toThrow('TargetMismatch');
		await f.service.enroll(f.client, dispatchId);
		await Promise.all([
			f.service.release(f.client, dispatchId),
			f.service.release(f.client, dispatchId),
		]);
		expect(f.release).toHaveBeenCalledOnce();
		expect(f.service.status(f.client, dispatchId)).not.toHaveProperty('caller');
		expect(f.service.status(f.client, dispatchId)).not.toHaveProperty('intentFingerprint');
	});

	it('does not release after checkpoint persistence failure', async () => {
		const f = fixture();
		await f.service.prepare(f.client, f.request);
		await f.service.bind(f.client, dispatchId, 'target');
		vi.spyOn(f.store, 'writeScopeCheckpoint').mockImplementation(() => {
			throw new Error('Disk full');
		});
		await expect(f.service.enroll(f.client, dispatchId)).rejects.toThrow('Disk full');
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('NotEnrolled');
		expect(f.release).not.toHaveBeenCalled();
	});

	it('does not release after the durable release-intent write fails', async () => {
		const f = fixture();
		await f.enroll();
		vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation(() => {
			throw new Error('Disk full');
		});
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('Disk full');
		expect(f.release).not.toHaveBeenCalled();
	});

	it('keeps a durable unknown intent when storing the accepted outcome fails', async () => {
		const f = fixture();
		await f.enroll();
		const write = f.store.writeDispatchAdmission.bind(f.store);
		vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
			if (record.phase === 'settled') throw new Error('Outcome disk failure');
			write(record);
		});
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('Outcome disk failure');
		expect(await f.service.release(f.client, dispatchId)).toMatchObject({ outcome: 'unknown' });
		expect(f.release).toHaveBeenCalledOnce();
	});

	it.each(['accepted', 'unknown', 'queued'] as const)(
		'never retries %s after recreating the service',
		async (outcome) => {
			const f = fixture();
			await f.enroll();
			f.release.mockResolvedValue(outcome);
			await f.service.release(f.client, dispatchId);
			const restarted = new PianolaDispatchAdmissionService(f.deps);
			expect(await restarted.release(f.client, dispatchId)).toMatchObject({ outcome });
			expect(f.release).toHaveBeenCalledOnce();
		}
	);

	it('retains unknown on lost ack, then reconciles exact run without another send', async () => {
		const f = fixture();
		await f.enroll();
		f.release.mockRejectedValue(new Error('Ack lost'));
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('Ack lost');
		expect(await f.service.release(f.client, dispatchId)).toMatchObject({ outcome: 'unknown' });
		expect(await f.service.reconcile(dispatchId, 'accepted', 'actual-run')).toMatchObject({
			runId: 'actual-run',
		});
		await expect(f.service.reconcile(dispatchId, 'accepted', 'foreign-run')).rejects.toThrow(
			'RunMismatch'
		);
		await expect(f.service.reconcile(dispatchId, 'rejected')).rejects.toThrow('OutcomeConflict');
		expect(f.release).toHaveBeenCalledOnce();
	});

	it.each(['off', 'pause', 'excluded', 'manager', 'rules', 'policy'] as const)(
		'rechecks %s before releasing',
		async (change) => {
			const f = fixture();
			await f.enroll();
			if (change === 'off') f.deps.featureEnabled = () => false;
			if (change === 'pause') f.snapshot.tabs[0].paused = true;
			if (change === 'excluded') f.scope.selection!.excludedAgentIds.push('worker');
			if (change === 'manager') f.scope.managerAgentId = 'other-manager';
			if (change === 'rules') f.deps.ruleSetRevision = () => 'rules-2';
			if (change === 'policy')
				f.scope.delegationPolicy = {
					version: 1,
					revision: 2,
					enabled: false,
					managerAgentId: 'manager',
					coverage: 'selected-agents',
					ruleSetRevision: 'rules-1',
				};
			f.store.writeSupervisorTargets([f.scope]);
			await expect(f.service.release(f.client, dispatchId)).rejects.toThrow();
			expect(f.release).not.toHaveBeenCalled();
		}
	);

	it('fences a pause at the actual delayed transport boundary and never retries it', async () => {
		const f = fixture();
		await f.enroll();
		f.release.mockImplementation(async (_receipt, guard) => {
			f.snapshot.tabs[0].paused = true;
			guard();
			return 'accepted';
		});
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('NativeTargetPaused');
		expect(await f.service.release(f.client, dispatchId)).toMatchObject({ outcome: 'unknown' });
		expect(f.release).toHaveBeenCalledOnce();
	});

	it('rejects unbound clients and revoked callers', async () => {
		const f = fixture();
		await expect(f.service.prepare({ cliAuthenticated: true }, f.request)).rejects.toThrow(
			'CallerRunUnavailable'
		);
		await f.enroll();
		f.controller.abort();
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('Revoked');
		expect(f.release).not.toHaveBeenCalled();
	});

	it('preserves pre-start enrollment when an older worker census writes its checkpoint', async () => {
		const f = fixture();
		await f.enroll();
		const stale = f.store.readScopeCheckpoint(scopeId)!;
		stale.tabs = [];
		f.store.writeScopeCheckpoint(stale);
		expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0].dispatchEnrollmentId).toBe(dispatchId);
	});

	it('fails closed for corrupt disk records and unknown policy versions', async () => {
		const f = fixture();
		await f.enroll();
		const record = f.store.readDispatchAdmission(dispatchId)!;
		expect(
			validatePianolaDispatchAdmission({ ...record, phase: 'released', outcome: 'not-started' })
		).toBeNull();
		expect(
			validatePianolaSupervisedTarget({ ...f.scope, delegationPolicy: { version: 99 } })
		).toBeNull();
		fs.writeFileSync(path.join(f.dir, `maestro-pianola-dispatch-${dispatchId}.json`), '{broken');
		await expect(f.service.prepare(f.client, f.request)).rejects.toThrow();
		expect(f.release).not.toHaveBeenCalled();
	});
});
