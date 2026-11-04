import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
	PianolaNewTabDispatch,
	pianolaNewTabSpawns,
	type PianolaNewTabRequest,
} from '../../../main/pianola/pianola-new-tab-dispatch';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import type { PianolaScopeSnapshot } from '../../../shared/pianola/pianola-scope-cycle';
import type { NewAITabWithPromptCallback } from '../../../shared/pianola/pianola-dispatch';
import { generateUUID } from '../../../shared/uuid';

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
	fs.mkdirSync(root, { recursive: true });
	const dir = fs.mkdtempSync(path.join(root, 'native-new-tab-'));
	directories.push(dir);
	const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
	const scopeId = generateUUID();
	store.writeSupervisorTargets([
		{
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
		},
	]);
	const snapshot: PianolaScopeSnapshot = {
		complete: true,
		capturedAt: 100,
		owners: [{ id: 'worker', cwd: process.cwd(), isPianola: false, remote: false, groupId: null }],
		tabs: [],
	};
	const client = { cliAuthenticated: true };
	const controller = new AbortController();
	const caller = {
		run: { agentId: 'manager', tabId: 'manager-tab', spawnGeneration: generateUUID() },
		signal: controller.signal,
		unattended: true,
		assertActive() {
			if (controller.signal.aborted) throw new Error('Revoked');
		},
	};
	const request: PianolaNewTabRequest = {
		dispatchId: generateUUID(),
		targetAgentId: 'worker',
		prompt: 'Implement the task',
		background: true,
		hidden: true,
	};
	const key = `worker-ai-${request.dispatchId}`;
	const events: string[] = [];
	const newTab = vi.fn<NewAITabWithPromptCallback>(
		async (_agent, prompt, _background, _hidden, _routing, control) => {
			if (control?.phase === 'prepare') {
				expect(prompt).toBe('');
				expect(() => pianolaNewTabSpawns.claim(key)).toThrow('DispatchAdmissionPending');
				if (!snapshot.tabs.length)
					snapshot.tabs.push({
						agentId: 'worker',
						tabId: control.tabId,
						createdAt: 99,
						busy: false,
						paused: false,
						consult: false,
						ephemeral: false,
						cursorAvailable: true,
						cursor: null,
					});
				events.push('prepared');
				return { success: true, tabId: control.tabId };
			}
			expect(control?.phase).toBe('release');
			expect(store.readScopeCheckpoint(scopeId)?.tabs[0].baseline).toBeNull();
			expect(store.readDispatchAdmission(request.dispatchId)?.outcome).toBe('unknown');
			expect(events).toContain('callback');
			const guard = pianolaNewTabSpawns.claim(key, control?.dispatchId);
			guard();
			events.push('spawn');
			pianolaNewTabSpawns.captured(key, 'actual-spawn-generation');
			pianolaNewTabSpawns.started(key);
			// First worker question can arrive before the renderer ack.
			snapshot.tabs[0].cursor = { id: 'first-question', count: 1, textLength: 20 };
			return { success: true, tabId: control?.tabId };
		}
	);
	const deps = {
		store,
		callers: { resolve: (c: object) => (c === client ? caller : undefined) },
		featureEnabled: () => true,
		snapshot: () => snapshot,
		ruleSetRevision: () => 'rules-1',
		newTab,
		onReconcileError: vi.fn(),
	};
	const adapter = new PianolaNewTabDispatch(deps);
	const arm = vi.fn(() => {
		events.push('callback');
		return 'callback-1';
	});
	return { store, scopeId, snapshot, client, request, key, newTab, deps, adapter, arm, events };
}

describe('native new-tab Pianola admission adapter', () => {
	it('re-resolves group ownership at the native boundary even when parent identity is unchanged', async () => {
		const f = fixture();
		const scope = f.store.readSupervisorTargets()[0];
		scope.selection = {
			label: 'Group',
			mode: 'agents-and-groups',
			agentIds: [],
			groupIds: ['selected'],
			excludedAgentIds: [],
		};
		f.store.writeSupervisorTargets([scope]);
		f.snapshot.owners[0].groupId = 'selected';
		const original = f.newTab.getMockImplementation()!;
		f.newTab.mockImplementation(async (...args) => {
			if (args[5]?.phase === 'release') f.snapshot.owners[0].groupId = 'different';
			return original(...args);
		});
		const result = await f.adapter.run(f.client, f.request, f.arm);
		expect(result.receipt.outcome).toBe('unknown');
		expect(f.events).not.toContain('spawn');
	});

	it('does not adopt or lock an unrelated tab that collides with the requested ID', async () => {
		const f = fixture();
		f.snapshot.tabs.push({
			agentId: 'worker',
			tabId: f.request.dispatchId,
			createdAt: 80,
			busy: false,
			paused: false,
			consult: false,
			ephemeral: false,
			cursorAvailable: true,
			cursor: null,
		});
		await expect(f.adapter.run(f.client, f.request, f.arm)).rejects.toThrow(
			'DispatchPrepareUnknown'
		);
		await expect(f.adapter.run(f.client, f.request, f.arm)).rejects.toThrow(
			'DispatchPrepareUnknown'
		);
		expect(f.newTab).not.toHaveBeenCalled();
		expect(pianolaNewTabSpawns.isHeld('worker', f.request.dispatchId)).toBe(false);
	});

	it.each(['checkpoint', 'bind', 'enroll', 'callback'] as const)(
		'cleans up a persisted empty tab after %s failure so a normal send can start',
		async (failure) => {
			const f = fixture();
			if (failure === 'checkpoint')
				vi.spyOn(f.store, 'writeScopeCheckpoint').mockImplementationOnce(() => {
					throw new Error('WriteFailed');
				});
			else if (failure === 'callback')
				f.arm.mockImplementationOnce(() => {
					throw new Error('WriteFailed');
				});
			else {
				const write = f.store.writeDispatchAdmission.bind(f.store);
				vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
					if (record.phase === (failure === 'bind' ? 'bound' : 'enrolled'))
						throw new Error('WriteFailed');
					write(record);
				});
			}
			await expect(f.adapter.run(f.client, f.request, f.arm)).rejects.toThrow('WriteFailed');
			expect(f.snapshot.tabs).toHaveLength(1);
			expect(f.events).not.toContain('spawn');
			expect(pianolaNewTabSpawns.isHeld('worker', f.request.dispatchId)).toBe(false);
			expect(() => pianolaNewTabSpawns.claim(f.key)).not.toThrow();
		}
	);

	it('refuses markerless and foreign sends while release is delayed without consuming the fence', async () => {
		const f = fixture();
		let continueRelease!: () => void;
		const delayed = new Promise<void>((resolve) => {
			continueRelease = resolve;
		});
		let reachedRelease!: () => void;
		const reached = new Promise<void>((resolve) => {
			reachedRelease = resolve;
		});
		const original = f.newTab.getMockImplementation()!;
		f.newTab.mockImplementation(async (...args) => {
			if (args[5]?.phase === 'release') {
				reachedRelease();
				await delayed;
			}
			return original(...args);
		});
		const result = f.adapter.run(f.client, f.request, f.arm);
		await reached;
		expect(() => pianolaNewTabSpawns.claim(f.key)).toThrow('DispatchIdentityMismatch');
		expect(() => pianolaNewTabSpawns.claim(f.key, 'foreign')).toThrow('DispatchIdentityMismatch');
		expect(f.adapter.admission.status(f.client, f.request.dispatchId).outcome).toBe('unknown');
		expect(pianolaNewTabSpawns.isHeld('worker', f.request.dispatchId)).toBe(true);
		continueRelease();
		expect((await result).receipt.outcome).toBe('accepted');
		expect(f.events.filter((e) => e === 'spawn')).toHaveLength(1);
	});

	it('binds and durably enrolls the empty tab and arms the callback before a fast first turn', async () => {
		const f = fixture();
		const result = await f.adapter.run(f.client, f.request, f.arm);
		expect(result.receipt).toMatchObject({
			outcome: 'accepted',
			supervision: 'enrolled',
			targetTabId: f.request.dispatchId,
			runId: 'actual-spawn-generation',
		});
		expect(f.events).toEqual(['prepared', 'callback', 'spawn']);
		expect(f.store.readScopeCheckpoint(f.scopeId)?.tabs[0].baseline).toBeNull();
	});
	it('serializes simultaneous copies of one dispatch ID without creating or sending twice', async () => {
		const f = fixture();
		const results = await Promise.all([
			f.adapter.run(f.client, f.request, f.arm),
			f.adapter.run(f.client, f.request, f.arm),
		]);
		expect(results[0]).toEqual(results[1]);
		expect(f.newTab).toHaveBeenCalledTimes(2); // one prepare, one release
		expect(f.arm).toHaveBeenCalledOnce();
		await expect(
			f.adapter.run(f.client, { ...f.request, prompt: 'Different' }, f.arm)
		).rejects.toThrow('DispatchIntentMismatch');
	});
	it('does not send again after a lost release ack, including adapter reconstruction', async () => {
		const f = fixture();
		const original = f.newTab.getMockImplementation()!;
		f.newTab.mockImplementation(async (...args) => {
			if (args[5]?.phase === 'prepare') return original(...args);
			return { success: false, unknown: true };
		});
		const first = await f.adapter.run(f.client, f.request, f.arm);
		expect(first.receipt.outcome).toBe('unknown');
		const recovered = await new PianolaNewTabDispatch(f.deps).run(f.client, f.request, f.arm);
		expect(recovered.receipt).toEqual(first.receipt);
		expect(f.newTab).toHaveBeenCalledTimes(2);
		await f.adapter.admission.reconcile(f.request.dispatchId, 'accepted', 'late-native-run');
		expect(f.adapter.admission.status(f.client, f.request.dispatchId).runId).toBe(
			'late-native-run'
		);
	});
	it('uses the same empty address after a lost prepare confirmation', async () => {
		const f = fixture();
		const original = f.newTab.getMockImplementation()!;
		f.newTab.mockImplementationOnce(async (...args) => {
			await original(...args);
			return { success: false, unknown: true };
		});
		await expect(f.adapter.run(f.client, f.request, f.arm)).rejects.toThrow(
			'DispatchPrepareUnknown'
		);
		expect(f.snapshot.tabs).toHaveLength(1);
		expect(pianolaNewTabSpawns.isHeld('worker', f.request.dispatchId)).toBe(true);
		expect(() => pianolaNewTabSpawns.claim(f.key)).toThrow('DispatchAdmissionPending');
		await f.adapter.run(f.client, f.request, f.arm);
		expect(f.snapshot.tabs).toHaveLength(1);
		expect(f.events.filter((e) => e === 'spawn')).toHaveLength(1);
	});
	it('blocks a pause between prepare and release without sending a prompt', async () => {
		const f = fixture();
		f.arm.mockImplementation(() => {
			f.snapshot.tabs[0].paused = true;
			return 'callback';
		});
		await expect(f.adapter.run(f.client, f.request, f.arm)).rejects.toThrow();
		expect(f.newTab).toHaveBeenCalledTimes(1);
		expect(pianolaNewTabSpawns.isHeld('worker', f.request.dispatchId)).toBe(false);
		expect(() => pianolaNewTabSpawns.claim(f.key)).not.toThrow();
	});
	it('rechecks pause after renderer preparation at the native spawn and does not retry unknown delivery', async () => {
		const f = fixture();
		const original = f.newTab.getMockImplementation()!;
		f.newTab.mockImplementation(async (...args) => {
			if (args[5]?.phase === 'prepare') return original(...args);
			const guard = pianolaNewTabSpawns.claim(f.key, f.request.dispatchId);
			expect(() => pianolaNewTabSpawns.claim(f.key, f.request.dispatchId)).toThrow(
				'DispatchAlreadyStarting'
			);
			f.snapshot.tabs[0].paused = true;
			guard();
			return { success: true };
		});
		const result = await f.adapter.run(f.client, f.request, f.arm);
		expect(result.receipt.outcome).toBe('unknown');
		await f.adapter.run(f.client, f.request, f.arm);
		expect(f.newTab).toHaveBeenCalledTimes(2);
		expect(f.events).not.toContain('spawn');
	});
	it('fails before tab creation for feature off, foreign caller, and unavailable baseline persistence', async () => {
		const f = fixture();
		await expect(
			new PianolaNewTabDispatch({ ...f.deps, featureEnabled: () => false }).run(
				f.client,
				f.request,
				f.arm
			)
		).rejects.toThrow('PianolaFeatureOff');
		await expect(f.adapter.run({}, f.request, f.arm)).rejects.toThrow('CallerRunUnavailable');
		expect(f.newTab).not.toHaveBeenCalled();
		vi.spyOn(f.store, 'writeScopeCheckpoint').mockImplementation(() => {
			throw new Error('DiskFull');
		});
		await expect(f.adapter.run(f.client, f.request, f.arm)).rejects.toThrow('DiskFull');
		expect(f.newTab).toHaveBeenCalledTimes(1);
		expect(f.events).not.toContain('spawn');
	});
});
