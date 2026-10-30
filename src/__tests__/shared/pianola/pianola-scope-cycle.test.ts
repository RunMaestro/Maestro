/** Scope lifecycle contracts through the real watcher and filesystem checkpoint store.
 * Delivery and desktop snapshots are controlled; no live agent receives a message. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import {
	runPianolaScopeCycle,
	pianolaScopeSnapshotFromDesktop,
	pianolaScopeConfigurationFingerprint,
	type PianolaScopeCycleDeps,
	type PianolaScopeSnapshot,
	type PianolaScopeSnapshotTab,
} from '../../../shared/pianola/pianola-scope-cycle';
import { resolvePianolaScopeOwnership } from '../../../shared/pianola/pianola-scope';
import { MAX_DISPATCH_ATTEMPTS } from '../../../shared/pianola/pianola-watcher';
import { updatePianolaDecision } from '../../../shared/pianola/pianola-decision-lifecycle';
import type { PianolaMessage, PianolaRule } from '../../../shared/pianola/types';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';

const scopeId = '11111111-1111-4111-8111-111111111111';
const otherScopeId = '22222222-2222-4222-8222-222222222222';
const projectRoot = path.resolve('pianola-fixture-project');
const fixtureRoot = path.resolve('.maestro/pianola-project-watchers-20261028/auto-run/Working');
const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

function message(id: string, content = 'Should I name it count or total?'): PianolaMessage {
	return { id, role: 'assistant', source: 'ai', content, timestamp: '2026-10-28T00:00:00.000Z' };
}

function fixture() {
	fs.mkdirSync(fixtureRoot, { recursive: true });
	const directory = fs.mkdtempSync(path.join(fixtureRoot, 'scope-cycle-'));
	directories.push(directory);
	const store = createPianolaFsStore({
		resolveDir: () => directory,
		indent: 2,
		trailingNewline: true,
	});
	const scope = {
		id: scopeId,
		kind: 'watch-scope',
		enabled: true as boolean,
		createdAt: 1,
		managerAgentId: 'manager',
		selection: {
			label: 'Selected agents',
			mode: 'agents-and-groups',
			agentIds: ['owner'],
			groupIds: [],
			excludedAgentIds: [] as string[],
		},
	} satisfies PianolaSupervisedTarget;
	store.writeSupervisorTargets([scope]);
	const snapshot: PianolaScopeSnapshot = {
		capturedAt: 100,
		complete: true,
		owners: [{ id: 'owner', cwd: projectRoot, isPianola: false, remote: false }],
		tabs: [],
	};
	const transcripts = new Map<string, PianolaMessage[]>();
	const rules: PianolaRule[] = [
		{
			id: 'naming-rule',
			enabled: true,
			scope: 'project',
			scopeId: projectRoot,
			match: { kinds: ['question'], maxRisk: 'low' },
			action: 'auto_answer',
			answer: 'Use count.',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		},
	];
	let decisionSequence = 0;
	const deps: PianolaScopeCycleDeps = {
		store,
		readSnapshot: vi.fn(async () => JSON.parse(JSON.stringify(snapshot)) as PianolaScopeSnapshot),
		readTranscript: vi.fn(async (target) => ({
			agentId: target.agentId,
			tabId: target.tabId,
			messages: transcripts.get(target.tabId) ?? [],
		})),
		watch: {
			readRules: () => rules,
			recordDecision: (record) => store.appendDecision(record),
			now: () => '2026-10-28T00:00:00.000Z',
			genId: () => `decision-${++decisionSequence}`,
			log: vi.fn(),
			notify: vi.fn(),
		},
		dispatch: vi.fn<PianolaScopeCycleDeps['dispatch']>(async () => ({ status: 'accepted' })),
		requestJudgment: vi.fn<NonNullable<PianolaScopeCycleDeps['requestJudgment']>>(async () => ({
			status: 'accepted',
		})),
	};
	function tab(tabId = 'existing', agentId = 'owner', createdAt = 50): PianolaScopeSnapshotTab {
		const value: PianolaScopeSnapshotTab = {
			agentId,
			tabId,
			createdAt,
			paused: false,
			consult: false,
			ephemeral: false,
			busy: false,
			cursorAvailable: true,
			cursor: null,
		};
		snapshot.tabs.push(value);
		return value;
	}
	function history(value: PianolaScopeSnapshotTab, messages: PianolaMessage[]) {
		transcripts.set(value.tabId, messages);
		const last = messages[messages.length - 1];
		value.cursor = last
			? { id: last.id, count: messages.length, textLength: last.content.length }
			: null;
	}
	function cycle(id = scopeId) {
		snapshot.capturedAt += 10;
		return runPianolaScopeCycle(id, deps, { dryRun: false });
	}
	function saveScopes(...values: PianolaSupervisedTarget[]) {
		store.writeSupervisorTargets(values);
	}
	function checkpoint() {
		return store.readScopeCheckpoint(scopeId)!;
	}
	return {
		store,
		scope,
		snapshot,
		transcripts,
		rules,
		deps,
		tab,
		history,
		cycle,
		saveScopes,
		checkpoint,
	};
}

describe('scope activation and working-tab discovery', () => {
	it('answers a same-ID busy stream completed after enrollment once, including after restart', async () => {
		const f = fixture();
		const tab = f.tab();
		tab.busy = true;
		f.history(tab, [message('stream', 'Working.')]);
		await f.cycle();
		const directory = path.dirname(f.store.supervisorFilePath());
		f.deps.store = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		tab.busy = false;
		f.history(tab, [message('stream')]);
		const result = await f.cycle();
		expect(result.issues).toEqual([]);
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.deps.dispatch).mock.calls[0][2].messageId).toBe('stream');
		await f.cycle();
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		'retains full current-turn risk for a fresh ask (same stream: %s)',
		async (sameStream) => {
			const f = fixture();
			const tab = f.tab();
			tab.busy = true;
			const task: PianolaMessage = {
				...message('task', 'Investigate only.'),
				role: 'user',
				source: 'user',
			};
			const intent = message('intent', 'I will run DROP DATABASE demo.');
			f.history(tab, [task, intent, message('stream', 'Working.')]);
			await f.cycle();
			tab.busy = false;
			f.history(
				tab,
				sameStream
					? [task, intent, message('stream')]
					: [task, intent, message('stream', 'Working.'), message('fresh')]
			);
			const result = await f.cycle();
			expect(result.issues).toEqual([]);
			expect(result.iterations[0].result).toMatchObject({
				classification: { kind: 'question', risk: 'high' },
				decision: { action: 'escalate' },
			});
			expect(f.deps.dispatch).not.toHaveBeenCalled();
			expect(f.deps.requestJudgment).not.toHaveBeenCalled();
			expect(f.deps.watch.notify).toHaveBeenCalledWith(expect.objectContaining({ highRisk: true }));
		}
	);

	it.each(['idle-unchanged', 'tool-appended', 'idle-grew'] as const)(
		'does not revive a historical ask when %s',
		async (change) => {
			const f = fixture();
			const tab = f.tab();
			tab.busy = false;
			f.history(tab, [message('old')]);
			await f.cycle();
			tab.busy = false;
			if (change === 'tool-appended')
				f.history(tab, [
					message('old'),
					{ ...message('tool', 'Finished.'), role: 'tool', source: 'tool' },
				]);
			if (change === 'idle-grew')
				f.history(tab, [message('old', 'Should I name it count or total? Please choose.')]);
			await f.cycle();
			expect(f.store.readDecisions()).toEqual([]);
			expect(f.deps.dispatch).not.toHaveBeenCalled();
			expect(f.deps.requestJudgment).not.toHaveBeenCalled();
		}
	);

	it('ends prior risk context at a new user task while retaining a fresh question', async () => {
		const f = fixture();
		const tab = f.tab();
		f.history(tab, [message('old', 'I will run DROP DATABASE demo.')]);
		await f.cycle();
		f.history(tab, [
			message('old', 'I will run DROP DATABASE demo.'),
			{ ...message('task', 'Only choose a variable name.'), role: 'user', source: 'user' },
			message('fresh'),
		]);
		await f.cycle();
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
	});

	it('baselines every existing tab without reading or acting on historical asks', async () => {
		const f = fixture();
		f.history(f.tab('first'), [message('old-1')]);
		f.history(f.tab('second'), [message('old-2')]);
		expect(await f.cycle()).toMatchObject({ status: 'armed', iterations: [], issues: [] });
		expect(f.checkpoint().tabs.map((tab) => tab.baseline?.id)).toEqual(['old-1', 'old-2']);
		await f.cycle();
		expect(f.deps.readTranscript).not.toHaveBeenCalled();
		expect(f.store.readDecisions()).toEqual([]);
		expect(f.deps.dispatch).not.toHaveBeenCalled();
		expect(f.deps.requestJudgment).not.toHaveBeenCalled();
	});

	it('commits membership and an audited delivery intent before answering fresh work', async () => {
		const f = fixture();
		const tab = f.tab();
		f.history(tab, [message('old')]);
		await f.cycle();
		f.history(tab, [message('old'), message('fresh')]);
		vi.mocked(f.deps.dispatch).mockImplementation(async (target, answer, guard) => {
			expect(target).toEqual({ agentId: 'owner', tabId: 'existing', projectPath: projectRoot });
			expect(answer).toBe('Use count.');
			expect(guard).toMatchObject({
				scopeId,
				agentId: 'owner',
				tabId: 'existing',
				messageId: 'fresh',
			});
			expect(f.checkpoint()).toMatchObject({
				status: 'armed',
				tabs: [
					{
						baseline: { id: 'old' },
						unresolvedIntent: { decisionId: guard.decisionId, messageId: 'fresh' },
					},
				],
			});
			expect(f.store.readDecisions()).toMatchObject([{ id: guard.decisionId, dispatched: false }]);
			return { status: 'accepted' };
		});
		expect((await f.cycle()).iterations[0].result.dispatched).toBe(true);
		expect(f.checkpoint().tabs[0]).toMatchObject({
			unresolvedIntent: null,
			state: { lastHandledMessageId: 'fresh' },
		});
		expect(f.store.readDecisions()).toMatchObject([{ dispatched: true }]);
	});

	it('fails closed when the baseline write fails', async () => {
		const f = fixture();
		f.history(f.tab(), [message('old')]);
		vi.spyOn(f.store, 'writeScopeCheckpoint').mockImplementation(() => {
			throw new Error('disk full');
		});
		await expect(f.cycle()).rejects.toThrow('disk full');
		expect(f.deps.readTranscript).not.toHaveBeenCalled();
		expect(f.deps.dispatch).not.toHaveBeenCalled();
	});

	it('isolates an unavailable enrollment cursor and baselines it when restored', async () => {
		const f = fixture();
		const healthy = f.tab();
		const missing = f.tab('missing');
		missing.cursorAvailable = false;
		expect((await f.cycle()).status).toBe('armed');
		expect(f.checkpoint().tabs.find((tab) => tab.tabId === 'missing')).toMatchObject({
			status: 'suspended',
			coverage: {
				status: 'blocked',
				reason: 'Transcript cursor unavailable',
				nextActor: 'operator',
				nextAction: expect.stringContaining('Restore native transcript cursor'),
			},
		});
		expect(f.checkpoint().tabs.find((tab) => tab.tabId === healthy.tabId)?.coverage?.status).toBe(
			'covered'
		);
		f.history(healthy, [message('during-incomplete-baseline')]);
		missing.cursorAvailable = true;
		expect((await f.cycle()).status).toBe('armed');
		expect(f.checkpoint().tabs.find((tab) => tab.tabId === 'missing')).toMatchObject({
			baseline: null,
			coverage: { status: 'covered', nextActor: 'worker' },
		});
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.deps.dispatch).mock.calls[0][0].tabId).toBe(healthy.tabId);
	});

	it('processes the first ask in a genuinely new tab but baselines a newly discovered old tab', async () => {
		const f = fixture();
		await f.cycle();
		f.history(f.tab('new', 'owner', 115), [message('new-ask')]);
		f.history(f.tab('historical', 'owner', 60), [message('old-ask')]);
		await f.cycle();
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.deps.dispatch).mock.calls[0][0].tabId).toBe('new');
		expect(f.checkpoint().tabs.find((tab) => tab.tabId === 'historical')?.baseline?.id).toBe(
			'old-ask'
		);
	});

	it('restores persisted cursors through a new store instance without losing unhandled activity', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('before-restart')]);
		const directory = path.dirname(f.store.supervisorFilePath());
		f.deps.store = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		await f.cycle();
		await f.cycle();
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		f.history(tab, [message('before-restart'), message('after-restart')]);
		await f.cycle();
		expect(f.deps.dispatch).toHaveBeenCalledTimes(2);
	});

	it('baselines new scope members while preserving an unchanged owner pending ask', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('still-pending')]);
		const newRoot = path.resolve('pianola-added-project');
		f.scope.selection.agentIds.push('added');
		f.saveScopes(f.scope);
		f.snapshot.owners.push({ id: 'added', cwd: newRoot, isPianola: false, remote: false });
		f.history(f.tab('added', 'added', 115), [message('old-new-member')]);
		await f.cycle();
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.deps.dispatch).mock.calls[0][2].messageId).toBe('still-pending');
	});

	it('rejects a rolled-back host census instead of replaying history', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('fresh')]);
		f.snapshot.capturedAt = 1;
		await expect(f.cycle()).rejects.toThrow('host clock');
		expect(f.deps.dispatch).not.toHaveBeenCalled();
	});
});

describe('scope ownership and lifecycle', () => {
	it.each(['paused', 'closed', 'disabled', 'binding'] as const)(
		'baselines accumulated work after %s and resumes only fresh asks',
		async (transition) => {
			const f = fixture();
			const tab = f.tab();
			await f.cycle();
			if (transition === 'paused') tab.paused = true;
			if (transition === 'closed') f.snapshot.tabs = [];
			if (transition === 'disabled') {
				f.scope.enabled = false;
				f.saveScopes(f.scope);
			}
			if (transition === 'binding') f.snapshot.owners[0].parentSessionId = 'missing-parent';
			await f.cycle();
			f.history(tab, [message('while-suspended')]);
			tab.paused = false;
			f.snapshot.tabs = [tab];
			f.scope.enabled = true;
			f.saveScopes(f.scope);
			f.snapshot.owners[0].parentSessionId = null;
			await f.cycle();
			expect(f.deps.dispatch).not.toHaveBeenCalled();
			f.history(tab, [message('while-suspended'), message('after-resume')]);
			await f.cycle();
			expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		}
	);

	it.each([
		'manager',
		'pianola',
		'remote',
		'consult',
		'ephemeral',
		'disabled-watch',
		'explicit-watch',
		'disabled-scope',
	] as const)('excludes %s without reading a transcript', async (reason) => {
		const f = fixture();
		const tab = f.tab();
		if (reason === 'manager') f.scope.managerAgentId = 'owner';
		if (reason === 'pianola') f.snapshot.owners[0].isPianola = true;
		if (reason === 'remote') f.snapshot.owners[0].remote = true;
		if (reason === 'consult') tab.consult = true;
		if (reason === 'ephemeral') tab.ephemeral = true;
		const extra: PianolaSupervisedTarget[] = [];
		if (reason === 'disabled-watch' || reason === 'explicit-watch')
			extra.push({
				id: 'legacy-watch',
				kind: 'watch',
				enabled: reason === 'explicit-watch',
				createdAt: 1,
				agentId: 'owner',
				tabId: tab.tabId,
			});
		if (reason === 'disabled-scope') extra.push({ ...f.scope, id: otherScopeId, enabled: false });
		f.saveScopes(f.scope, ...extra);
		await f.cycle();
		f.history(tab, [message('must-not-act')]);
		await f.cycle();
		expect(f.deps.readTranscript).not.toHaveBeenCalled();
		expect(f.deps.dispatch).not.toHaveBeenCalled();
	});

	it('gives the oldest overlapping identity scope ownership of worktree tabs', async () => {
		const f = fixture();
		f.snapshot.owners.push({
			id: 'worktree',
			cwd: path.resolve('worktree'),
			parentSessionId: 'owner',
			isPianola: false,
			remote: false,
		});
		const tab = f.tab('worktree-tab', 'worktree');
		const selected = {
			...f.scope,
			id: otherScopeId,
			createdAt: 0,
			selection: { ...f.scope.selection! },
		};
		f.saveScopes(f.scope, selected);
		await f.cycle();
		await f.cycle(otherScopeId);
		f.history(tab, [message('worktree-ask')]);
		expect((await f.cycle()).iterations).toEqual([]);
		// Coverage inheritance does not widen a parent's exact project rule.
		expect((await f.cycle(otherScopeId)).iterations[0].result.decision).toMatchObject({
			action: 'escalate',
			matchedRuleId: null,
		});
		expect(f.deps.dispatch).not.toHaveBeenCalled();
		f.rules[0].scopeId = path.resolve('worktree');
		f.history(tab, [message('worktree-ask'), message('worktree-scoped-ask')]);
		expect((await f.cycle()).iterations).toEqual([]);
		expect((await f.cycle(otherScopeId)).issues).toEqual([]);
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.deps.dispatch).mock.calls[0][0]).toEqual({
			agentId: 'worktree',
			tabId: 'worktree-tab',
			projectPath: path.resolve('worktree'),
		});
		expect(vi.mocked(f.deps.dispatch).mock.calls[0][2].scopeId).toBe(otherScopeId);
	});

	it.each(['closed', 'paused', 'busy', 'disabled', 'answered', 'owner-changed'] as const)(
		'rejects a %s target discovered during final recheck',
		async (change) => {
			const f = fixture();
			const tab = f.tab();
			await f.cycle();
			f.history(tab, [message('fresh')]);
			const readTranscript = f.deps.readTranscript;
			f.deps.readTranscript = async (target) => {
				const history = await readTranscript(target);
				if (change === 'closed') f.snapshot.tabs = [];
				if (change === 'paused') tab.paused = true;
				if (change === 'busy') tab.busy = true;
				if (change === 'disabled') {
					f.scope.enabled = false;
					f.saveScopes(f.scope);
				}
				if (change === 'answered') tab.cursor = { id: 'human-answer', count: 2, textLength: 10 };
				if (change === 'owner-changed') f.snapshot.owners[0].parentSessionId = 'missing-parent';
				return history;
			};
			expect((await f.cycle()).issues).toHaveLength(1);
			expect(f.deps.dispatch).not.toHaveBeenCalled();
			expect(f.checkpoint().tabs[0].unresolvedIntent).toBeNull();
		}
	);
});

describe('scope transcript and delivery safety', () => {
	it('persists an incomplete-census failure without enrolling any tab', async () => {
		const f = fixture();
		f.snapshot.complete = false;
		await expect(f.cycle()).rejects.toThrow('Incomplete');
		expect(f.store.readScopeCheckpoint(scopeId)).toMatchObject({
			status: 'suspended',
			tabs: [],
			lastCycleError: {
				reason: expect.stringContaining('Incomplete'),
				observedAt: expect.any(Number),
			},
		});
	});

	it.each(['gap', 'wrong-tab', 'duplicate-id', 'missing-id', 'wrong-count'] as const)(
		'rejects %s transcript evidence and leaves another tab able to progress',
		async (failure) => {
			const f = fixture();
			const broken = f.tab('broken');
			const healthy = f.tab('healthy');
			f.history(broken, [message('baseline')]);
			await f.cycle();
			f.history(broken, [message('baseline'), message('fresh')]);
			f.history(healthy, [message('healthy-ask')]);
			const readTranscript = f.deps.readTranscript;
			f.deps.readTranscript = async (target) => {
				const history = await readTranscript(target);
				if (target.tabId !== 'broken') return history;
				if (failure === 'gap') history.messages = [message('replaced'), message('fresh')];
				if (failure === 'wrong-tab') history.tabId = 'someone-else';
				if (failure === 'duplicate-id') history.messages = [message('fresh'), message('fresh')];
				if (failure === 'missing-id') history.messages = [message(''), message('fresh')];
				if (failure === 'wrong-count') history.messages = [message('fresh')];
				return history;
			};
			const result = await f.cycle();
			expect(result.issues).toHaveLength(1);
			expect(result.iterations.map((iteration) => iteration.tabId)).toEqual(['healthy']);
			expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		}
	);

	it('retries only definitive rejections and stops at the existing watcher limit', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('fresh')]);
		vi.mocked(f.deps.dispatch).mockResolvedValue({
			status: 'rejected',
			error: 'admission refused',
		});
		await f.cycle();
		expect(f.checkpoint().tabs[0]).toMatchObject({
			unresolvedIntent: null,
			state: { pendingRetry: { attempts: 1 } },
		});
		for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) await f.cycle();
		expect(f.deps.dispatch).toHaveBeenCalledTimes(MAX_DISPATCH_ATTEMPTS);
		expect(f.deps.watch.notify).toHaveBeenCalledTimes(1);
	});

	it.each(['unknown', 'throw', 'outcome-write'] as const)(
		'latches %s delivery across restart, disable and close',
		async (failure) => {
			const f = fixture();
			const tab = f.tab();
			await f.cycle();
			f.history(tab, [message('fresh')]);
			vi.mocked(f.deps.dispatch).mockImplementation(async () => {
				if (failure === 'throw') throw new Error('connection lost after send');
				if (failure === 'outcome-write')
					f.deps.watch.recordDecision = () => {
						throw new Error('audit disk full');
					};
				return failure === 'unknown'
					? { status: 'unknown', error: 'no receipt' }
					: { status: 'accepted' };
			});
			const recordDecision = f.deps.watch.recordDecision;
			if (failure === 'outcome-write') {
				await expect(f.cycle()).rejects.toThrow('audit disk full');
				f.deps.watch.recordDecision = recordDecision;
			} else {
				expect((await f.cycle()).issues).toHaveLength(1);
			}
			expect(f.checkpoint().tabs[0].unresolvedIntent?.messageId).toBe('fresh');
			f.scope.enabled = false;
			f.saveScopes(f.scope);
			await f.cycle();
			f.scope.enabled = true;
			f.saveScopes(f.scope);
			f.snapshot.tabs = [];
			await f.cycle();
			f.snapshot.tabs = [tab];
			expect((await f.cycle()).issues.join(' ')).toContain('Delivery outcome unknown');
			expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		}
	);

	it('stops the cycle if the durable intent cannot be persisted', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('fresh')]);
		const write = f.store.writeScopeCheckpoint;
		vi.spyOn(f.store, 'writeScopeCheckpoint').mockImplementation((checkpoint) => {
			if (checkpoint.tabs.some((tab) => tab.unresolvedIntent)) throw new Error('intent disk full');
			write(checkpoint);
		});
		await expect(f.cycle()).rejects.toThrow('intent disk full');
		expect(f.deps.dispatch).not.toHaveBeenCalled();
	});

	it('keeps an unresolved attempt when ownership transfers away and back', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('uncertain-ask')]);
		vi.mocked(f.deps.dispatch).mockResolvedValue({ status: 'unknown', error: 'no receipt' });
		await f.cycle();
		const selected: PianolaSupervisedTarget = {
			...f.scope,
			id: otherScopeId,
			createdAt: 0,
			selection: { ...f.scope.selection! },
		};
		f.saveScopes(f.scope, selected);
		await f.cycle();
		await f.cycle(otherScopeId);
		expect(f.checkpoint().tabs[0]).toMatchObject({
			status: 'suspended',
			unresolvedIntent: { messageId: 'uncertain-ask' },
		});
		f.saveScopes(f.scope);
		expect((await f.cycle()).issues.join(' ')).toContain('Delivery outcome unknown');
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
	});

	it('retains an accepted-send intent if persisting the resulting watcher state fails', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('fresh')]);
		const write = f.store.writeScopeCheckpoint;
		vi.spyOn(f.store, 'writeScopeCheckpoint').mockImplementation((checkpoint) => {
			if (checkpoint.tabs[0]?.state.lastHandledMessageId === 'fresh')
				throw new Error('checkpoint disk full');
			write(checkpoint);
		});
		await expect(f.cycle()).rejects.toThrow('checkpoint disk full');
		expect(f.store.readDecisions()).toMatchObject([{ dispatched: true }]);
		expect(f.checkpoint().tabs[0].unresolvedIntent?.messageId).toBe('fresh');
		await f.cycle();
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
	});

	it('hands an uncovered ask to the manager once and preserves timeout progress across cycles', async () => {
		const f = fixture();
		const tab = f.tab();
		f.rules.splice(0);

		let time = Date.parse('2026-10-28T00:00:00.000Z');
		f.deps.watch.now = () => new Date(time).toISOString();
		f.deps.watch.resolveProfile = () => ({ profile: 'Use task authority.', updatedAt: 1 });
		vi.mocked(f.deps.requestJudgment!).mockImplementation(async (_request, guard) => {
			const record = f.store.readDecisions().find((entry) => entry.id === guard.decisionId)!;
			f.store.appendDecision(
				updatePianolaDecision(
					record,
					{
						delivery: 'accepted',
						managerTabId: 'manager-tab',
						deadlineAt: time + 60_000,
					},
					f.deps.watch.now()
				)
			);
			return { status: 'accepted' };
		});
		await f.cycle();
		f.history(tab, [message('uncovered')]);
		await f.cycle();
		expect(f.deps.requestJudgment).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.deps.requestJudgment!).mock.calls[0][1]).toMatchObject({
			scopeId,
			messageId: 'uncovered',
		});
		await f.cycle();
		expect(f.store.readDecisions()[0].lifecycle?.status).toBe('mira_processing');
		time += 60_001;
		await f.cycle();
		expect(f.store.readDecisions()[0].lifecycle?.status).toBe('waiting_human');
		expect(f.deps.requestJudgment).toHaveBeenCalledTimes(1);
		expect(f.deps.watch.notify).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'handoff_timeout' })
		);
	});

	it('escalates high-risk asks with source identity without sending a reply or judgment request', async () => {
		const f = fixture();
		const tab = f.tab();
		f.deps.watch.resolveProfile = () => ({
			profile: 'Approve routine work.',
			updatedAt: 1,
			pairCount: 1,
		});
		await f.cycle();
		f.history(tab, [message('high-risk', 'Should I deploy to production?')]);
		await f.cycle();
		await f.cycle();
		expect(f.deps.watch.notify).toHaveBeenCalledTimes(1);
		expect(f.deps.watch.notify).toHaveBeenCalledWith(
			expect.objectContaining({
				highRisk: true,
				kind: 'escalate',
				target: { agentId: 'owner', tabId: 'existing', projectPath: projectRoot },
			})
		);
		expect(f.deps.dispatch).not.toHaveBeenCalled();
		expect(f.deps.requestJudgment).not.toHaveBeenCalled();
	});
});

describe('native scope snapshot contract', () => {
	const response = () => ({
		success: true,
		supervisionVersion: 1,
		complete: true,
		capturedAt: 100,
		owners: [
			{ id: 'owner', cwd: projectRoot, parentSessionId: null, isPianola: false, remote: false },
		],
		sessions: [
			{
				agentId: 'owner',
				tabId: 'tab',
				createdAt: 1,
				supervision: {
					cwd: projectRoot,
					parentSessionId: null,
					isPianola: false,
					remote: false,
					lineageComplete: true,
					paused: false,
					busy: false,
					consult: false,
					ephemeral: false,
					cursorAvailable: true,
					cursor: null,
				},
			},
		],
	});

	it.each([
		[
			'old response',
			(raw: any) => {
				delete raw.supervisionVersion;
			},
		],
		[
			'failed response',
			(raw: any) => {
				raw.success = false;
			},
		],
		[
			'incomplete census',
			(raw: any) => {
				raw.complete = false;
			},
		],
		[
			'missing capture time',
			(raw: any) => {
				delete raw.capturedAt;
			},
		],
		[
			'duplicate owners',
			(raw: any) => {
				raw.owners.push(raw.owners[0]);
			},
		],
		[
			'missing owner',
			(raw: any) => {
				raw.owners = [];
			},
		],
		[
			'foreign owner metadata',
			(raw: any) => {
				raw.sessions[0].supervision.cwd = '/foreign';
			},
		],
		[
			'missing pause metadata',
			(raw: any) => {
				delete raw.sessions[0].supervision.paused;
			},
		],
		[
			'missing liveness metadata',
			(raw: any) => {
				delete raw.sessions[0].supervision.busy;
			},
		],
		[
			'missing lineage metadata',
			(raw: any) => {
				delete raw.sessions[0].supervision.lineageComplete;
			},
		],
		[
			'invalid cursor',
			(raw: any) => {
				raw.sessions[0].supervision.cursor = { id: '', count: 0, textLength: 0 };
			},
		],
		[
			'missing creation time',
			(raw: any) => {
				delete raw.sessions[0].createdAt;
			},
		],
		[
			'ambiguous history lookup',
			(raw: any) => {
				raw.sessions.push({ ...raw.sessions[0], agentId: 'other' });
			},
		],
	])('rejects %s before scope baselines can advance', (_label, mutate) => {
		const raw = response();
		mutate(raw);
		expect(() => pianolaScopeSnapshotFromDesktop(raw)).toThrow();
	});

	it('accepts a complete empty census, retaining tabless owners', () => {
		const raw = response();
		raw.sessions = [];
		expect(pianolaScopeSnapshotFromDesktop(raw)).toEqual({
			capturedAt: 100,
			complete: true,
			owners: raw.owners,
			tabs: [],
		});
	});
});

describe('current coverage failure producers', () => {
	it('persists a history failure, retries an unchanged cursor and clears only after successful access', async () => {
		const f = fixture();
		const broken = f.tab('broken');
		const healthy = f.tab('healthy');
		await f.cycle();
		f.history(broken, [message('broken-ask')]);
		f.history(healthy, [message('healthy-ask')]);
		const read = f.deps.readTranscript;
		f.deps.readTranscript = vi.fn(async (target) => {
			if (target.tabId === 'broken') throw new Error('fixture history unavailable');
			return read(target);
		});
		expect((await f.cycle()).issues).toContain('owner/broken: fixture history unavailable');
		expect(f.checkpoint().tabs.find((t) => t.tabId === 'broken')?.coverage).toMatchObject({
			status: 'blocked',
			reason: 'fixture history unavailable',
			nextActor: 'operator',
			nextAction: expect.stringContaining('Restore transcript access'),
		});
		expect(f.checkpoint().tabs.find((t) => t.tabId === 'healthy')?.coverage?.status).toBe(
			'covered'
		);
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
		await f.cycle();
		expect(f.checkpoint().tabs.find((t) => t.tabId === 'broken')?.coverage?.status).toBe('blocked');
		f.deps.readTranscript = read;
		await f.cycle();
		expect(f.checkpoint().tabs.find((t) => t.tabId === 'broken')?.coverage).toMatchObject({
			status: 'covered',
			reason: 'Transcript cursor verified',
		});
		expect(f.deps.dispatch).toHaveBeenCalledTimes(2);
	});

	it.each(['incomplete', 'unavailable'] as const)(
		'persists %s census failure without refreshing census time',
		async (kind) => {
			const f = fixture();
			f.tab();
			await f.cycle();
			const censusAt = f.checkpoint().lastSnapshotAt;
			const read = f.deps.readSnapshot;
			if (kind === 'incomplete') f.snapshot.complete = false;
			else
				f.deps.readSnapshot = async () => {
					throw new Error('fixture census unavailable');
				};
			await expect(f.cycle()).rejects.toThrow();
			expect(f.checkpoint()).toMatchObject({
				lastSnapshotAt: censusAt,
				lastCycleError: {
					reason: expect.stringMatching(/Incomplete|fixture census unavailable/),
					observedAt: expect.any(Number),
				},
			});
			f.snapshot.complete = true;
			f.deps.readSnapshot = read;
			await f.cycle();
			expect(f.checkpoint().lastCycleError).toBeUndefined();
			expect(f.checkpoint().lastSnapshotAt).toBeGreaterThan(censusAt!);
		}
	);

	it('persists iteration delivery refusal and clears it on a bounded successful retry', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('fresh')]);
		vi.mocked(f.deps.dispatch).mockResolvedValueOnce({
			status: 'rejected',
			error: 'fixture delivery refused',
		});
		await f.cycle();
		expect(f.checkpoint().tabs[0].coverage).toMatchObject({
			status: 'blocked',
			nextActor: 'operator',
			reason: expect.stringContaining('fixture delivery refused'),
		});
		await f.cycle();
		expect(f.checkpoint().tabs[0].coverage?.status).toBe('covered');
		expect(f.deps.dispatch).toHaveBeenCalledTimes(2);
	});

	it.each(['paused', 'excluded', 'closed'] as const)(
		'records %s membership with an explicit resume/owner action',
		async (kind) => {
			const f = fixture();
			const tab = f.tab();
			await f.cycle();
			if (kind === 'paused') tab.paused = true;
			if (kind === 'closed') f.snapshot.tabs = [];
			if (kind === 'excluded') {
				f.scope.selection.excludedAgentIds.push('owner');
				f.saveScopes(f.scope);
			}
			await f.cycle();
			expect(f.checkpoint().tabs[0].coverage).toMatchObject({
				status: kind,
				nextActor: 'none',
				nextAction: expect.any(String),
			});
			expect(f.deps.dispatch).not.toHaveBeenCalled();
		}
	);
});

describe('RF review regressions', () => {
	it('RF01 rebinds a pending human ask after an unrelated selection edit', async () => {
		const f = fixture();
		f.rules.splice(0);
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('pending')]);
		await f.cycle();
		const original = f.store.readDecisions()[0];
		expect(original.lifecycle?.status).toBe('waiting_human');
		f.scope.selection.agentIds.push('another-owner');
		f.saveScopes(f.scope);
		await f.cycle();
		const records = f.store.readDecisions();
		expect(records).toHaveLength(1);
		expect(records[0].id).toBe(original.id);
		expect(records[0].lifecycle?.guard.configurationFingerprint).toBe(
			pianolaScopeConfigurationFingerprint(f.scope)
		);
		expect(f.deps.dispatch).not.toHaveBeenCalled();
	});

	it('RF01 retains the accepted manager handoff after selection changes', async () => {
		const f = fixture();
		f.rules.splice(0);
		f.deps.watch.resolveProfile = () => ({ profile: 'Use task authority.', updatedAt: 1 });
		vi.mocked(f.deps.requestJudgment!).mockImplementation(async (_request, guard) => {
			const record = f.store.readDecisions().find((entry) => entry.id === guard.decisionId)!;
			f.store.appendDecision(
				updatePianolaDecision(
					record,
					{
						delivery: 'accepted',
						managerTabId: 'manager-tab',
						deadlineAt: Date.parse('2026-10-29T00:00:00Z'),
					},
					f.deps.watch.now()
				)
			);
			return { status: 'accepted' };
		});
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [message('manager-ask')]);
		await f.cycle();
		f.scope.selection.agentIds.push('another-owner');
		f.saveScopes(f.scope);
		await f.cycle();
		const record = f.store.readDecisions()[0];
		expect(record.lifecycle).toMatchObject({
			status: 'mira_processing',
			managerTabId: 'manager-tab',
		});
		expect(record.lifecycle?.guard.configurationFingerprint).toBe(
			pianolaScopeConfigurationFingerprint(f.scope)
		);
		expect(f.deps.requestJudgment).toHaveBeenCalledTimes(1);
	});

	it('RF01 keeps an unknown delivery claim across a selection edit', async () => {
		const f = fixture();
		const tab = f.tab();
		await f.cycle();
		vi.mocked(f.deps.dispatch).mockResolvedValue({ status: 'unknown', error: 'receipt lost' });
		f.history(tab, [message('unknown-ask')]);
		await f.cycle();
		f.scope.selection.agentIds.push('another-owner');
		f.saveScopes(f.scope);
		await f.cycle();
		expect(f.checkpoint().tabs[0].unresolvedIntent).toMatchObject({ messageId: 'unknown-ask' });
		expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
	});

	it.each(['removed-owner', 'changed-cursor'] as const)(
		'RF01 does not rebind a pending decision after %s',
		async (change) => {
			const f = fixture();
			f.rules.splice(0);
			const tab = f.tab();
			await f.cycle();
			f.history(tab, [message('pending')]);
			await f.cycle();
			const original = f.store.readDecisions()[0];
			f.scope.selection.agentIds.push('another-owner');
			if (change === 'removed-owner') f.scope.selection.excludedAgentIds.push('owner');
			else f.history(tab, [message('different', 'No question here.')]);
			f.saveScopes(f.scope);
			await f.cycle();
			const existing = f.store.readDecisions().find((record) => record.id === original.id)!;
			expect(existing.lifecycle?.guard.configurationFingerprint).toBe(
				original.lifecycle?.guard.configurationFingerprint
			);
			expect(f.deps.dispatch).not.toHaveBeenCalled();
		}
	);

	it('RF06 excludes a selected ancestor and its descendants only within that selection', () => {
		const f = fixture();
		f.snapshot.owners.push({
			id: 'child',
			cwd: projectRoot,
			parentSessionId: 'owner',
			isPianola: false,
			remote: false,
		});
		const tab = f.tab('child-tab', 'child');
		f.scope.selection.excludedAgentIds.push('owner');
		expect(resolvePianolaScopeOwnership(tab, f.snapshot.owners, [f.scope], []).kind).toBe(
			'excluded'
		);
		const other = {
			...f.scope,
			id: otherScopeId,
			selection: { ...f.scope.selection, excludedAgentIds: [] },
		};
		expect(resolvePianolaScopeOwnership(tab, f.snapshot.owners, [f.scope, other], [])).toEqual({
			kind: 'scope',
			scopeId: otherScopeId,
		});
		other.managerAgentId = 'owner';
		expect(resolvePianolaScopeOwnership(tab, f.snapshot.owners, [f.scope, other], []).kind).toBe(
			'excluded'
		);
	});

	it('RF03 persists an oversized question without its optional display text', async () => {
		const f = fixture();
		f.rules.splice(0);
		const tab = f.tab();
		await f.cycle();
		f.history(tab, [
			{
				...message('huge', 'x'.repeat(70000) + ' Should I continue?'),
				awaitingInput: { kind: 'question', prompt: 'Should I continue?' },
			},
		]);
		const result = await f.cycle();
		expect(result.issues.join(' ')).not.toContain('oversized Pianola decision lifecycle');
		const records = f.store.readDecisions();
		expect(records).toHaveLength(1);
		expect(records[0].classification.questionText).toBeUndefined();
		expect(records[0].lifecycle?.status).toBe('waiting_human');
	});

	it('RF02 preserves a host suspension after a resumed checkpoint is written', async () => {
		const f = fixture();
		const tab = f.tab();
		const rule = f.rules.pop()!;
		await f.cycle();
		f.history(tab, [message('pending')]);
		await f.cycle();
		const checkpoint = f.checkpoint();
		checkpoint.status = 'suspended';
		f.store.writeScopeCheckpoint(checkpoint);
		const read = f.store.readScopeCheckpoint;
		const write = f.store.writeScopeCheckpoint;
		let armedWritten = false;
		f.deps.store = {
			...f.store,
			writeScopeCheckpoint(value) {
				write(value);
				if (value.status === 'armed') armedWritten = true;
			},
			readScopeCheckpoint(id) {
				const value = read(id);
				if (armedWritten && value) {
					value.status = 'suspended';
					write(value);
				}
				return value;
			},
		};
		tab.busy = false;
		f.history(tab, [message('during-resume')]);
		await f.cycle();
		expect(f.checkpoint().status).toBe('suspended');
		expect(f.deps.dispatch).not.toHaveBeenCalled();
		// The next enable must baseline activity accumulated while suspended.
		f.deps.store = f.store;
		f.rules.push(rule);
		tab.busy = false;
		await f.cycle();
		expect(f.deps.dispatch).not.toHaveBeenCalled();
	});

	it.each([true, false])('RF06 ignores unrelated scope exclusions when enabled=%s', (enabled) => {
		const f = fixture();
		const tab = f.tab();
		const unrelated = {
			...f.scope,
			id: otherScopeId,
			enabled,
			selection: { ...f.scope.selection, agentIds: ['other'], excludedAgentIds: ['owner'] },
		};
		expect(resolvePianolaScopeOwnership(tab, f.snapshot.owners, [f.scope, unrelated], [])).toEqual({
			kind: 'scope',
			scopeId,
		});
		f.scope.selection.excludedAgentIds.push('owner');
		expect(
			resolvePianolaScopeOwnership(tab, f.snapshot.owners, [f.scope, unrelated], []).kind
		).toBe('excluded');
		expect(
			resolvePianolaScopeOwnership(
				tab,
				f.snapshot.owners,
				[f.scope, unrelated],
				[{ agentId: 'owner', tabId: tab.tabId, enabled: true }]
			)
		).toEqual({ kind: 'explicit-watch' });
	});
});
