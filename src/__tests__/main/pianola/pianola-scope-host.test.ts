import * as os from 'os';
/** Real CLI connection, bridge dispatch, IPC owner adapter and locked fixture registry. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
import path from 'node:path';
import { once, EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import * as mainStore from '../../../main/pianola/pianola-store-main';
import { resolvePianolaDecision } from '../../../main/pianola/pianola-decisions';
import { classifyMessages } from '../../../shared/pianola/pianola-classifier';
import { reconcilePianolaDecision } from '../../../shared/pianola/pianola-decision-lifecycle';
import { PianolaSupervisor } from '../../../main/pianola/pianola-supervisor';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
	startPianolaDecision,
	updatePianolaDecision,
} from '../../../shared/pianola/pianola-decision-lifecycle';
import { resolvePianolaScopeOwnership } from '../../../shared/pianola/pianola-scope';
import { canonicalJson } from '../../../shared/canonicalJson';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import {
	runPianolaScopeCycle,
	admitPianolaScopeReply,
	type PianolaScopeCycleDeps,
	type PianolaScopeSnapshot,
} from '../../../shared/pianola/pianola-scope-cycle';

const { handlers, native } = vi.hoisted(() => {
	const sender = { mainFrame: {}, isDestroyed: (): boolean => false, getType: () => 'window' };
	return {
		handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
		native: { sender, window: { webContents: sender, isDestroyed: (): boolean => false } },
	};
});
vi.mock('electron', () => ({
	app: {
		getPath: () => {
			throw new Error('Fixture data directory required');
		},
	},
	ipcMain: {
		_invokeHandlers: handlers,
		handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) =>
			handlers.set(channel, fn),
		listenerCount: () => 0,
	},
}));
import {
	registerPianolaHandlers,
	type PianolaSupervisorSnapshot,
} from '../../../main/ipc/handlers/pianola';
import { HostCallerRuns, hostCallerRuns } from '../../../main/agent-run/caller-identity';
import { handleBridgeInvoke } from '../../../main/web-server/handlers/bridgeHandlers';
import {
	pianolaSuperviseList,
	pianolaSuperviseScope,
} from '../../../cli/commands/pianola-supervise';

let directory: string;
let server: WebSocketServer;
let store: ReturnType<typeof createPianolaFsStore>;
let census: PianolaScopeSnapshot;
let feature: boolean;
let desktopOwner: boolean;
let fence: boolean;
let confirm: ReturnType<
	typeof vi.fn<(window: unknown, detail: string, signal: AbortSignal) => Promise<boolean>>
>;
let callerActive: boolean;
let callers: HostCallerRuns;
let boundClient: { cliAuthenticated: boolean } | undefined;
let clientUser: { id: string; username: string; displayName: string } | undefined;
let logs: ReturnType<typeof vi.spyOn>;
const scopeId = '11111111-1111-4111-8111-111111111111';
const target = (): PianolaSupervisedTarget => ({
	id: scopeId,
	kind: 'watch-scope',
	enabled: true,
	createdAt: 1,
	managerAgentId: 'manager',
	selection: {
		label: 'Whole agent',
		mode: 'agents-and-groups',
		agentIds: ['agent'],
		groupIds: [],
		excludedAgentIds: [],
	},
});
const nativeSave = (value = target()) =>
	handlers.get('pianola:supervisor-add')!(
		{ sender: native.sender, senderFrame: native.sender.mainFrame },
		value
	) as Promise<PianolaSupervisorSnapshot>;
const cli = (overrides = {}) =>
	pianolaSuperviseScope({
		manager: 'manager',
		label: 'Whole agent',
		agents: 'agent',
		json: true,
		...overrides,
	});
const lastOutput = () => JSON.parse(String(logs.mock.calls.at(-1)![0]));

beforeEach(async () => {
	const root = os.tmpdir();
	fs.mkdirSync(root, { recursive: true });
	directory = fs.mkdtempSync(path.join(root, 'scope-host-'));
	vi.stubEnv('MAESTRO_USER_DATA', directory);
	vi.stubEnv('MAESTRO_CLI_HOST', '');
	vi.stubEnv('MAESTRO_CALLER_RUN_PROOF_FILE', '');
	feature = true;
	desktopOwner = true;
	fence = true;
	callerActive = true;
	callers = new HostCallerRuns();
	boundClient = undefined;
	vi.spyOn(hostCallerRuns, 'isRunClient').mockImplementation((client) =>
		callers.isRunClient(client)
	);
	vi.spyOn(hostCallerRuns, 'resolve').mockImplementation((client) => callers.resolve(client));
	confirm = vi.fn(async () => true);
	clientUser = undefined;
	process.exitCode = 0;
	logs = vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	store = createPianolaFsStore({ resolveDir: () => directory, indent: 2, trailingNewline: true });
	fs.writeFileSync(
		path.join(directory, 'maestro-settings.json'),
		JSON.stringify({ encoreFeatures: { pianola: true } })
	);
	census = {
		complete: true,
		capturedAt: 100,
		owners: ['agent', 'manager'].map((id) => ({
			id,
			cwd: path.join(directory, id),
			groupId: null,
			remote: false,
			isPianola: id === 'manager',
		})),
		tabs: [
			{
				agentId: 'agent',
				tabId: 'old',
				paused: false,
				consult: false,
				ephemeral: false,
				busy: true,
				createdAt: 1,
				cursorAvailable: true,
				cursor: { id: 'historic', count: 1, textLength: 20 },
			},
		],
	};
	registerPianolaHandlers({
		settingsStore: {
			get: (key) =>
				key === 'encoreFeatures'
					? { pianola: feature }
					: { desktopIsOwner: desktopOwner, ownerWebUserId: 'human' },
		},
		supervisor: {
			getHealth: () => [],
			canFenceLegacyWatch: () => fence,
			reconcile: vi.fn(),
		} as never,
		getAppWindows: () => [native.window as never],
		confirmScopeConfiguration: (...args) => confirm(...args),
		getWebServer: (() => ({ getPianolaScopeSnapshot: () => census })) as never,
	});
	server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	server.on('connection', (socket, request) => {
		const client = {
			id: 'fixture-cli',
			cli: true,
			cliAuthenticated: request.headers['x-maestro-cli-secret'] === 'fixture-secret',
			user: clientUser,
			socket,
			isAuthorized: () => callerActive,
		};
		const proof = request.headers['x-maestro-caller-run-proof'];
		if (proof) {
			callers.bind(client, proof);
			boundClient = client;
		}
		socket.on('message', (bytes) => {
			void handleBridgeInvoke(client, JSON.parse(String(bytes)), (_client, reply) =>
				socket.send(JSON.stringify(reply))
			);
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
	fs.writeFileSync(
		path.join(directory, 'cli-server.json'),
		JSON.stringify({
			port: address.port,
			token: 'fixture',
			cliSecret: 'fixture-secret',
			pid: process.pid,
			startedAt: Date.now(),
		})
	);
});
afterEach(async () => {
	callers?.stop();
	server?.clients.forEach((socket) => socket.terminate());
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	fs.rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe('owner scope configuration through production adapters', () => {
	it('describes a legacy scope when asking the owner to approve its replacement', async () => {
		store.writeSupervisorTargets([
			{
				...target(),
				selection: {
					label: 'Legacy project',
					mode: 'project',
					projectRoots: ['/project'],
					ownerRoots: { agent: '/project' },
					includeWorktrees: true,
					excludedAgentIds: [],
				},
			},
		]);
		await cli({ id: scopeId, requestOwnerApproval: true });
		expect(lastOutput().success).toBe(true);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][1]).toContain('Legacy scope: project');
		expect(confirm.mock.calls[0][1]).toContain('Project roots: /project');
		expect(confirm.mock.calls[0][1]).toContain('Agents: agent');
	});

	it('configures the first scope through CLI, bridge and one native confirmation, then reconciles silently', async () => {
		await cli({ requestOwnerApproval: true, futureLocalAgents: true });
		expect(lastOutput().success).toBe(true);
		expect(confirm).toHaveBeenCalledTimes(1);
		const saved = store.readSupervisorTargets()[0];
		expect(saved.selection).toMatchObject({ futureAgentBaselineIds: ['agent', 'manager'] });
		expect(saved.enabled).toBe(false);
		expect(confirm.mock.calls[0][1]).toContain('Manager: manager');
		expect(confirm.mock.calls[0][1]).toContain('Future local agents: Included');
		expect(confirm.mock.calls[0][1]).toContain('Supervision: Paused');
		expect(confirm.mock.calls[0][1]).not.toMatch(
			/enrollmentRevision|previousTargets|delegationPolicy/
		);
		await cli({ id: saved.id, futureLocalAgents: true, requestOwnerApproval: true });
		expect(lastOutput().success).toBe(true);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(store.readSupervisorTargets()).toHaveLength(1);
	});

	it('starts a native first scope paused when enabled is omitted', async () => {
		const result = (await handlers.get('pianola:supervisor-add')!(
			{ sender: native.sender, senderFrame: native.sender.mainFrame },
			{ ...target(), enabled: undefined }
		)) as PianolaSupervisorSnapshot;
		expect(result.migration?.status).toBe('registered');
		expect(store.readSupervisorTargets()[0].enabled).toBe(false);
		await cli({ id: scopeId, requestOwnerApproval: true });
		expect(lastOutput().success).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
		expect(store.readSupervisorTargets()[0].enabled).toBe(false);
	});

	it('approves selection and manager changes through the same locked service', async () => {
		await nativeSave();
		census.owners.push({ ...census.owners[1], id: 'manager2' });
		await cli({
			id: scopeId,
			agents: 'agent,manager',
			manager: 'manager2',
			requestOwnerApproval: true,
		});
		expect(lastOutput().success).toBe(true);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(store.readSupervisorTargets()[0].managerAgentId).toBe('manager2');
		expect(store.readSupervisorTargets()[0].delegationPolicy?.managerAgentId).toBe('manager2');
		expect(store.readSupervisorTargets()[0].enabled).toBe(true);
		expect(confirm.mock.calls[0][1]).toContain('Manager: manager2');
		expect(confirm.mock.calls[0][1]).toContain('Agents: agent, manager');
	});

	it
		.skipIf(!['linux', 'darwin'].includes(process.platform))
		.each(['active', 'ended', 'revoked', 'binding-removed'])(
		'revalidates a real bound CLI run after pending native approval: %s',
		async (kind) => {
			// As in plugin-tool-proof-storage tests, isolate private storage metadata
			// from group-writable developer checkout ancestors. Proof IO stays real.
			const ancestors = new Set<string>();
			for (let ancestor = path.dirname(directory); ; ancestor = path.dirname(ancestor)) {
				ancestors.add(ancestor);
				if (path.dirname(ancestor) === ancestor) break;
			}
			const actualLstat = (await vi.importActual<typeof import('fs')>('fs')).lstatSync;
			vi.mocked(fs.lstatSync).mockImplementation(((target: fs.PathLike) => {
				const stat = actualLstat(target);
				return ancestors.has(String(target))
					? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
							mode: stat.mode & ~0o022,
						})
					: stat;
			}) as typeof fs.lstatSync);
			const controller = new AbortController();
			let active = true;
			const proof = callers.issue(
				{ agentId: 'manager', tabId: 'caller-tab', spawnGeneration: 'generation' },
				{
					signal: controller.signal,
					assertActive: () => {
						if (!active) throw new Error('Run ended');
					},
				},
				directory
			);
			vi.stubEnv('MAESTRO_CALLER_RUN_PROOF_FILE', proof.runTokenFile);
			let approve!: (value: boolean) => void;
			let entered!: () => void;
			const waiting = new Promise<void>((resolve) => {
				entered = resolve;
			});
			confirm.mockImplementation(
				() =>
					new Promise<boolean>((resolve) => {
						approve = resolve;
						entered();
					})
			);
			const pending = cli({ id: scopeId, requestOwnerApproval: true });
			await waiting;
			expect(boundClient).toBeDefined();
			expect(callers.resolve(boundClient!)).toBeDefined();
			const before = store.readSupervisorTargets();
			const checkpoint = store.readScopeCheckpoint(scopeId);
			if (kind === 'ended') active = false;
			if (kind === 'revoked' || kind === 'binding-removed') proof.dispose();
			if (kind === 'binding-removed') {
				expect(callers.resolve(boundClient!)).toBeUndefined();
				expect(callers.isRunClient(boundClient!)).toBe(true);
			}
			expect(callerActive).toBe(true);
			expect([...server.clients].every((socket) => socket.readyState === 1)).toBe(true);
			approve(true);
			await pending;
			expect(lastOutput().success).toBe(kind === 'active');
			if (kind !== 'active') {
				expect(store.readSupervisorTargets()).toEqual(before);
				expect(store.readScopeCheckpoint(scopeId)).toEqual(checkpoint);
			} else {
				expect(store.readSupervisorTargets()[0]).toMatchObject({ enabled: false });
				expect(store.readSupervisorTargets()[0].delegationPolicy).toBeDefined();
			}
			proof.dispose();
		}
	);

	it('preserves an existing paused scope when CLI changes its manager', async () => {
		await nativeSave({ ...target(), enabled: false });
		census.owners.push({ ...census.owners[1], id: 'manager2' });
		await cli({ id: scopeId, manager: 'manager2', requestOwnerApproval: true });
		expect(lastOutput().success).toBe(true);
		expect(store.readSupervisorTargets()[0]).toMatchObject({
			enabled: false,
			managerAgentId: 'manager2',
		});
		expect(confirm.mock.calls[0][1]).toContain('Current configuration:');
		expect(confirm.mock.calls[0][1]).toContain('Proposed configuration:');
	});

	it.each(['cancel', 'registry', 'revoke', 'identity', 'window', 'unknown', 'rules', 'off'])(
		'refuses %s during native approval without committing',
		async (kind) => {
			confirm.mockImplementation(async () => {
				if (kind === 'registry')
					await store.updateSupervisorTargetsAsync(() => [{ ...target(), enabled: false }]);
				if (kind === 'revoke') callerActive = false;
				if (kind === 'identity') desktopOwner = false;
				if (kind === 'window') vi.spyOn(native.window, 'isDestroyed').mockReturnValue(true);
				if (kind === 'unknown') census.complete = false;
				if (kind === 'rules')
					fs.writeFileSync(path.join(directory, 'maestro-pianola-rules.json'), '{');
				if (kind === 'off') feature = false;
				return kind !== 'cancel';
			});
			await cli({ requestOwnerApproval: true });
			expect(lastOutput().success).toBe(false);
			expect(store.readSupervisorTargets()).toEqual(
				kind === 'registry' ? [{ ...target(), enabled: false }] : []
			);
			expect(store.readScopeCheckpoint(scopeId)).toBeNull();
		}
	);

	it('rejects changed and restored configuration using the existing enrollment revision', async () => {
		await nativeSave();
		const revision = store.readScopeCheckpoint(scopeId)!.enrollmentRevision;
		confirm.mockImplementation(async () => {
			await nativeSave({
				...target(),
				selection: { ...target().selection!, excludedAgentIds: ['agent'] },
			});
			await nativeSave();
			return true;
		});
		await cli({ id: scopeId, agents: 'agent,manager', requestOwnerApproval: true });
		expect(lastOutput().success).toBe(false);
		expect(store.readSupervisorTargets()[0].selection).toMatchObject({ agentIds: ['agent'] });
		expect(store.readScopeCheckpoint(scopeId)!.enrollmentRevision).toBeGreaterThan(revision!);
	});

	it('times out the dialog and ignores a later positive answer', async () => {
		const original = globalThis.setTimeout;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
			fn: (...args: unknown[]) => void,
			ms?: number,
			...args: unknown[]
		) => original(fn, ms === 60_000 ? 1 : ms, ...args)) as typeof setTimeout);
		let answer!: (value: boolean) => void;
		confirm.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				})
		);
		await cli({ requestOwnerApproval: true });
		expect(lastOutput().migration.status).toBe('Denied');
		expect(confirm.mock.calls[0][2].aborted).toBe(true);
		answer(true);
		await Promise.resolve();
		expect(store.readSupervisorTargets()).toEqual([]);
	});

	it('commits at most one of two approvals against the same prior revision', async () => {
		const pending: Array<(value: boolean) => void> = [];
		confirm.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					pending.push(resolve);
					if (pending.length === 2) pending.forEach((approve) => approve(true));
				})
		);
		await Promise.all([
			cli({ id: scopeId, requestOwnerApproval: true }),
			cli({ id: scopeId, requestOwnerApproval: true }),
		]);
		const outputs = logs.mock.calls.map(([line]: unknown[]) => JSON.parse(String(line)));
		expect(outputs.filter((output: { success?: boolean }) => output.success)).toHaveLength(1);
		expect(store.readSupervisorTargets()).toHaveLength(1);
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it('does not ask a restricted desktop to impersonate the configured web owner', async () => {
		desktopOwner = false;
		await cli({ requestOwnerApproval: true });
		expect(lastOutput().migration.status).toBe('Denied');
		expect(confirm).not.toHaveBeenCalled();
		expect(store.readSupervisorTargets()).toEqual([]);
	});

	it('rejects an expired approval without waiting for a real timer', async () => {
		const now = Date.now();
		confirm.mockImplementation(async () => {
			vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
			return true;
		});
		await cli({ requestOwnerApproval: true });
		expect(lastOutput().success).toBe(false);
		expect(store.readSupervisorTargets()).toEqual([]);
	});

	it('creates policy from verified native choice and actual rules, ignoring claimed policy', async () => {
		const rules = store.readRulesResult().rules;
		const response = await nativeSave({
			...target(),
			delegationPolicy: {
				version: 1,
				revision: 99,
				enabled: true,
				managerAgentId: 'manager',
				coverage: 'selected-agents',
				ruleSetRevision: 'forged',
			},
		});
		expect(response.migration?.status).toBe('registered');
		expect(store.readSupervisorTargets()[0].delegationPolicy).toEqual({
			version: 1,
			revision: 1,
			enabled: true,
			managerAgentId: 'manager',
			coverage: 'selected-agents',
			ruleSetRevision: createHash('sha256').update(canonicalJson(rules)).digest('hex'),
		});
		expect(store.readScopeCheckpoint(scopeId)?.tabs[0]).toMatchObject({
			baselineBusy: false,
			baseline: census.tabs[0].cursor,
		});
		await cli();
		expect(lastOutput()).toMatchObject({ success: true, target: { id: scopeId } });
	});

	it.each([
		{ paused: false, group: false },
		{ paused: false, group: true },
		{ paused: true, group: false },
		{ paused: true, group: true },
	])(
		'owner edits selection %j and fences a delayed old census across restart',
		async ({ paused, group }) => {
			await nativeSave({ ...target(), enabled: !paused });
			const original = store.readSupervisorTargets()[0];
			const checkpoint = store.readScopeCheckpoint(scopeId)!;
			checkpoint.tabs[0].unresolvedIntent = { decisionId: 'unknown', messageId: 'historic' };
			store.writeScopeCheckpoint(checkpoint);
			census.owners.push({ ...census.owners[0], id: 'added', groupId: 'team' });
			census.tabs.push({ ...census.tabs[0], agentId: 'added', tabId: 'added-old', paused });
			let release!: () => void;
			let entered!: () => void;
			const reached = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			const deps: PianolaScopeCycleDeps = {
				store,
				readSnapshot: async () => {
					const old = structuredClone(census);
					entered();
					await wait;
					return old;
				},
				readTranscript: vi.fn(async (t) => ({ ...t, messages: [] })),
				watch: {
					readRules: () => [],
					recordDecision: vi.fn(),
					now: () => new Date().toISOString(),
					genId: () => 'decision',
					log: vi.fn(),
					notify: vi.fn(),
				},
				dispatch: vi.fn(async () => ({ status: 'accepted' as const })),
			};
			// A paused cycle exits before census; resume only the fixture worker for
			// this interleaving, then restore the actual owner pause before saving.
			if (paused) store.upsertSupervisorTarget({ ...original, enabled: true });
			const pending = runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			const outcome = pending.catch((error: Error) => error);
			await reached;
			if (paused) store.upsertSupervisorTarget(original);
			census.capturedAt++;
			const edited = {
				...target(),
				selection: {
					...target().selection!,
					agentIds: group ? ['agent'] : ['agent', 'added'],
					groupIds: group ? ['team'] : [],
				},
			};
			expect((await nativeSave(edited)).migration?.status).toBe('registered');
			const configured = store.readSupervisorTargets()[0];
			expect(configured).toEqual({ ...original, selection: edited.selection });
			const enrolled = store.readScopeCheckpoint(scopeId)!;
			expect(enrolled.tabs[0]).toEqual(checkpoint.tabs[0]);
			expect(enrolled.tabs[1]).toMatchObject({
				agentId: 'added',
				baselineBusy: false,
				baseline: census.tabs[1].cursor,
			});
			release();
			expect(await outcome).toBeInstanceOf(Error);
			expect(store.readScopeCheckpoint(scopeId)).toEqual(enrolled);
			const reopened = createPianolaFsStore({ resolveDir: () => directory });
			expect(reopened.readScopeCheckpoint(scopeId)).toEqual(enrolled);
			expect(deps.dispatch).not.toHaveBeenCalled();
			// Exact owner/CLI reconciliation does not re-enroll.
			expect((await nativeSave(edited)).migration?.status).toBe('registered');
			await cli({ agents: group ? 'agent' : 'added,agent', groups: group ? 'team' : undefined });
			expect(lastOutput().success).toBe(true);
			expect(reopened.readScopeCheckpoint(scopeId)).toEqual(enrolled);
			store.upsertSupervisorTarget({ ...configured, enabled: true });
			census.tabs[1].paused = false;
			const historical = {
				id: 'historic',
				role: 'assistant' as const,
				source: 'ai' as const,
				content: 'Should I name it count or total?',
				timestamp: '2026-11-04T00:00:00Z',
			};
			census.tabs[1].cursor = {
				id: historical.id,
				count: 1,
				textLength: historical.content.length,
			};
			deps.store = reopened;
			deps.readSnapshot = async () => structuredClone(census);
			deps.readTranscript = async (t) => ({ ...t, messages: [historical] });
			deps.watch.recordDecision = (r) => store.appendDecision(r);
			store.writeRules([
				{
					id: 'naming',
					enabled: true,
					scope: 'global',
					match: { kinds: ['question'], maxRisk: 'low' },
					action: 'auto_answer',
					answer: 'Use count.',
					priority: 1,
					createdAt: 1,
					updatedAt: 1,
				},
			]);
			deps.watch.readRules = () => store.readRules();
			// Resume while still busy, then finish the same historical entry.
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			census.tabs[1].busy = false;
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			expect(deps.dispatch).not.toHaveBeenCalled();
			const fresh = { ...historical, id: 'new-question' };
			census.tabs[1].cursor = { id: fresh.id, count: 2, textLength: fresh.content.length };
			deps.readTranscript = async (t) => ({ ...t, messages: [historical, fresh] });
			deps.dispatch = vi.fn(async (_t, answer, guard) => {
				admitPianolaScopeReply(guard, answer, census, reopened);
				return { status: 'accepted' };
			});
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			expect(deps.dispatch).toHaveBeenCalledTimes(1);
		}
	);

	it('owner removal and re-add baselines only returning coverage and rejects stale checkpoint writes', async () => {
		await nativeSave();
		const old = store.readScopeCheckpoint(scopeId)!;
		const removed = {
			...target(),
			selection: { ...target().selection!, excludedAgentIds: ['agent'] },
		};
		expect((await nativeSave(removed)).migration?.status).toBe('registered');
		census.capturedAt++;
		census.tabs[0].cursor = { id: 'historical-again', count: 2, textLength: 40 };
		expect((await nativeSave()).migration?.status).toBe('registered');
		const current = store.readScopeCheckpoint(scopeId)!;
		expect(current.tabs[0]).toMatchObject({ baseline: census.tabs[0].cursor, baselineBusy: false });
		expect(() => store.writeScopeCheckpoint(old)).toThrow(/enrollment/i);
		expect(store.readScopeCheckpoint(scopeId)).toEqual(current);
	});

	it.each(['agent', 'group', 'exclude'])(
		'native owner changes %s selection and fences the actual send boundary',
		async (change) => {
			await nativeSave();
			store.writeRules([
				{
					id: 'naming',
					enabled: true,
					scope: 'global',
					match: { kinds: ['question'], maxRisk: 'low' },
					action: 'auto_answer',
					answer: 'Use count.',
					priority: 1,
					createdAt: 1,
					updatedAt: 1,
				},
			]);
			const messages = [
				{
					id: 'historic',
					role: 'assistant' as const,
					source: 'ai' as const,
					content: 'Working on the selected naming task.',
					timestamp: '2026-11-04T00:00:00Z',
				},
				{
					id: 'fresh',
					role: 'assistant' as const,
					source: 'ai' as const,
					content: 'Should I name it count or total?',
					timestamp: '2026-11-04T00:01:00Z',
				},
			];
			census.tabs[0].busy = false;
			census.tabs[0].cursor = { id: 'fresh', count: 2, textLength: messages[1].content.length };
			census.capturedAt++;
			census.owners[0].groupId = 'team';
			// Use the group as existing coverage for its removal variant.
			if (change === 'group') {
				const grouped = {
					...target(),
					selection: { ...target().selection!, agentIds: [], groupIds: ['team'] },
				};
				await nativeSave(grouped);
			}
			let sends = 0;
			const deps: PianolaScopeCycleDeps = {
				store,
				readSnapshot: async () => structuredClone(census),
				readTranscript: async (t) => ({ ...t, messages }),
				watch: {
					readRules: () => store.readRules(),
					recordDecision: (r) => store.appendDecision(r),
					now: () => '2026-11-04T00:01:00Z',
					genId: () => 'fresh-decision',
					log: vi.fn(),
					notify: vi.fn(),
				},
				dispatch: async (_t, answer, guard) => {
					const edited = {
						...target(),
						selection: {
							...target().selection!,
							agentIds: change === 'exclude' ? ['agent'] : ['other'],
							excludedAgentIds: change === 'exclude' ? ['agent'] : [],
						},
					};
					expect((await nativeSave(edited)).migration?.status).toBe('registered');
					expect(() => admitPianolaScopeReply(guard, answer, census, store)).toThrow();
					// Even remove/re-add (same configuration fingerprint) cannot admit
					// an old epoch's delayed answer.
					await nativeSave();
					expect(() => admitPianolaScopeReply(guard, answer, census, store)).toThrow();
					sends++;
					return { status: 'unknown', error: 'Fixture final boundary rejected old authority' };
				},
			};
			await expect(runPianolaScopeCycle(scopeId, deps, { dryRun: false })).rejects.toThrow(
				/enrollment/i
			);
			expect(sends).toBe(1);
			expect(store.readScopeCheckpoint(scopeId)?.tabs[0].unresolvedIntent).toMatchObject({
				decisionId: 'fresh-decision',
			});
		}
	);

	it('a bound web owner can edit selection while another user cannot', async () => {
		await nativeSave();
		for (const id of ['other', 'human']) {
			let reply: { ok: boolean; result: PianolaSupervisorSnapshot } | undefined;
			await handleBridgeInvoke(
				{ id: 'web', cli: false, user: { id, username: id, displayName: id } },
				{
					type: 'bridge.invoke',
					requestId: 2,
					channel: 'pianola:supervisor-add',
					args: [
						{
							...target(),
							selection: { ...target().selection!, excludedAgentIds: ['agent'] },
							ownerAuthorized: true,
						},
					],
				},
				(_client, response) => {
					reply = response as typeof reply;
				}
			);
			expect(reply?.result.migration?.status).toBe(
				id === 'human' ? 'registered' : 'NeedsConfiguration'
			);
		}
		expect(store.readSupervisorTargets()[0].selection?.excludedAgentIds).toEqual(['agent']);
	});

	it('only the current owner can change manager, retaining policy and fencing old enrollment', async () => {
		await nativeSave();
		const previous = store.readSupervisorTargets()[0];
		previous.enabled = false;
		previous.delegationPolicy!.enabled = false;
		store.upsertSupervisorTarget(previous);
		const oldCheckpoint = store.readScopeCheckpoint(scopeId)!;
		census.owners.push({ ...census.owners[1], id: 'new-manager' });
		desktopOwner = false;
		expect(
			(await nativeSave({ ...target(), managerAgentId: 'new-manager' })).migration?.status
		).toBe('NeedsConfiguration');
		desktopOwner = true;
		expect(
			(await nativeSave({ ...target(), managerAgentId: 'new-manager' })).migration?.status
		).toBe('registered');
		expect(store.readSupervisorTargets()[0]).toMatchObject({
			enabled: false,
			managerAgentId: 'new-manager',
			delegationPolicy: {
				...previous.delegationPolicy!,
				revision: 2,
				managerAgentId: 'new-manager',
			},
		});
		expect(() => store.writeScopeCheckpoint(oldCheckpoint)).toThrow(/enrollment/i);
	});

	it.each(['add', 'remove'])(
		'refuses an overlapping %s handover without any registry or checkpoint writes',
		async (operation) => {
			await nativeSave();
			census.owners.push({ ...census.owners[0], id: 'other' });
			census.tabs.push({ ...census.tabs[0], agentId: 'other', tabId: 'other-old' });
			store.upsertSupervisorTarget({
				...target(),
				id: '22222222-2222-4222-8222-222222222222',
				createdAt: operation === 'add' ? 0 : 2,
				selection: { ...target().selection!, agentIds: [operation === 'add' ? 'other' : 'agent'] },
			});
			const before = store.readSupervisorTargets();
			const checkpoint = store.readScopeCheckpoint(scopeId);
			const edited = {
				...target(),
				selection: {
					...target().selection!,
					agentIds: operation === 'add' ? ['agent', 'other'] : ['other'],
				},
			};
			expect((await nativeSave(edited)).migration?.status).toBe('NeedsConfiguration');
			expect(store.readSupervisorTargets()).toEqual(before);
			expect(store.readScopeCheckpoint(scopeId)).toEqual(checkpoint);
		}
	);

	it('reordered owner selection is a reconcile and keeps unknown delivery and baseline byte-for-byte', async () => {
		await nativeSave({
			...target(),
			selection: { ...target().selection!, agentIds: ['agent', 'other'] },
		});
		const old = store.readScopeCheckpoint(scopeId)!;
		old.tabs[0].unresolvedIntent = { decisionId: 'unknown', messageId: 'historic' };
		store.writeScopeCheckpoint(old);
		const before = fs.readFileSync(
			path.join(directory, `maestro-pianola-scope-${scopeId}.json`),
			'utf8'
		);
		expect(
			(
				await nativeSave({
					...target(),
					selection: { ...target().selection!, agentIds: ['other', 'agent'] },
				})
			).migration?.status
		).toBe('registered');
		expect(store.readScopeCheckpoint(scopeId)).toEqual(old);
		expect(
			fs.readFileSync(path.join(directory, `maestro-pianola-scope-${scopeId}.json`), 'utf8')
		).toBe(before);
	});

	it('rechecks native owner authority after waiting for the registry lock', async () => {
		const lock = path.join(directory, 'maestro-pianola-supervisor.json.lock');
		fs.writeFileSync(lock, `${process.pid}.fixture`);
		const pending = nativeSave();
		desktopOwner = false;
		fs.unlinkSync(lock);
		expect((await pending).migration?.status).toBe('NeedsConfiguration');
		expect(store.readSupervisorTargets()).toEqual([]);
		expect(store.readScopeCheckpoint(scopeId)).toBeNull();
	});

	it.each(['human', 'other'])(
		'uses the actual web owner binding for %s, ignoring payload authority',
		async (id) => {
			let reply: { ok: boolean; result: PianolaSupervisorSnapshot } | undefined;
			await handleBridgeInvoke(
				{ id: 'fixture-web', cli: false, user: { id, username: id, displayName: id } },
				{
					type: 'bridge.invoke',
					requestId: 1,
					channel: 'pianola:supervisor-add',
					args: [{ ...target(), principal: 'owner', actorId: 'desktop', ownerAuthorized: true }],
				},
				(_client, value) => {
					reply = value as typeof reply;
				}
			);
			expect(reply?.ok).toBe(true);
			expect(reply?.result.migration?.status).toBe(
				id === 'human' ? 'registered' : 'NeedsConfiguration'
			);
			expect(store.readSupervisorTargets()).toHaveLength(id === 'human' ? 1 : 0);
		}
	);

	it('CLI migrates the exact standing owner selection through the native fence and baseline', async () => {
		await nativeSave();
		store.upsertSupervisorTarget({
			id: 'legacy',
			kind: 'watch',
			enabled: true,
			createdAt: 0,
			agentId: 'agent',
			tabId: 'old',
		});
		await cli();
		expect(lastOutput()).toMatchObject({
			success: true,
			migration: { status: 'migrated', scopeId, watchIds: ['legacy'] },
		});
		expect(store.readSupervisorTargets().find((entry) => entry.id === 'legacy')).toMatchObject({
			enabled: false,
			migratedToScopeId: scopeId,
		});
		expect(store.readScopeCheckpoint(scopeId)?.tabs[0].baselineBusy).toBe(false);
		const before = fs.readFileSync(path.join(directory, 'maestro-pianola-supervisor.json'), 'utf8');
		const checkpoint = store.readScopeCheckpoint(scopeId);
		await cli();
		expect(lastOutput().migration.status).toBe('already-migrated');
		expect(fs.readFileSync(path.join(directory, 'maestro-pianola-supervisor.json'), 'utf8')).toBe(
			before
		);
		expect(store.readScopeCheckpoint(scopeId)).toEqual(checkpoint);
	});

	it('refuses CLI self-authorization with no stored owner choice, even with user/env claims', async () => {
		clientUser = { id: 'human', username: 'Owner', displayName: 'Owner' };
		vi.stubEnv('MAESTRO_AGENT_ID', 'manager');
		await cli();
		expect(lastOutput()).toMatchObject({
			success: false,
			migration: { status: 'NeedsConfiguration' },
		});
		expect(store.readSupervisorTargets()).toEqual([]);
		expect(store.readScopeCheckpoint(scopeId)).toBeNull();
	});

	it.each([{ manager: 'other' }, { agents: 'other' }, { exclude: 'agent' }])(
		'refuses changed CLI authority %j without writes',
		async (change) => {
			await nativeSave();
			const before = store.readSupervisorTargets();
			await cli(change);
			expect(lastOutput().migration.status).toBe('NeedsConfiguration');
			expect(store.readSupervisorTargets()).toEqual(before);
		}
	);

	it('deduplicates concurrent native owner registrations and retains a paused policy on CLI replay', async () => {
		const [first, second] = await Promise.all([
			nativeSave({ ...target(), enabled: false }),
			nativeSave({ ...target(), id: '22222222-2222-4222-8222-222222222222' }),
		]);
		expect(first.migration?.scopeId).toBe(second.migration?.scopeId);
		expect(store.readSupervisorTargets()).toHaveLength(1);
		const before = store.readSupervisorTargets();
		await Promise.all([cli(), cli()]);
		expect(store.readSupervisorTargets()).toEqual(before);
		expect(store.readSupervisorTargets()[0].enabled).toBe(false);
	});

	it('returns NeedsConfiguration for a restricted native owner and creates no consent', async () => {
		desktopOwner = false;
		expect((await nativeSave()).migration?.status).toBe('NeedsConfiguration');
		expect(store.readSupervisorTargets()).toEqual([]);
	});

	it('refuses a missing fence and feature-off at the host despite stale enabled CLI settings', async () => {
		await nativeSave();
		store.upsertSupervisorTarget({
			id: 'legacy',
			kind: 'watch',
			enabled: true,
			createdAt: 0,
			agentId: 'agent',
			tabId: 'old',
		});
		fence = false;
		const before = store.readSupervisorTargets();
		await cli();
		expect(lastOutput().migration).toMatchObject({
			status: 'NeedsConfiguration',
			reason: expect.stringContaining('fence'),
		});
		expect(store.readSupervisorTargets()).toEqual(before);
		feature = false;
		// CLI transport errors remain errors; intercept process.exit only for the assertion.
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('fixture-exit');
		});
		await expect(cli()).rejects.toThrow('fixture-exit');
		expect(store.readSupervisorTargets()).toEqual(before);
	});

	it.each(['unknown', 'intent', 'accepted'] as const)(
		'holds legacy %s until a native delivery acknowledgment',
		async (delivery) => {
			await nativeSave();
			store.upsertSupervisorTarget({
				id: 'legacy',
				kind: 'watch',
				enabled: true,
				createdAt: 0,
				agentId: 'agent',
				tabId: 'old',
			});
			const checkpoint = store.readScopeCheckpoint(scopeId)!;
			const now = '2026-11-04T18:00:00Z';
			const record = startPianolaDecision(
				{
					id: 'pending',
					agentId: 'agent',
					tabId: 'old',
					timestamp: now,
					dryRun: false,
					dispatched: false,
					classification: {
						kind: 'question',
						risk: 'low',
						topic: 'Proceed?',
						confidence: 'high',
						evidence: { messageId: 'historic', reason: 'fixture', structured: true },
					},
					decision: {
						action: 'auto_answer',
						answer: 'Yes',
						matchedRuleId: null,
						reason: 'fixture rule',
					},
				},
				{
					scopeId,
					configurationFingerprint: checkpoint.configurationFingerprint,
					bindingFingerprint: checkpoint.tabs[0].bindingFingerprint!,
					agentId: 'agent',
					tabId: 'old',
					messageId: 'historic',
					decisionId: 'pending',
					cursor: census.tabs[0].cursor!,
				},
				'manager',
				null
			);
			store.appendDecision(updatePianolaDecision(record, { delivery }, now));
			expect(store.readDecisions()).toHaveLength(1);
			await cli();
			expect(lastOutput().migration).toMatchObject({
				status: 'NeedsConfiguration',
				reason: expect.stringContaining('acknowledgment'),
			});
			expect(store.readSupervisorTargets().find((entry) => entry.id === 'legacy')?.enabled).toBe(
				true
			);
			// Keep a deliberately stale copy even when an unchanged intent update
			// returned the original object and append revised it in place.
			const staleRecord = { ...record, mutationRevision: undefined };
			// A stale ack cannot settle a newer durable mutation.
			expect(() =>
				store.appendDecision(
					updatePianolaDecision(
						staleRecord,
						{ delivery: 'accepted', acknowledgedAt: now, status: 'agent_running' },
						now
					)
				)
			).toThrow('mutation conflict');
			expect(store.readDecisions()[0].lifecycle?.acknowledgedAt).toBeUndefined();
			// The native receipt must continue from the current CAS row.
			store.appendDecision(
				updatePianolaDecision(
					store.readDecisions()[0],
					{ delivery: 'accepted', acknowledgedAt: now, status: 'agent_running' },
					now
				)
			);
			await cli();
			expect(lastOutput().migration.status).toBe('migrated');
			expect(store.readDecisions()[0].lifecycle?.acknowledgedAt).toBe(now);
		}
	);

	it('preserves an owner-disabled standing policy and refuses CLI reactivation', async () => {
		await nativeSave();
		const existing = store.readSupervisorTargets()[0];
		store.upsertSupervisorTarget({
			...existing,
			enabled: false,
			delegationPolicy: { ...existing.delegationPolicy!, enabled: false },
		});
		const before = store.readSupervisorTargets();
		await cli();
		expect(lastOutput().migration.status).toBe('NeedsConfiguration');
		expect(store.readSupervisorTargets()).toEqual(before);
		await nativeSave();
		expect(store.readSupervisorTargets()).toEqual(before);
	});

	it('adds host policy to an existing owner selection without reactivating it', async () => {
		store.upsertSupervisorTarget({ ...target(), enabled: false });
		expect((await nativeSave()).migration?.status).toBe('registered');
		expect(store.readSupervisorTargets()[0]).toMatchObject({
			enabled: false,
			delegationPolicy: { enabled: true },
		});
		expect(store.readScopeCheckpoint(scopeId)?.tabs[0].baselineBusy).toBe(false);
	});

	it('requires an existing native manager and a readable rule set without side effects', async () => {
		census.owners = census.owners.filter((owner) => owner.id !== 'manager');
		expect((await nativeSave()).migration?.status).toBe('NeedsConfiguration');
		expect(store.readSupervisorTargets()).toEqual([]);
		census.owners.push({
			id: 'manager',
			cwd: directory,
			groupId: null,
			isPianola: true,
			remote: false,
		});
		fs.writeFileSync(path.join(directory, 'maestro-pianola-rules.json'), '{invalid');
		expect((await nativeSave()).migration?.status).toBe('NeedsConfiguration');
		expect(store.readSupervisorTargets()).toEqual([]);
	});

	it('retains unresolved delivery and refuses handover rather than clearing it on retry', async () => {
		await nativeSave();
		store.upsertSupervisorTarget({
			id: 'legacy',
			kind: 'watch',
			enabled: true,
			createdAt: 0,
			agentId: 'agent',
			tabId: 'old',
		});
		const checkpoint = store.readScopeCheckpoint(scopeId)!;
		checkpoint.tabs[0].unresolvedIntent = {
			decisionId: 'unknown',
			messageId: 'historic',
			admitted: true,
		};
		store.writeScopeCheckpoint(checkpoint);
		await cli();
		expect(lastOutput().migration).toMatchObject({
			status: 'NeedsConfiguration',
			reason: expect.stringContaining('unresolved delivery'),
		});
		expect(store.readScopeCheckpoint(scopeId)).toEqual(checkpoint);
		expect(store.readSupervisorTargets().find((entry) => entry.id === 'legacy')?.enabled).toBe(
			true
		);
	});
});

describe('standing future local agents', () => {
	it('CLI live status reads the host registry and coverage snapshot over the bridge', async () => {
		await nativeSave();
		await pianolaSuperviseList({ live: true, json: true });
		expect(lastOutput().targets).toEqual([expect.objectContaining({ id: scopeId })]);
		expect(lastOutput().health).toEqual(expect.any(Array));
		expect(lastOutput().checkpoints).toEqual([expect.objectContaining({ scopeId })]);
	});

	it('CLI reconciles an existing future selection without granting authority to change it', async () => {
		const future = target();
		future.selection = { ...future.selection!, mode: 'agents-and-groups', futureLocalAgents: true };
		await nativeSave(future);
		const before = store.readSupervisorTargets();
		await cli({ id: scopeId, futureLocalAgents: true });
		expect(lastOutput().success).toBe(true);
		expect(store.readSupervisorTargets()).toEqual(before);
		await cli({ id: scopeId, futureLocalAgents: true, agents: 'other' });
		expect(lastOutput().success).toBe(false);
		expect(store.readSupervisorTargets()).toEqual(before);
	});

	it('owner configures one dynamic scope with host baseline and restart-safe whole-agent coverage', async () => {
		const request = target();
		request.selection = {
			label: 'Future agents',
			mode: 'agents-and-groups',
			agentIds: [],
			groupIds: [],
			excludedAgentIds: ['excluded'],
			futureLocalAgents: true,
			futureAgentBaselineIds: [],
		};
		expect((await nativeSave(request)).migration?.status).toBe('registered');
		const saved = store.readSupervisorTargets()[0];
		expect(saved.selection).toMatchObject({
			futureLocalAgents: true,
			futureAgentBaselineIds: ['agent', 'manager'],
		});
		const owner = (id: string, extra = {}) => ({
			...census.owners[0],
			id,
			parentSessionId: null,
			...extra,
		});
		const owners = [
			...census.owners,
			owner('fresh'),
			owner('child', { parentSessionId: 'fresh' }),
			owner('excluded'),
			owner('remote', { remote: true }),
		];
		const reopened = createPianolaFsStore({ resolveDir: () => directory });
		const scope = reopened.readSupervisorTargets()[0];
		const resolve = (id: string, extra = {}, enabled = true) =>
			resolvePianolaScopeOwnership(
				{
					agentId: id,
					tabId: 'new-chat',
					paused: false,
					consult: false,
					ephemeral: false,
					...extra,
				},
				owners,
				[{ ...scope, enabled, selection: scope.selection!, managerAgentId: scope.managerAgentId! }],
				[]
			);
		for (const id of ['fresh', 'child']) expect(resolve(id)).toEqual({ kind: 'scope', scopeId });
		for (const id of ['agent', 'excluded', 'remote', 'missing'])
			expect(resolve(id).kind).toBe('excluded');
		expect(resolve('fresh', { paused: true }).kind).toBe('excluded');
		expect(resolve('fresh', { consult: true }).kind).toBe('excluded');
		expect(resolve('fresh', { ephemeral: true }).kind).toBe('excluded');
		expect(resolve('fresh', {}, false).kind).toBe('excluded');
		census.owners.push(owner('fresh'));
		await nativeSave({
			...request,
			selection: { ...request.selection, futureAgentBaselineIds: [] },
		});
		expect(store.readSupervisorTargets()).toEqual([saved]);
		// Both production creation consumers enter this same method. No per-agent
		// registration, checkpoint rewrite or second worker is needed.
		const spawnChild = vi.fn(
			() =>
				Object.assign(new EventEmitter(), {
					exitCode: null,
					signalCode: null,
					kill: vi.fn(),
					stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
					stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
				}) as unknown as ChildProcess
		);
		const supervisor = new PianolaSupervisor({
			isEnabled: () => feature,
			getPianolaAgentId: () => undefined,
			spawnChild,
		});
		const checkpointBefore = store.readScopeCheckpoint(scopeId);
		await Promise.all([
			supervisor.autoWatchNewSessions([{ id: 'fresh' }], [{ id: 'fresh' }]),
			supervisor.autoWatchNewSessions(
				[{ id: 'child', parentSessionId: 'fresh' }],
				[{ id: 'fresh' }, { id: 'child', parentSessionId: 'fresh' }]
			),
		]);
		expect(spawnChild).toHaveBeenCalledTimes(1);
		expect(store.readScopeCheckpoint(scopeId)).toEqual(checkpointBefore);
		census.owners = owners;
		census.capturedAt = 200;
		census.tabs = ['fresh', 'child', 'excluded', 'remote'].map((id) => ({
			...census.tabs[0],
			agentId: id,
			tabId: `${id}-chat`,
			createdAt: 150,
			busy: false,
			paused: id === 'child',
		}));
		const deps: PianolaScopeCycleDeps = {
			store: reopened,
			readSnapshot: async () => structuredClone(census),
			readTranscript: async (t) => ({ ...t, messages: [] }),
			watch: {
				readRules: () => store.readRules(),
				recordDecision: (r) => store.appendDecision(r),
				now: () => '2026-11-04T00:01:00Z',
				genId: () => 'future-decision',
				log: vi.fn(),
				notify: vi.fn(),
			},
			dispatch: vi.fn(async () => ({ status: 'accepted' as const })),
		};
		try {
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			expect(store.readScopeCheckpoint(scopeId)?.tabs.map((t) => [t.agentId, t.status])).toEqual([
				['fresh', 'active'],
				['child', 'suspended'],
			]);
			census.capturedAt++;
			census.tabs.push({ ...census.tabs[0], tabId: 'second-chat', createdAt: 201 });
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			expect(
				store.readScopeCheckpoint(scopeId)?.tabs.find((t) => t.tabId === 'second-chat')?.status
			).toBe('active');
			census.capturedAt++;
			census.tabs = census.tabs.filter((t) => t.agentId !== 'fresh');
			census.owners = census.owners.filter((o) => o.id !== 'fresh');
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			expect(
				store.readScopeCheckpoint(scopeId)?.tabs.find((t) => t.agentId === 'fresh')?.status
			).toBe('closed');
			expect(deps.dispatch).not.toHaveBeenCalled();
			expect(spawnChild).toHaveBeenCalledTimes(1);
		} finally {
			supervisor.stopAll();
		}
	});
	it('baselines a late historical busy chat before restart and allows a later fresh question', async () => {
		const request = target();
		request.selection = {
			label: 'Future',
			mode: 'agents-and-groups',
			agentIds: [],
			groupIds: [],
			excludedAgentIds: [],
			futureLocalAgents: true,
		};
		await nativeSave(request);
		census.owners.push({ ...census.owners[0], id: 'late' });
		census.tabs = [{ ...census.tabs[0], agentId: 'late', tabId: 'late-chat', createdAt: 1 }];
		census.capturedAt = 200;
		const historical = {
			id: 'historic',
			role: 'assistant' as const,
			source: 'ai' as const,
			content: 'Should I name the local variable count?',
			timestamp: '2026-11-04T00:00:00Z',
		};
		census.tabs[0].cursor = { id: historical.id, count: 1, textLength: historical.content.length };
		store.writeRules([
			{
				id: 'naming',
				enabled: true,
				scope: 'global',
				match: { kinds: ['question'], maxRisk: 'low' },
				action: 'auto_answer',
				answer: 'Use count.',
				priority: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		const deps: PianolaScopeCycleDeps = {
			store,
			readSnapshot: async () => structuredClone(census),
			readTranscript: async (t) => ({ ...t, messages: [historical] }),
			watch: {
				readRules: () => store.readRules(),
				recordDecision: (r) => store.appendDecision(r),
				now: () => '2026-11-04T00:01:00Z',
				genId: () => 'future-fresh',
				log: vi.fn(),
				notify: vi.fn(),
			},
			dispatch: vi.fn(async (_t, answer, guard) => {
				admitPianolaScopeReply(guard, answer, census, deps.store);
				return { status: 'accepted' as const };
			}),
		};
		await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
		deps.store = createPianolaFsStore({ resolveDir: () => directory });
		census.capturedAt++;
		census.tabs[0].busy = false;
		await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
		expect(deps.dispatch).not.toHaveBeenCalled();
		const fresh = { ...historical, id: 'fresh' };
		census.tabs[0].cursor = { id: fresh.id, count: 2, textLength: fresh.content.length };
		census.capturedAt++;
		deps.readTranscript = async (t) => ({ ...t, messages: [historical, fresh] });
		await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
		expect(deps.dispatch).toHaveBeenCalledTimes(1);
	});

	it('refuses future policy from an unverified owner', async () => {
		desktopOwner = false;
		const request = target();
		request.selection = {
			...request.selection!,
			futureLocalAgents: true,
		} as typeof request.selection;
		expect((await nativeSave(request)).migration?.status).toBe('NeedsConfiguration');
		expect(store.readSupervisorTargets()).toEqual([]);
	});
});

describe('L02 main decision claims', () => {
	it.each(['human', 'manager'] as const)(
		'refuses a contended %s claim and persists its outcome and ack after release',
		async (actor) => {
			census.tabs[0].busy = false;
			const messages = [
				{
					id: 'historic',
					role: 'assistant' as const,
					source: 'ai' as const,
					content: 'Should I name it count or total?',
					timestamp: '2026-11-04T18:00:00Z',
				},
			];
			census.tabs[0].cursor = { id: 'historic', count: 1, textLength: messages[0].content.length };
			census.tabs.push({ ...census.tabs[0], agentId: 'manager', tabId: 'manager-tab' });
			await nativeSave();
			const checkpoint = store.readScopeCheckpoint(scopeId)!;
			const now = messages[0].timestamp;
			const record = startPianolaDecision(
				{
					id: 'pending',
					agentId: 'agent',
					tabId: 'old',
					timestamp: now,
					dryRun: false,
					dispatched: false,
					classification: classifyMessages(messages),
					decision: { action: 'escalate', matchedRuleId: null, reason: 'handed off to Pianola' },
				},
				{
					scopeId,
					configurationFingerprint: checkpoint.configurationFingerprint,
					enrollmentRevision: checkpoint.enrollmentRevision,
					bindingFingerprint: checkpoint.tabs[0].bindingFingerprint!,
					agentId: 'agent',
					tabId: 'old',
					messageId: 'historic',
					decisionId: 'pending',
					cursor: census.tabs[0].cursor!,
				},
				'manager',
				null
			);
			record.lifecycle!.managerTabId = 'manager-tab';
			store.appendDecision(record);
			const callbacks = {
				listDesktopSessions: () => ({
					supervisionVersion: 1,
					complete: true,
					capturedAt: census.capturedAt,
					owners: census.owners.map((owner) => ({ ...owner, parentSessionId: null })),
					sessions: census.tabs.map((tab) => {
						const owner = census.owners.find((owner) => owner.id === tab.agentId)!;
						return {
							...tab,
							supervision: { ...owner, ...tab, parentSessionId: null, lineageComplete: true },
						};
					}),
				}),
				getSessionHistory: () => ({ agentId: 'agent', tabId: 'old', messages }),
				executeCommand: vi.fn(async () => true),
			};
			const principal =
				actor === 'human'
					? { kind: 'human' as const, actorId: 'owner', principal: 'owner' as const }
					: { kind: 'manager' as const, agentId: 'manager', tabId: 'manager-tab' };
			const resolve = () =>
				resolvePianolaDecision(
					callbacks as never,
					{ decisionId: record.id, answer: 'Use count.' },
					principal
				);
			const child = spawn(
				process.execPath,
				[
					'-e',
					`
			const fs = require('fs'); const lock = process.argv[1];
			fs.writeFileSync(lock, process.pid + '.held', { flag: 'wx' }); process.stdout.write('ready');
			process.stdin.once('data', () => { fs.unlinkSync(lock); process.exit(0); });
		`,
					path.join(directory, 'pianola-decisions.jsonl.lock'),
				],
				{ stdio: ['pipe', 'pipe', 'pipe'] }
			);
			try {
				await once(child.stdout, 'data');
				const wait = vi.spyOn(Atomics, 'wait');
				const before = store.readDecisions();
				const started = performance.now();
				await expect(resolve()).rejects.toThrow('lock busy');
				expect(performance.now() - started).toBeLessThan(250);
				expect(wait).not.toHaveBeenCalled();
				expect(callbacks.executeCommand).not.toHaveBeenCalled();
				expect(store.readDecisions()).toEqual(before);
				const exited = once(child, 'exit');
				child.stdin.write('release');
				await exited;
				expect(await resolve()).toEqual({ status: 'accepted' });
				expect(store.readDecisions()[0].lifecycle).toMatchObject({
					source: { kind: actor },
					delivery: 'accepted',
				});
				expect(callbacks.executeCommand).toHaveBeenCalledOnce();
				const ack = reconcilePianolaDecision(
					store.readDecisions()[0],
					census.tabs[0],
					[
						...messages,
						{ ...messages[0], id: 'answer', role: 'user', source: 'user', content: 'Use count.' },
					],
					now
				);
				await mainStore.appendDecisionAsync(ack);
				expect(store.readDecisions()[0].lifecycle?.acknowledgedAt).toBe(now);
				await expect(resolve()).rejects.toThrow('no longer pending');
				expect(callbacks.executeCommand).toHaveBeenCalledOnce();
			} finally {
				if (child.exitCode === null) {
					child.kill();
					await once(child, 'exit');
				}
			}
		}
	);
});
