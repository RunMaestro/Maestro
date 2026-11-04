/** Real CLI connection, bridge dispatch, IPC owner adapter and locked fixture registry. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { once, EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
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
	const sender = { mainFrame: {}, isDestroyed: () => false, getType: () => 'window' };
	return {
		handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
		native: { sender, window: { webContents: sender, isDestroyed: () => false } },
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
	const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
	fs.mkdirSync(root, { recursive: true });
	directory = fs.mkdtempSync(path.join(root, 'scope-host-'));
	vi.stubEnv('MAESTRO_USER_DATA', directory);
	vi.stubEnv('MAESTRO_CLI_HOST', '');
	vi.stubEnv('MAESTRO_CALLER_RUN_PROOF_FILE', '');
	feature = true;
	desktopOwner = true;
	fence = true;
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
		getWebServer: (() => ({ getPianolaScopeSnapshot: () => census })) as never,
	});
	server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	server.on('connection', (socket) => {
		socket.on('message', (bytes) => {
			void handleBridgeInvoke(
				{ id: 'fixture-cli', cli: true, user: clientUser },
				JSON.parse(String(bytes)),
				(_client, reply) => socket.send(JSON.stringify(reply))
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
			pid: process.pid,
			startedAt: Date.now(),
		})
	);
});
afterEach(async () => {
	server?.clients.forEach((socket) => socket.terminate());
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	fs.rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe('owner scope configuration through production adapters', () => {
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
			// A real host lifecycle receipt settles the pending delivery; a CLI payload cannot.
			store.appendDecision(
				updatePianolaDecision(
					record,
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
