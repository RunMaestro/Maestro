/** Real CLI connection, bridge dispatch, IPC owner adapter and locked fixture registry. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
	startPianolaDecision,
	updatePianolaDecision,
} from '../../../shared/pianola/pianola-decision-lifecycle';
import { canonicalJson } from '../../../shared/canonicalJson';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type { PianolaScopeSnapshot } from '../../../shared/pianola/pianola-scope-cycle';

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
import { pianolaSuperviseScope } from '../../../cli/commands/pianola-supervise';

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
