import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWsMaestroClient } from '../ws-client';
import type { MaestroClient, MaestroEvent, TurnEvent } from '../types';
import { CLI_SECRET, FakeBridge, TOKEN, agentRecord, tabProcessId, type Frame } from './fakeBridge';

const A1 = 'a1';
const A1_TAB = 'a1-t1';
const PID = tabProcessId(A1, A1_TAB);

/** Message types that would move the desktop's view (CO-4) or narrow the client's stream. */
const NEVER_SENT = [
	'select_session',
	'select_tab',
	'switch_mode',
	'subscribe',
	'open_file_tab',
	'open_browser_tab',
	'open_terminal_tab',
	'open_modal',
	'open_document_graph',
	'reorder_tab',
	'toggle_bookmark',
	'send_command',
];

const reply =
	(type: string, fields: Frame = {}) =>
	() => ({ type, success: true, ...fields });

describe('createWsMaestroClient', () => {
	let bridge: FakeBridge;
	let client: MaestroClient;
	let events: MaestroEvent[];
	let agents: Frame[];
	let groups: Frame[];

	const types = () => events.map((event) => event.type);
	const turnEvents = (): TurnEvent[] =>
		events.flatMap((event) => (event.type === 'turn' ? [event.event] : []));
	const turnKinds = () => turnEvents().map((event) => event.kind);

	function makeClient(options: Partial<Parameters<typeof createWsMaestroClient>[0]> = {}) {
		const created = createWsMaestroClient({
			userDataDir: bridge.dataDir,
			requestTimeoutMs: 1000,
			reconcileIntervalMs: 0,
			heartbeatIntervalMs: 60_000,
			reconnect: { initialDelayMs: 10, maxDelayMs: 40 },
			...options,
		});
		created.events.subscribe((event) => events.push(event));
		return created;
	}

	async function connect(): Promise<void> {
		const result = await client.connection.connect();
		expect(result.ok).toBe(true);
		bridge.clearReceived();
		events.length = 0;
	}

	beforeEach(async () => {
		bridge = await FakeBridge.start();
		agents = [agentRecord(A1), agentRecord('a2')];
		groups = [{ id: 'g1', name: 'Group' }];
		bridge.invokes.set('sessions:getBootstrap', () => agents);
		bridge.invokes.set('groups:getAll', () => groups);
		events = [];
		client = makeClient();
	});

	afterEach(async () => {
		await client.connection.close();
		await bridge.stop();
	});

	// -----------------------------------------------------------------------

	describe('connection', () => {
		it('discovers a live host without opening a socket', async () => {
			expect(await client.connection.discover()).toEqual({
				ok: true,
				value: {
					kind: 'desktop',
					pid: process.pid,
					version: '9.9.9',
					startedAt: 1_700_000_000_000,
					label: `desktop pid ${process.pid}`,
				},
			});
			expect(bridge.connections).toHaveLength(0);
		});

		it('says why no host was found: no file, then a stale pid', async () => {
			bridge.removeDiscovery();
			const missing = await client.connection.discover();
			expect(missing).toMatchObject({
				ok: false,
				error: { code: 'host-unavailable', method: 'connection.discover' },
			});
			bridge.writeDiscovery({ pid: 2 ** 22 + 12345 });
			const stale = await client.connection.discover();
			expect(stale).toMatchObject({ ok: false, error: { code: 'host-unavailable' } });
			expect(!stale.ok && stale.error.message).toMatch(/is not running/);
		});

		it('connects with the CLI secret on 127.0.0.1, as a dashboard client', async () => {
			const result = await client.connection.connect();
			expect(result).toMatchObject({ ok: true, value: { label: `desktop pid ${process.pid}` } });
			expect(bridge.connections[0].headers['x-maestro-cli-secret']).toBe(CLI_SECRET);
			// No sessionId: a subscription would narrow session_output and user_input.
			expect(bridge.connections[0].url).toBe(`/${TOKEN}/ws`);
			expect(client.connection.state()).toBe('connected');
			expect(client.connection.host()?.label).toBe(`desktop pid ${process.pid}`);
		});

		it('emits host.connected, then the whole snapshot, and serves lists from it', async () => {
			await client.connection.connect();
			expect(types().slice(0, 2)).toEqual(['host.connected', 'snapshot']);
			expect(events[0]).toMatchObject({ resumed: false });
			const snapshot = events[1];
			expect(snapshot).toMatchObject({ type: 'snapshot', groups });
			expect(snapshot.type === 'snapshot' && snapshot.agents.map((a) => a.id)).toEqual([A1, 'a2']);

			const list = await client.agents.list();
			expect(list.ok && list.value.map((a) => a.id)).toEqual([A1, 'a2']);
			expect(await client.groups.list()).toEqual({ ok: true, value: groups });
		});

		it('is the idle no-op when already connected, and reports host-unavailable before connecting', async () => {
			expect(await client.agents.list()).toMatchObject({
				ok: false,
				error: { code: 'host-unavailable', method: 'agents.list' },
			});
			await client.connection.connect();
			const again = await client.connection.connect();
			expect(again.ok).toBe(true);
			expect(bridge.connections).toHaveLength(1);
		});

		it('refuses a host that predates bridge.invoke (version floor)', async () => {
			bridge.supportsInvoke = false;
			const result = await client.connection.connect();
			expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } });
			expect(!result.ok && result.error.message).toMatch(/too old/);
			expect(client.connection.state()).toBe('idle');
		});

		it('refuses a host without the snapshot channels (version floor)', async () => {
			bridge.invokes.delete('sessions:getBootstrap');
			const result = await client.connection.connect();
			expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } });
			expect(client.connection.state()).toBe('idle');
		});

		it('reports unauthorized when the host closes with the Web Login code', async () => {
			bridge.closeWith = 4401;
			const result = await client.connection.connect();
			expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
			expect(client.connection.state()).toBe('idle');
		});

		it('never puts the token or the secret in an error message', async () => {
			bridge.invokes.set('sessions:getBootstrap', () => {
				throw new Error(`boom ${TOKEN} ${CLI_SECRET}`);
			});
			const result = await client.connection.connect();
			expect(result.ok).toBe(false);
			const text = JSON.stringify(result);
			expect(text).not.toContain(TOKEN);
			expect(text).not.toContain(CLI_SECRET);
		});

		it('ends calls in flight with host-unavailable when closed, and refuses new ones', async () => {
			await connect();
			bridge.typed.set('rename_session', () => 'silent');
			const pending = client.agents.rename(A1, 'New');
			await vi.waitFor(() => expect(bridge.sent('rename_session')).toHaveLength(1));
			await client.connection.close();
			expect(await pending).toMatchObject({ ok: false, error: { code: 'host-unavailable' } });
			expect(client.connection.state()).toBe('idle');
			expect(await client.agents.list()).toMatchObject({ ok: false });
			await client.connection.close();
		});

		it('turns silence into a timeout', async () => {
			client = makeClient({ requestTimeoutMs: 60 });
			await connect();
			bridge.typed.set('rename_session', () => 'silent');
			expect(await client.agents.rename(A1, 'New')).toMatchObject({
				ok: false,
				error: { code: 'timeout', method: 'agents.rename' },
			});
		});
	});

	// -----------------------------------------------------------------------

	describe('agents', () => {
		beforeEach(connect);

		it('creates an agent with the host field names, dropping blank env values', async () => {
			bridge.typed.set(
				'create_session',
				reply('create_session_result', { sessionId: 'new-agent' })
			);
			const result = await client.agents.create({
				name: ' Builder ',
				provider: 'codex',
				cwd: '/work/x',
				groupId: 'g1',
				model: 'gpt-x',
				effort: 'high',
				contextWindow: 128000,
				customPath: '/opt/codex',
				customArgs: '--flag',
				env: { KEEP: '1', BLANK: '   ' },
				ssh: { enabled: true, remoteId: 'r1' },
				autoRunFolderPath: '/work/x/pb',
				nudgeMessage: 'nudge',
				newSessionMessage: 'hello',
			});
			expect(result).toEqual({ ok: true, value: { agentId: 'new-agent' } });
			expect(bridge.sent('create_session')[0]).toMatchObject({
				name: 'Builder',
				toolType: 'codex',
				cwd: '/work/x',
				groupId: 'g1',
				customModel: 'gpt-x',
				customEffort: 'high',
				customContextWindow: 128000,
				contextWindowSource: 'user-edited',
				customPath: '/opt/codex',
				customArgs: '--flag',
				customEnvVars: { KEEP: '1' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
				autoRunFolderPath: '/work/x/pb',
				nudgeMessage: 'nudge',
				newSessionMessage: 'hello',
				background: true,
			});
		});

		it('omits provenance and empty env when there is nothing to describe', async () => {
			bridge.typed.set('create_session', reply('create_session_result', { sessionId: 'n' }));
			await client.agents.create({ name: 'A', provider: 'claude-code', cwd: '/x', env: { B: '' } });
			const sent = bridge.sent('create_session')[0];
			expect(sent).not.toHaveProperty('contextWindowSource');
			expect(sent).not.toHaveProperty('customEnvVars');
		});

		it.each([
			['a blank name', { name: '  ', provider: 'codex', cwd: '/x' }],
			['the terminal provider', { name: 'A', provider: 'terminal', cwd: '/x' }],
			['an unknown provider', { name: 'A', provider: 'nope', cwd: '/x' }],
			['a missing cwd', { name: 'A', provider: 'codex', cwd: ' ' }],
		])('refuses %s without sending anything', async (_label, input) => {
			const result = await client.agents.create(input);
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
			expect(bridge.sent('create_session')).toHaveLength(0);
		});

		it('reports a host refusal', async () => {
			bridge.typed.set('create_session', () => ({ type: 'create_session_result', success: false }));
			expect(await client.agents.create({ name: 'A', provider: 'codex', cwd: '/x' })).toMatchObject(
				{ ok: false, error: { code: 'failed', method: 'agents.create' } }
			);
		});

		it('adds an agent the host announces through sessions:lifecycleSync, and removes one', async () => {
			bridge.pushBridgeEvent('sessions:lifecycleSync', {
				added: [agentRecord('a3')],
				removedIds: ['a2'],
			});
			await vi.waitFor(() => expect(types()).toContain('agent.removed'));
			expect(events).toContainEqual(expect.objectContaining({ type: 'agent.added' }));
			expect(events).toContainEqual({ type: 'agent.removed', agentId: 'a2' });
			const list = await client.agents.list();
			expect(list.ok && list.value.map((a) => a.id)).toEqual([A1, 'a3']);
		});

		it('reads one agent fresh from the host and folds the read into the mirror', async () => {
			agents = [agentRecord(A1, { name: 'Renamed on the desktop' }), agentRecord('a2')];
			const result = await client.agents.get(A1);
			expect(result.ok && result.value.name).toBe('Renamed on the desktop');
			expect(types()).toContain('agent.updated');
			expect(await client.agents.get('nope')).toMatchObject({
				ok: false,
				error: { code: 'not-found' },
			});
		});

		it('renames with a length check, then merges the name at once', async () => {
			bridge.typed.set('rename_session', reply('rename_session_result'));
			expect(await client.agents.rename(A1, '')).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
			expect(await client.agents.rename(A1, 'x'.repeat(101))).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
			expect(bridge.sent('rename_session')).toHaveLength(0);

			expect(await client.agents.rename(A1, ' New name ')).toEqual({ ok: true, value: undefined });
			expect(bridge.sent('rename_session')[0]).toMatchObject({
				sessionId: A1,
				newName: 'New name',
			});
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'agent.updated',
					agent: expect.objectContaining({ name: 'New name' }),
				})
			);
		});

		it('stops a busy tab process before deleting the agent (gap G6)', async () => {
			agents = [
				agentRecord(A1, {
					aiTabs: [
						{ id: A1_TAB, state: 'busy' },
						{ id: 'a1-t2', state: 'idle' },
					],
				}),
				agentRecord('a2'),
			];
			await client.agents.get(A1);
			bridge.clearReceived();
			bridge.invokes.set('process:kill', () => true);
			bridge.typed.set('delete_session', reply('delete_session_result'));

			expect(await client.agents.remove(A1)).toEqual({ ok: true, value: undefined });
			expect(bridge.invoked('process:kill').map((m) => m.args)).toEqual([[PID]]);
			expect(bridge.sent('delete_session')[0]).toMatchObject({ sessionId: A1 });
			const order = bridge.received.map((m) => (m.type === 'bridge.invoke' ? m.channel : m.type));
			expect(order).toEqual(['process:kill', 'delete_session']);
		});

		describe('update', () => {
			const ok = (type: string) => bridge.typed.set(type, reply(type));

			beforeEach(() => {
				for (const type of [
					'update_session_cwd_result',
					'update_session_ssh_result',
					'update_session_config_result',
					'rename_session_result',
					'move_session_to_group_result',
					'set_auto_run_folder_result',
				]) {
					ok(type.replace(/_result$/, ''));
				}
			});

			it('applies cwd first, then ssh, config, name, group, and Auto Run folder', async () => {
				const result = await client.agents.update(A1, {
					autoRunFolderPath: '/pb',
					groupId: null,
					name: 'Renamed',
					model: null,
					env: { A: '1', B: ' ' },
					contextWindow: 5000,
					ssh: { enabled: false },
					cwd: '/new',
					bookmarked: true,
				});
				expect(result).toEqual({
					ok: true,
					value: {
						applied: [
							'cwd',
							'ssh',
							'model',
							'contextWindow',
							'env',
							'bookmarked',
							'name',
							'groupId',
							'autoRunFolderPath',
						],
					},
				});
				const order = bridge.received.map((m) => (m.type === 'bridge.invoke' ? m.channel : m.type));
				expect(order).toEqual([
					'update_session_cwd',
					'update_session_ssh',
					'update_session_config',
					'rename_session',
					'move_session_to_group',
					'set_auto_run_folder',
					'sessions:getBootstrap',
				]);
				expect(bridge.sent('update_session_cwd')[0]).toMatchObject({ newCwd: '/new' });
				expect(bridge.sent('update_session_ssh')[0]).toMatchObject({
					sshPatch: { enabled: false },
				});
				expect(bridge.sent('update_session_config')[0]).toMatchObject({
					sessionId: A1,
					configPatch: {
						customModel: null,
						customContextWindow: 5000,
						contextWindowSource: 'user-edited',
						customEnvVars: { A: '1' },
						bookmarked: true,
					},
				});
				expect(bridge.sent('move_session_to_group')[0]).toMatchObject({ groupId: null });
			});

			it('clears the context window and its provenance together', async () => {
				await client.agents.update(A1, { contextWindow: null });
				expect(bridge.sent('update_session_config')[0]).toMatchObject({
					configPatch: { customContextWindow: null, contextWindowSource: null },
				});
			});

			it('swaps the provider in a message of its own, before the other config fields', async () => {
				bridge.typed.set(
					'update_session_config',
					reply('update_session_config', { notices: ['Queued turns lost their model.', 7] })
				);
				const result = await client.agents.update(A1, { provider: 'codex', model: 'm', name: 'X' });
				expect(result).toEqual({
					ok: true,
					value: {
						applied: ['provider', 'model', 'name'],
						notices: ['Queued turns lost their model.'],
					},
				});
				const configs = bridge.sent('update_session_config');
				expect(configs).toHaveLength(2);
				expect(configs[0]).toMatchObject({ sessionId: A1, configPatch: { toolType: 'codex' } });
				expect(Object.keys((configs[0] as { configPatch: object }).configPatch)).toEqual([
					'toolType',
				]);
				expect(configs[1]).toMatchObject({ configPatch: { customModel: 'm' } });
				expect(
					(configs[1] as { configPatch: Record<string, unknown> }).configPatch.toolType
				).toBeUndefined();
			});

			it('omits notices when the host reports nothing to park', async () => {
				const result = await client.agents.update(A1, { provider: 'codex' });
				expect(result).toEqual({ ok: true, value: { applied: ['provider'] } });
			});

			it('sends nothing for the provider the agent is already on', async () => {
				const result = await client.agents.update(A1, { provider: 'claude-code' });
				expect(result).toEqual({ ok: true, value: { applied: [] } });
				expect(bridge.sent('update_session_config')).toHaveLength(0);
			});

			it.each([
				['the terminal provider', 'terminal'],
				['an unknown id', 'nope'],
			])('refuses %s before sending anything', async (_label, provider) => {
				const result = await client.agents.update(A1, { provider, name: 'X' });
				expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
				expect(bridge.received).toHaveLength(0);
			});

			it('reports a refused swap with nothing applied', async () => {
				bridge.typed.set('update_session_config', () => ({
					type: 'update_session_config_result',
					success: false,
					error: "Unknown provider 'codex'",
				}));
				const result = await client.agents.update(A1, { provider: 'codex', name: 'X' });
				expect(result).toMatchObject({ ok: false });
				expect(!result.ok && result.error.appliedFields).toBeUndefined();
				expect(bridge.sent('rename_session')).toHaveLength(0);
			});

			it('stops at a cwd refusal as rejected, with nothing else applied', async () => {
				bridge.typed.set('update_session_cwd', () => ({
					type: 'update_session_cwd_result',
					success: false,
					error: 'The agent has a live process.',
				}));
				const result = await client.agents.update(A1, { cwd: '/new', name: 'X' });
				expect(result).toMatchObject({
					ok: false,
					error: { code: 'rejected', message: 'The agent has a live process.' },
				});
				expect(!result.ok && result.error.appliedFields).toBeUndefined();
				expect(bridge.received.map((m) => m.type)).toEqual(['update_session_cwd']);
			});

			it('reports the fields applied before a later failure', async () => {
				bridge.typed.set('rename_session', () => ({
					type: 'rename_session_result',
					success: false,
					error: 'boom',
				}));
				const result = await client.agents.update(A1, { cwd: '/new', model: 'm', name: 'X' });
				expect(result).toMatchObject({
					ok: false,
					error: { code: 'failed', message: 'boom', appliedFields: ['cwd', 'model'] },
				});
			});

			it('validates before sending', async () => {
				expect(await client.agents.update(A1, { name: ' ' })).toMatchObject({
					ok: false,
					error: { code: 'invalid' },
				});
				expect(await client.agents.update(A1, { cwd: '' })).toMatchObject({
					ok: false,
					error: { code: 'invalid' },
				});
				expect(bridge.received).toHaveLength(0);
			});
		});
	});

	// -----------------------------------------------------------------------

	describe('groups', () => {
		beforeEach(connect);

		it('creates a group, validating the emoji first and refreshing the list after', async () => {
			bridge.typed.set('create_group', reply('create_group_result', { groupId: 'g2' }));
			groups = [
				{ id: 'g1', name: 'Group' },
				{ id: 'g2', name: 'New', emoji: '🔥' },
			];
			const result = await client.groups.create({ name: 'New', emoji: '🔥', parentGroupId: 'g1' });
			expect(result).toEqual({ ok: true, value: { groupId: 'g2' } });
			expect(bridge.sent('create_group')[0]).toMatchObject({
				name: 'New',
				emoji: '🔥',
				parentGroupId: 'g1',
			});
			expect(events).toContainEqual({ type: 'groups.changed', groups });
		});

		it('refuses an empty name', async () => {
			expect(await client.groups.create({ name: ' ' })).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
			expect(bridge.sent('create_group')).toHaveLength(0);
		});

		it('renames and removes, re-reading groups and agents after a remove', async () => {
			bridge.typed.set('rename_group', reply('rename_group_result'));
			bridge.typed.set('delete_group', reply('delete_group_result'));
			expect(await client.groups.rename('g1', ' Renamed ')).toEqual({ ok: true, value: undefined });
			expect(bridge.sent('rename_group')[0]).toMatchObject({ groupId: 'g1', name: 'Renamed' });

			bridge.clearReceived();
			expect(await client.groups.remove('g1')).toEqual({ ok: true, value: undefined });
			expect(bridge.sent('delete_group')[0]).toMatchObject({ groupId: 'g1' });
			expect(bridge.invoked('groups:getAll')).toHaveLength(1);
			expect(bridge.invoked('sessions:getBootstrap')).toHaveLength(1);
		});

		it('moves an agent, keeping the groupId key present for ungrouped', async () => {
			bridge.typed.set('move_session_to_group', reply('move_session_to_group_result'));
			expect(await client.groups.moveAgent(A1, 'g1')).toEqual({ ok: true, value: undefined });
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'agent.updated',
					agent: expect.objectContaining({ id: A1, groupId: 'g1' }),
				})
			);
			await client.groups.moveAgent(A1, null);
			const sent = bridge.sent('move_session_to_group')[1];
			expect(sent).toHaveProperty('groupId', null);
			expect(await client.agents.list()).toMatchObject({
				ok: true,
				value: expect.arrayContaining([expect.not.objectContaining({ groupId: 'g1' })]),
			});
		});
	});

	// -----------------------------------------------------------------------

	describe('tabs', () => {
		beforeEach(async () => {
			agents = [
				agentRecord(A1, {
					aiTabs: [
						{ id: 'a1-t1', name: 'one', state: 'idle' },
						{ id: 'a1-t2', name: 'two', state: 'idle' },
						{ id: 'consult', hidden: true },
					],
					unifiedTabOrder: [
						{ type: 'file', id: 'f' },
						{ type: 'ai', id: 'a1-t2' },
						{ type: 'ai', id: 'a1-t1' },
					],
				}),
				agentRecord('a2'),
			];
			await connect();
		});

		it('lists the visible tabs in strip order, leaving hidden consult tabs out', async () => {
			const tabs = await client.tabs.list(A1);
			expect(tabs.ok && tabs.value.map((t) => t.id)).toEqual(['a1-t2', 'a1-t1']);
			expect(await client.tabs.list('nope')).toMatchObject({
				ok: false,
				error: { code: 'not-found' },
			});
		});

		it('creates a tab in the background, then reads the agent to get its record', async () => {
			bridge.typed.set('new_tab', reply('new_tab_result', { tabId: 'a1-t3' }));
			agents = [
				agentRecord(A1, {
					aiTabs: [
						{ id: 'a1-t1' },
						{ id: 'a1-t2' },
						{ id: 'consult', hidden: true },
						{ id: 'a1-t3' },
					],
				}),
				agentRecord('a2'),
			];
			expect(await client.tabs.create(A1)).toEqual({ ok: true, value: { tabId: 'a1-t3' } });
			expect(bridge.sent('new_tab')[0]).toMatchObject({ sessionId: A1, background: true });
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'tab.added',
					agentId: A1,
					tab: expect.objectContaining({ id: 'a1-t3' }),
				})
			);
		});

		it('renames, stars, and closes a tab, merging each result', async () => {
			bridge.typed.set('rename_tab', reply('rename_tab_result'));
			bridge.typed.set('star_tab', reply('star_tab_result'));
			bridge.typed.set('close_tab', reply('close_tab_result'));

			await client.tabs.rename(A1, 'a1-t1', 'Renamed');
			expect(bridge.sent('rename_tab')[0]).toMatchObject({
				sessionId: A1,
				tabId: 'a1-t1',
				newName: 'Renamed',
			});
			await client.tabs.star(A1, 'a1-t1', true);
			expect(bridge.sent('star_tab')[0]).toMatchObject({ starred: true });
			await client.tabs.close(A1, 'a1-t2');
			expect(bridge.sent('close_tab')[0]).toMatchObject({ tabId: 'a1-t2' });

			const tabs = await client.tabs.list(A1);
			expect(tabs.ok && tabs.value).toEqual([
				expect.objectContaining({ id: 'a1-t1', name: 'Renamed', starred: true }),
			]);
			expect(types()).toEqual(expect.arrayContaining(['tab.updated', 'tab.removed']));
		});

		it('clears a tab name with an empty string', async () => {
			bridge.typed.set('rename_tab', reply('rename_tab_result'));
			await client.tabs.rename(A1, 'a1-t1', '');
			const tabs = await client.tabs.list(A1);
			expect(tabs.ok && tabs.value.find((t) => t.id === 'a1-t1')?.name).toBeNull();
		});

		it('maps a failed rename_tab and its silence', async () => {
			bridge.typed.set('rename_tab', () => ({
				type: 'rename_tab_result',
				success: false,
				error: 'Tab not found',
			}));
			expect(await client.tabs.rename(A1, 'zzz', 'x')).toMatchObject({
				ok: false,
				error: { code: 'not-found' },
			});
		});

		it('updates composer settings through the config patch, tab-scoped', async () => {
			bridge.typed.set('update_session_config', reply('update_session_config_result'));
			const result = await client.tabs.update(A1, 'a1-t1', {
				readOnly: true,
				thinking: 'sticky',
				model: null,
				enterToSend: false,
			});
			expect(result).toEqual({ ok: true, value: undefined });
			expect(bridge.sent('update_session_config')[0]).toMatchObject({
				sessionId: A1,
				configPatch: {
					tabId: 'a1-t1',
					readOnlyMode: true,
					showThinking: 'sticky',
					customModel: null,
					enterToSend: false,
				},
			});
			expect(await client.tabs.update(A1, 'a1-t1', {})).toEqual({ ok: true, value: undefined });
			expect(bridge.sent('update_session_config')).toHaveLength(1);
		});

		describe('transcript', () => {
			const logs = [1, 2, 3, 4].map((n) => ({
				id: `e${n}`,
				timestamp: n * 100,
				source: 'user',
				text: `m${n}`,
			}));

			beforeEach(() => {
				bridge.invokes.set('sessions:getDeferredContent', () => ({
					logs: [...logs, { id: 'bad' }],
				}));
			});

			it('reads the persisted entries, skipping malformed ones', async () => {
				const result = await client.tabs.transcript(A1, 'a1-t1');
				expect(result.ok && result.value.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
				expect(bridge.invoked('sessions:getDeferredContent')[0].args).toEqual([A1, 'a1-t1', false]);
			});

			it('applies sinceMs then tail, with tail 0 returning none', async () => {
				const since = await client.tabs.transcript(A1, 'a1-t1', { sinceMs: 200 });
				expect(since.ok && since.value.map((e) => e.id)).toEqual(['e3', 'e4']);
				const tail = await client.tabs.transcript(A1, 'a1-t1', { tail: 2 });
				expect(tail.ok && tail.value.map((e) => e.id)).toEqual(['e3', 'e4']);
				const none = await client.tabs.transcript(A1, 'a1-t1', { tail: 0 });
				expect(none).toEqual({ ok: true, value: [] });
			});

			it('maps a missing tab to not-found', async () => {
				bridge.invokes.set('sessions:getDeferredContent', () => {
					throw new Error('Tab zzz no longer exists');
				});
				expect(await client.tabs.transcript(A1, 'zzz')).toMatchObject({
					ok: false,
					error: { code: 'not-found', method: 'tabs.transcript' },
				});
			});
		});
	});

	// -----------------------------------------------------------------------

	describe('turns', () => {
		beforeEach(connect);

		it('sends through enqueue_command, in the background, and reports started', async () => {
			bridge.typed.set(
				'enqueue_command',
				reply('enqueue_command_result', { tabId: A1_TAB, queued: false })
			);
			const result = await client.turns.send(A1, A1_TAB, {
				text: 'hello',
				images: ['data:image/png;base64,AA=='],
			});
			expect(result).toEqual({ ok: true, value: { status: 'started' } });
			expect(bridge.sent('enqueue_command')[0]).toMatchObject({
				sessionId: A1,
				tabId: A1_TAB,
				command: 'hello',
				inputMode: 'ai',
				images: ['data:image/png;base64,AA=='],
				background: true,
			});
			expect(turnKinds()).toEqual(['started']);
		});

		it('reports a queued message with its place in line', async () => {
			bridge.typed.set(
				'enqueue_command',
				reply('enqueue_command_result', {
					queued: true,
					itemId: 'q1',
					queuePosition: 2,
					queueLength: 3,
				})
			);
			expect(await client.turns.send(A1, A1_TAB, { text: 'later' })).toEqual({
				ok: true,
				value: { status: 'queued', itemId: 'q1', position: 2, queueLength: 3 },
			});
			expect(turnKinds()).toEqual([]);
		});

		it('maps a missing agent or tab to not-found, and refuses an empty message', async () => {
			bridge.typed.set('enqueue_command', () => ({
				type: 'enqueue_command_result',
				success: false,
				error: 'Tab not found: zzz',
			}));
			expect(await client.turns.send(A1, 'zzz', { text: 'x' })).toMatchObject({
				ok: false,
				error: { code: 'not-found' },
			});
			expect(await client.turns.send(A1, A1_TAB, { text: '  ' })).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
		});

		it('interrupts the tab process by its id', async () => {
			bridge.invokes.set('process:interrupt', (args) => args[0] === PID);
			expect(await client.turns.interrupt(A1, A1_TAB)).toEqual({
				ok: true,
				value: { stopped: true },
			});
			expect(bridge.invoked('process:interrupt').map((m) => m.args)).toEqual([[PID]]);
		});

		it('retries the legacy id for the active tab, and reports nothing running otherwise', async () => {
			bridge.invokes.set('process:interrupt', (args) => args[0] === `${A1}-ai`);
			expect(await client.turns.interrupt(A1, A1_TAB)).toEqual({
				ok: true,
				value: { stopped: true },
			});
			expect(bridge.invoked('process:interrupt').map((m) => m.args)).toEqual([[PID], [`${A1}-ai`]]);

			bridge.invokes.set('process:interrupt', () => false);
			expect(await client.turns.interrupt(A1, 'not-active')).toEqual({
				ok: true,
				value: { stopped: false },
			});
		});

		it('lists and removes queued items', async () => {
			bridge.typed.set(
				'list_queue',
				reply('list_queue_result', {
					queues: [
						{
							sessionId: A1,
							name: 'Agent',
							state: 'busy',
							items: [
								{ id: 'q1', timestamp: 5, tabId: A1_TAB, type: 'message', text: 'hi' },
								{
									id: 'q2',
									timestamp: 6,
									tabId: A1_TAB,
									type: 'command',
									command: '/clear',
									commandArgs: 'x',
									paused: true,
								},
							],
						},
					],
				})
			);
			bridge.typed.set('remove_queue_item', reply('remove_queue_item_result', { removed: true }));

			expect(await client.turns.queue.list(A1)).toEqual({
				ok: true,
				value: [
					{ itemId: 'q1', tabId: A1_TAB, queuedAt: 5, kind: 'message', text: 'hi', paused: false },
					{
						itemId: 'q2',
						tabId: A1_TAB,
						queuedAt: 6,
						kind: 'command',
						text: '/clear x',
						paused: true,
					},
				],
			});
			expect(await client.turns.queue.remove(A1, 'q1')).toEqual({
				ok: true,
				value: { removed: true },
			});
			expect(bridge.sent('remove_queue_item')[0]).toMatchObject({ sessionId: A1, itemId: 'q1' });
		});

		describe('event stream', () => {
			it('streams a whole turn: started, thinking, text, tool, usage, outcome', async () => {
				const seen: TurnEvent[] = [];
				client.turns.subscribe(A1, A1_TAB, (event) => seen.push(event));

				bridge.pushBridgeEvent('process:session-id', PID, 'provider-session-1');
				bridge.pushBridgeEvent('process:thinking-chunk', PID, 'pondering');
				bridge.pushBridgeEvent('process:tool-execution', PID, {
					toolName: 'Read',
					state: { status: 'completed' },
					toolCallId: 'c1',
				});
				bridge.pushBridgeEvent('process:data', PID, 'Hello ');
				bridge.pushBridgeEvent('process:data', PID, 'world');
				bridge.pushBridgeEvent('process:usage', PID, { inputTokens: 10, outputTokens: 5 });
				bridge.pushBridgeEvent('process:exit', PID, 0, null);

				await vi.waitFor(() => expect(seen.map((e) => e.kind)).toContain('outcome'));
				expect(seen.map((e) => e.kind)).toEqual([
					'started',
					'session',
					'thinking',
					'tool',
					'text',
					'text',
					'usage',
					'outcome',
				]);
				expect(seen.at(-1)).toMatchObject({ kind: 'outcome', outcome: 'completed', exitCode: 0 });
				expect(seen[3]).toMatchObject({ tool: { id: 'c1', name: 'Read', status: 'completed' } });
				expect(seen.every((e) => typeof e.at === 'number')).toBe(true);
			});

			it('marks the tab busy for the turn and idle at its end', async () => {
				bridge.pushBridgeEvent('process:data', PID, 'x');
				await vi.waitFor(() => expect(types()).toContain('tab.updated'));
				let tabs = await client.tabs.list(A1);
				expect(tabs.ok && tabs.value[0].state).toBe('busy');
				bridge.pushBridgeEvent('process:exit', PID, 0, null);
				await vi.waitFor(() => expect(turnKinds()).toContain('outcome'));
				tabs = await client.tabs.list(A1);
				expect(tabs.ok && tabs.value[0].state).toBe('idle');
			});

			it('resolves the legacy process id to the agent active tab', async () => {
				bridge.pushBridgeEvent('process:data', `${A1}-ai`, 'legacy');
				await vi.waitFor(() => expect(turnKinds()).toContain('text'));
				expect(events).toContainEqual(
					expect.objectContaining({ type: 'turn', agentId: A1, tabId: A1_TAB })
				);
			});

			it('ignores Auto Run, synopsis, group chat, consult, and terminal processes', async () => {
				for (const pid of [
					`${A1}-batch-1700000000`,
					`${A1}-synopsis-1700000000`,
					'group-chat-x-moderator-1',
					'cross-agent-req_1',
					`${A1}-terminal-${A1_TAB}`,
					`${A1}-ai-${A1_TAB}-fp-2`,
				]) {
					bridge.pushBridgeEvent('process:data', pid, 'nope');
				}
				bridge.pushBridgeEvent('process:data', PID, 'yes');
				await vi.waitFor(() => expect(turnKinds()).toContain('text'));
				expect(turnEvents().filter((e) => e.kind === 'text')).toHaveLength(1);
			});

			it('resolves an interrupt this client asked for as interrupted', async () => {
				bridge.typed.set('enqueue_command', reply('enqueue_command_result', { queued: false }));
				bridge.invokes.set('process:interrupt', () => true);
				await client.turns.send(A1, A1_TAB, { text: 'go' });
				await client.turns.interrupt(A1, A1_TAB);
				bridge.pushBridgeEvent('process:exit', PID, 130, 'SIGINT');
				await vi.waitFor(() => expect(turnKinds()).toContain('outcome'));
				expect(turnEvents().at(-1)).toMatchObject({ kind: 'outcome', outcome: 'interrupted' });
			});

			it('resolves a turn that reported an error as crashed, carrying the error', async () => {
				const error = { type: 'rate_limited', message: 'slow down', recoverable: true };
				bridge.pushBridgeEvent('agent:error', PID, error);
				bridge.pushBridgeEvent('process:exit', PID, 1, null);
				await vi.waitFor(() => expect(turnKinds()).toContain('outcome'));
				expect(turnKinds()).toEqual(['started', 'error', 'outcome']);
				expect(turnEvents().at(-1)).toMatchObject({ outcome: 'crashed', exitCode: 1, error });
			});

			it('starts a fresh turn after an outcome', async () => {
				bridge.pushBridgeEvent('process:data', PID, 'one');
				bridge.pushBridgeEvent('process:exit', PID, 0, null);
				bridge.pushBridgeEvent('process:data', PID, 'two');
				await vi.waitFor(() => expect(turnKinds().filter((k) => k === 'started')).toHaveLength(2));
			});

			it('re-reads the agent after an outcome so the tab record carries the new totals', async () => {
				vi.useFakeTimers({ toFake: ['setTimeout'] });
				try {
					bridge.pushBridgeEvent('process:data', PID, 'x');
					bridge.pushBridgeEvent('process:exit', PID, 0, null);
					await vi.waitFor(() => expect(turnKinds()).toContain('outcome'), { interval: 5 });
					bridge.clearReceived();
					await vi.advanceTimersByTimeAsync(2600);
					await vi.waitFor(() => expect(bridge.invoked('sessions:getBootstrap')).toHaveLength(1), {
						interval: 5,
					});
				} finally {
					vi.useRealTimers();
				}
			});

			it('reports a user message accepted from any surface, but not terminal input', async () => {
				const entry = { id: 'e1', timestamp: 7, source: 'user', text: 'typed on the desktop' };
				bridge.pushBridgeEvent('process:user-input', {
					originId: 'o',
					sessionId: A1,
					tabId: A1_TAB,
					inputMode: 'terminal',
					entry,
				});
				bridge.pushBridgeEvent('process:user-input', {
					originId: 'o',
					sessionId: A1,
					tabId: A1_TAB,
					inputMode: 'ai',
					entry,
				});
				await vi.waitFor(() => expect(turnKinds()).toContain('user'));
				expect(turnEvents().filter((e) => e.kind === 'user')).toEqual([
					{ kind: 'user', at: expect.any(Number), entry },
				]);
			});

			it('delivers a turn for a tab the mirror lacks, and reads the agent', async () => {
				agents = [
					agentRecord(A1, { aiTabs: [{ id: A1_TAB }, { id: 'a1-new' }] }),
					agentRecord('a2'),
				];
				bridge.pushBridgeEvent('process:data', tabProcessId(A1, 'a1-new'), 'hi');
				await vi.waitFor(() =>
					expect(events).toContainEqual(expect.objectContaining({ type: 'tab.added', agentId: A1 }))
				);
				expect(events).toContainEqual(
					expect.objectContaining({
						type: 'turn',
						tabId: 'a1-new',
						event: expect.objectContaining({ kind: 'text' }),
					})
				);
			});

			it('filters a turn subscription to one tab and stops after unsubscribing', async () => {
				agents = [
					agentRecord(A1, { aiTabs: [{ id: A1_TAB }, { id: 'a1-t2' }] }),
					agentRecord('a2'),
				];
				await client.agents.get(A1);
				const seen: TurnEvent[] = [];
				const stop = client.turns.subscribe(A1, 'a1-t2', (event) => seen.push(event));
				bridge.pushBridgeEvent('process:data', PID, 'other tab');
				bridge.pushBridgeEvent('process:data', tabProcessId(A1, 'a1-t2'), 'this tab');
				await vi.waitFor(() => expect(seen.some((e) => e.kind === 'text')).toBe(true));
				expect(seen.filter((e) => e.kind === 'text')).toEqual([
					{ kind: 'text', at: expect.any(Number), text: 'this tab' },
				]);
				stop();
				bridge.pushBridgeEvent('process:data', tabProcessId(A1, 'a1-t2'), 'after');
				bridge.pushBridgeEvent('process:data', PID, 'sentinel');
				await vi.waitFor(() =>
					expect(turnEvents().filter((e) => e.kind === 'text')).toHaveLength(4)
				);
				expect(seen.filter((e) => e.kind === 'text')).toHaveLength(1);
			});
		});
	});

	// -----------------------------------------------------------------------

	describe('live state', () => {
		beforeEach(connect);

		it('merges a session_state_change into agent.updated', async () => {
			bridge.push({
				type: 'session_state_change',
				sessionId: A1,
				state: 'busy',
				name: 'Busy one',
				cwd: '/elsewhere',
			});
			await vi.waitFor(() => expect(types()).toContain('agent.updated'));
			const list = await client.agents.list();
			expect(list.ok && list.value[0]).toMatchObject({
				state: 'busy',
				name: 'Busy one',
				cwd: '/elsewhere',
			});
		});

		it('merges tabs_changed, and reads the agent for a tab it does not know', async () => {
			bridge.push({
				type: 'tabs_changed',
				sessionId: A1,
				aiTabs: [{ id: A1_TAB, name: 'pushed', starred: true }],
				activeTabId: A1_TAB,
			});
			await vi.waitFor(() => expect(types()).toContain('tab.updated'));
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'tab.updated',
					tab: expect.objectContaining({ name: 'pushed', starred: true }),
				})
			);

			agents = [
				agentRecord(A1, { aiTabs: [{ id: A1_TAB }, { id: 'brand-new' }] }),
				agentRecord('a2'),
			];
			bridge.push({
				type: 'tabs_changed',
				sessionId: A1,
				aiTabs: [{ id: A1_TAB }, { id: 'brand-new' }],
				activeTabId: A1_TAB,
			});
			await vi.waitFor(() =>
				expect(events).toContainEqual(
					expect.objectContaining({
						type: 'tab.added',
						tab: expect.objectContaining({ id: 'brand-new' }),
					})
				)
			);
		});

		it('adds an agent announced by session_added with one read, and removes one on session_removed', async () => {
			agents = [agentRecord(A1), agentRecord('a2'), agentRecord('a3')];
			bridge.push({ type: 'session_added', session: { id: 'a3', name: 'Agent a3' } });
			await vi.waitFor(() => expect(types()).toContain('agent.added'));
			bridge.push({ type: 'session_removed', sessionId: 'a2' });
			await vi.waitFor(() => expect(types()).toContain('agent.removed'));
		});

		it('ignores frames that must not move or fill the client (CO-4)', async () => {
			bridge.push({ type: 'active_session_changed', sessionId: 'a2' });
			bridge.push({ type: 'session_output', sessionId: A1, data: 'x' });
			bridge.push({ type: 'session_state_change', sessionId: 'sentinel-missing', state: 'busy' });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(events).toEqual([]);
			expect(bridge.received).toEqual([]);
		});

		it('reports settings changes by diffing the snapshot, then themes and custom commands', async () => {
			const seen: Array<string[] | 'unknown'> = [];
			client.settings.subscribe(['activeThemeId', 'fontSize', 'customAICommands'], (change) =>
				seen.push(change.keys)
			);
			const only: Array<string[] | 'unknown'> = [];
			client.settings.subscribe(['shortcuts'], (change) => only.push(change.keys));

			bridge.push({ type: 'settings_changed', settings: { theme: 'dracula', fontSize: 14 } });
			bridge.push({ type: 'settings_changed', settings: { theme: 'nord', fontSize: 14 } });
			bridge.push({ type: 'settings_changed', settings: { theme: 'nord', fontSize: 14 } });
			bridge.push({ type: 'theme', theme: {} });
			bridge.push({ type: 'custom_commands', commands: [] });
			bridge.pushBridgeEvent('settings:externalChange', 'fontSize');
			await vi.waitFor(() => expect(seen).toHaveLength(5));
			expect(seen).toEqual([
				'unknown',
				['activeThemeId'],
				['activeThemeId'],
				['customAICommands'],
				'unknown',
			]);
			// A subscriber to other keys hears only the 'unknown' ones.
			expect(only).toEqual(['unknown', 'unknown']);
		});
	});

	// -----------------------------------------------------------------------

	describe('reconcile poll', () => {
		it('reports what the bridge never pushes, and reads when the projection names something new', async () => {
			client = makeClient({ reconcileIntervalMs: 20 });
			let projection: Frame[] = [];
			bridge.typed.set('get_sessions', () => ({ type: 'sessions_list', sessions: projection }));
			await client.connection.connect();
			events.length = 0;

			projection = [
				{
					id: A1,
					name: 'Renamed in the desktop',
					state: 'idle',
					groupId: 'g1',
					aiTabs: [{ id: A1_TAB, name: 'main' }],
				},
				{ id: 'a2', name: 'Agent a2', state: 'idle' },
			];
			groups = [
				{ id: 'g1', name: 'Group' },
				{ id: 'g9', name: 'Made on the desktop' },
			];
			await vi.waitFor(() => expect(types()).toContain('groups.changed'));
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'agent.updated',
					agent: expect.objectContaining({ name: 'Renamed in the desktop', groupId: 'g1' }),
				})
			);

			events.length = 0;
			bridge.clearReceived();
			agents = [agentRecord(A1), agentRecord('a2'), agentRecord('a9')];
			projection = [...projection, { id: 'a9', name: 'Agent a9', state: 'idle' }];
			await vi.waitFor(() =>
				expect(events).toContainEqual(expect.objectContaining({ type: 'agent.added' }))
			);
			expect(bridge.invoked('sessions:getBootstrap').length).toBeGreaterThanOrEqual(1);
		});
	});

	// -----------------------------------------------------------------------

	describe('settings, providers, and the form reads', () => {
		beforeEach(connect);

		it('reads settings one key per call and leaves a missing key out', async () => {
			bridge.invokes.set('settings:get', (args) => (args[0] === 'fontSize' ? 14 : undefined));
			expect(await client.settings.get(['fontSize', 'missing'])).toEqual({
				ok: true,
				value: { fontSize: 14 },
			});
			expect(bridge.invoked('settings:get').map((m) => m.args)).toEqual([
				['fontSize'],
				['missing'],
			]);
		});

		it('lists the configured SSH remotes', async () => {
			bridge.invokes.set('ssh-remote:getConfigs', () => ({
				success: true,
				configs: [{ id: 'r1', name: 'Box' }],
			}));
			expect(await client.settings.sshRemotes()).toEqual({
				ok: true,
				value: [{ id: 'r1', name: 'Box' }],
			});
		});

		it('joins detection with the capability snapshots, dropping terminal', async () => {
			bridge.invokes.set('agents:detect', () => [
				{ id: 'claude-code', name: 'Claude Code', available: true, path: '/bin/claude' },
				{ id: 'codex', available: false, error: 'not found', snapshot: { version: '0.9.0' } },
				{ id: 'terminal', available: true },
			]);
			bridge.invokes.set('agents:getAllSnapshots', () => ({
				'claude-code': { status: 'ready', version: '2.1.0', lastProbedAt: 1 },
				'codex:r1': { status: 'ready', version: 'remote-only', lastProbedAt: 1 },
			}));
			expect(await client.providers.list()).toEqual({
				ok: true,
				value: [
					{
						id: 'claude-code',
						name: 'Claude Code',
						available: true,
						version: '2.1.0',
						path: '/bin/claude',
					},
					{
						id: 'codex',
						name: 'Codex',
						available: false,
						version: '0.9.0',
						unavailableReason: 'not found',
					},
				],
			});
			expect(bridge.invoked('agents:detect')[0].args).toEqual([]);

			await client.providers.list({ sshRemoteId: 'r1' });
			expect(bridge.invoked('agents:detect')[1].args).toEqual(['r1']);
		});

		it('normalizes model lists, passing the remote only when there is one', async () => {
			bridge.invokes.set('agents:getModels', () => ['m1', { id: 'm2' }, 7, '']);
			expect(await client.providers.models('codex', { refresh: true })).toEqual({
				ok: true,
				value: ['m1', 'm2'],
			});
			await client.providers.models('codex', { sshRemoteId: 'r1' });
			expect(bridge.invoked('agents:getModels').map((m) => m.args)).toEqual([
				['codex', true],
				['codex', false, 'r1'],
			]);
		});
	});

	// -----------------------------------------------------------------------

	describe('auto run (AR-4 to AR-7)', () => {
		const autoRunEvents = () =>
			events.flatMap((event) => (event.type === 'autorun' ? [event.event] : []));
		const batchId = `${A1}-batch-1712345678`;

		it('launches a spec-driven run over absolute paths, in order, with the per-run overrides', async () => {
			await connect();
			bridge.typed.set('configure_auto_run', reply('configure_auto_run_result'));
			const result = await client.autoRun.launch(A1, {
				documents: [
					{ file: '/work/a1/.maestro/playbooks/sub/second.md', resetOnCompletion: true },
					{ file: '/work/a1/.maestro/playbooks/first.md' },
				],
				loop: true,
				maxLoops: 3,
				model: 'opus',
				effort: 'high',
			});
			expect(result).toEqual({ ok: true, value: undefined });
			expect(bridge.sent('configure_auto_run')).toEqual([
				expect.objectContaining({
					sessionId: A1,
					launch: true,
					documents: [
						{ filename: '/work/a1/.maestro/playbooks/sub/second.md', resetOnCompletion: true },
						{ filename: '/work/a1/.maestro/playbooks/first.md' },
					],
					loopEnabled: true,
					maxLoops: 3,
					model: 'opus',
					effort: 'high',
				}),
			]);
		});

		it('sends only what was chosen', async () => {
			await connect();
			bridge.typed.set('configure_auto_run', reply('configure_auto_run_result'));
			await client.autoRun.launch(A1, { documents: [{ file: '/p/a.md' }] });
			const message = bridge.sent('configure_auto_run')[0];
			expect(message).not.toHaveProperty('loopEnabled');
			expect(message).not.toHaveProperty('maxLoops');
			expect(message).not.toHaveProperty('model');
			expect(message).not.toHaveProperty('effort');
		});

		it('refuses a bad launch before sending, and an unknown agent', async () => {
			await connect();
			expect(await client.autoRun.launch(A1, { documents: [] })).toMatchObject({
				ok: false,
				error: { code: 'invalid', method: 'autoRun.launch' },
			});
			expect(await client.autoRun.launchGoal(A1, { goal: ' ', maxIterations: 3 })).toMatchObject({
				ok: false,
				error: { code: 'invalid', method: 'autoRun.launchGoal' },
			});
			expect(
				await client.autoRun.launch('nobody', { documents: [{ file: '/p/a.md' }] })
			).toMatchObject({ ok: false, error: { code: 'not-found' } });
			expect(bridge.sent('configure_auto_run')).toEqual([]);
			expect(bridge.sent('launch_goal_run')).toEqual([]);
		});

		it('reports a refusal on state as rejected, with the desktop words', async () => {
			await connect();
			bridge.typed.set('configure_auto_run', () => ({
				type: 'configure_auto_run_result',
				success: false,
				error: 'No Auto Run folder configured for this session',
			}));
			expect(await client.autoRun.launch(A1, { documents: [{ file: '/p/a.md' }] })).toMatchObject({
				ok: false,
				error: { code: 'rejected', message: 'No Auto Run folder configured for this session' },
			});
		});

		it('launches a goal run, keeping a null iteration cap and returning the tab', async () => {
			await connect();
			bridge.typed.set('launch_goal_run', () => ({
				type: 'launch_goal_run_result',
				success: true,
				tabId: A1_TAB,
			}));
			const result = await client.autoRun.launchGoal(A1, {
				goal: ' Make the build green ',
				exitCriteria: 'CI passes',
				maxIterations: null,
				effort: 'low',
			});
			expect(result).toEqual({ ok: true, value: { tabId: A1_TAB } });
			const message = bridge.sent('launch_goal_run')[0];
			expect(message).toMatchObject({
				sessionId: A1,
				goal: 'Make the build green',
				exitCriteria: 'CI passes',
				maxIterations: null,
				effort: 'low',
			});
			expect(message).not.toHaveProperty('model');
		});

		it('says a busy agent is rejected', async () => {
			await connect();
			bridge.typed.set('launch_goal_run', () => ({
				type: 'launch_goal_run_result',
				success: false,
				code: 'AGENT_BUSY',
				error: 'Agent "Alpha" already has an Auto Run in progress',
			}));
			expect(await client.autoRun.launchGoal(A1, { goal: 'g' })).toMatchObject({
				ok: false,
				error: { code: 'rejected', message: expect.stringContaining('already has an Auto Run') },
			});
		});

		it.each([
			['stop', 'stop_auto_run'],
			['resume', 'resume_auto_run_error'],
			['skip', 'skip_auto_run_document'],
			['abort', 'abort_auto_run_error'],
		] as const)('%s asks the desktop with %s and answers on delivery', async (verb, type) => {
			await connect();
			bridge.typed.set(type, reply(`${type}_result`));
			expect(await client.autoRun[verb](A1)).toEqual({ ok: true, value: undefined });
			expect(bridge.sent(type)).toEqual([expect.objectContaining({ sessionId: A1 })]);

			bridge.typed.set(type, () => ({ type: `${type}_result`, success: false }));
			expect(await client.autoRun[verb](A1)).toMatchObject({
				ok: false,
				error: { code: 'rejected', method: `autoRun.${verb}` },
			});
		});

		it('turns the host state frames into autorun events, with the null that clears them', async () => {
			await connect();
			bridge.push({
				type: 'autorun_state',
				sessionId: A1,
				state: {
					isRunning: true,
					totalTasks: 2,
					completedTasks: 0,
					currentTaskIndex: 0,
					documents: ['one'],
				},
				timestamp: 1,
			});
			bridge.push({ type: 'autorun_state', sessionId: A1, state: null, timestamp: 2 });
			await vi.waitFor(() => expect(autoRunEvents()).toHaveLength(2));
			expect(autoRunEvents()[0]).toMatchObject({
				kind: 'state',
				state: { isRunning: true, documents: ['one'], tasksTotal: 2 },
			});
			expect(autoRunEvents()[1]).toMatchObject({ kind: 'state', state: null });
			expect(events.every((event) => event.type !== 'turn')).toBe(true);
		});

		it('turns the run process stream into output and usage, and none of it into a turn', async () => {
			await connect();
			bridge.pushBridgeEvent('process:data', batchId, '\u001b[1mTask one done\u001b[0m');
			bridge.pushBridgeEvent('process:tool-execution', batchId, {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: '/work/a1/src/index.ts' } },
			});
			bridge.pushBridgeEvent('process:tool-execution', batchId, {
				toolName: 'Read',
				state: { status: 'completed', input: { file_path: '/work/a1/src/index.ts' } },
			});
			bridge.pushBridgeEvent('process:usage', batchId, {
				inputTokens: 10,
				outputTokens: 2,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.01,
				contextWindow: 200000,
			});
			bridge.pushBridgeEvent('process:thinking-chunk', batchId, 'hmm');
			await vi.waitFor(() => expect(autoRunEvents()).toHaveLength(3));
			const [data, tool, used] = autoRunEvents();
			expect(data).toMatchObject({ kind: 'output', processId: batchId });
			expect(tool).toMatchObject({ kind: 'output', processId: batchId });
			expect(tool.kind === 'output' && tool.text).toMatch(/^Read .*index\.ts$/);
			expect(used).toMatchObject({ kind: 'usage', processId: batchId });
			expect(types()).not.toContain('turn');
			// The batch process is not a tab's turn, so no tab was marked busy.
			expect(events.filter((event) => event.type === 'tab.updated')).toEqual([]);
		});

		it('filters autorun events by agent', async () => {
			const forA2: MaestroEvent[] = [];
			client.events.subscribe((event) => forA2.push(event), { types: ['autorun'], agentId: 'a2' });
			await connect();
			bridge.push({ type: 'autorun_state', sessionId: A1, state: null });
			bridge.push({ type: 'autorun_state', sessionId: 'a2', state: null });
			await vi.waitFor(() => expect(forA2).toHaveLength(1));
			expect(forA2[0]).toMatchObject({ type: 'autorun', agentId: 'a2' });
		});
	});

	// -----------------------------------------------------------------------

	describe('never moves the desktop (CO-4)', () => {
		it('sends no view-moving message, and background:true on every one that accepts it', async () => {
			await connect();
			for (const type of [
				'create_session_result',
				'rename_session_result',
				'delete_session_result',
				'update_session_cwd_result',
				'update_session_config_result',
				'create_group_result',
				'move_session_to_group_result',
				'new_tab_result',
				'rename_tab_result',
				'close_tab_result',
				'star_tab_result',
				'enqueue_command_result',
			]) {
				bridge.typed.set(
					type.replace(/_result$/, ''),
					reply(type, { sessionId: 'x', groupId: 'g', tabId: 't', queued: false })
				);
			}
			bridge.invokes.set('process:interrupt', () => true);

			await client.agents.create({ name: 'A', provider: 'codex', cwd: '/x' });
			await client.agents.rename(A1, 'N');
			await client.agents.update(A1, { cwd: '/y', model: 'm' });
			await client.agents.remove(A1);
			await client.groups.create({ name: 'G' });
			await client.groups.moveAgent('a2', 'g1');
			await client.tabs.create('a2');
			await client.tabs.rename('a2', 'a2-t1', 'n');
			await client.tabs.star('a2', 'a2-t1', true);
			await client.tabs.close('a2', 'a2-t1');
			await client.turns.send('a2', 'a2-t1', { text: 'hi' });
			await client.turns.interrupt('a2', 'a2-t1');
			bridge.typed.set('configure_auto_run', reply('configure_auto_run_result'));
			bridge.typed.set('launch_goal_run', reply('launch_goal_run_result'));
			await client.autoRun.launch('a2', { documents: [{ file: '/p/a.md' }] });
			await client.autoRun.launchGoal('a2', { goal: 'g' });
			bridge.push({ type: 'active_session_changed', sessionId: 'a2' });
			await new Promise((resolve) => setTimeout(resolve, 20));

			const sentTypes = bridge.received.map((m) => m.type as string);
			for (const forbidden of NEVER_SENT) expect(sentTypes).not.toContain(forbidden);
			for (const type of ['create_session', 'new_tab', 'enqueue_command']) {
				const messages = bridge.sent(type);
				expect(messages.length).toBeGreaterThan(0);
				for (const message of messages) expect(message).toHaveProperty('background', true);
			}
			const channels = bridge.received
				.filter((m) => m.type === 'bridge.invoke')
				.map((m) => m.channel);
			for (const channel of [
				'sessions:setMany',
				'sessions:setAll',
				'groups:setAll',
				'settings:set',
			]) {
				expect(channels).not.toContain(channel);
			}
		});
	});

	// -----------------------------------------------------------------------

	describe('losing and regaining the host', () => {
		it('resumes from the last frame, and applies the replay without a new snapshot', async () => {
			await connect();
			bridge.push({ type: 'session_state_change', sessionId: A1, state: 'idle' });
			bridge.resumed = true;
			bridge.replay = [{ type: 'session_state_change', sessionId: A1, state: 'busy', seq: 99 }];
			const lastSeq = bridge.seq;

			bridge.dropAll();
			await vi.waitFor(() => expect(types()).toContain('host.connected'));
			expect(types().slice(0, 3)).toEqual(['host.lost', 'host.reconnecting', 'host.connected']);
			expect(events.find((e) => e.type === 'host.connected')).toMatchObject({ resumed: true });
			expect(types()).not.toContain('snapshot');

			const url = bridge.connections.at(-1)!.url;
			expect(url).toContain(`epoch=${bridge.epoch}`);
			expect(url).toContain(`since=${lastSeq}`);
			expect(client.connection.state()).toBe('connected');

			await vi.waitFor(() => expect(types()).toContain('agent.updated'));
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'agent.updated',
					agent: expect.objectContaining({ state: 'busy' }),
				})
			);
		});

		it('resyncs with a snapshot, and tells a running turn it lost events', async () => {
			await connect();
			bridge.pushBridgeEvent('process:data', PID, 'partial');
			await vi.waitFor(() => expect(turnKinds()).toContain('text'));
			events.length = 0;

			bridge.resumed = false;
			bridge.epoch = 'epoch-2';
			agents = [agentRecord(A1, { name: 'After restart' })];
			bridge.dropAll();
			await vi.waitFor(() => expect(types()).toContain('snapshot'));

			expect(types().slice(0, 4)).toEqual([
				'host.lost',
				'host.reconnecting',
				'host.connected',
				'snapshot',
			]);
			const snapshot = events.find((e) => e.type === 'snapshot');
			expect(snapshot?.type === 'snapshot' && snapshot.agents.map((a) => a.name)).toEqual([
				'After restart',
			]);
			expect(turnEvents().at(-1)).toMatchObject({ kind: 'gap' });
			// The client asked to resume the old epoch; the restarted host said it could not.
			expect(bridge.connections.at(-1)!.url).toContain('epoch=epoch-1');
		});

		it('backs off between attempts with a growing, capped delay', async () => {
			await connect();
			bridge.removeDiscovery();
			bridge.dropAll();
			await vi.waitFor(() => expect(client.connection.state()).toBe('waiting-for-host'));
			await vi.waitFor(() =>
				expect(events.filter((e) => e.type === 'host.reconnecting').length).toBeGreaterThanOrEqual(
					2
				)
			);
			const delays = events.flatMap((e) => (e.type === 'host.reconnecting' ? [e.delayMs] : []));
			expect(delays[0]).toBeGreaterThanOrEqual(8);
			expect(delays[0]).toBeLessThanOrEqual(12);
			for (const delay of delays) expect(delay).toBeLessThanOrEqual(40);
			expect(
				events
					.filter((e) => e.type === 'host.reconnecting')
					.map((e) => (e.type === 'host.reconnecting' ? e.attempt : 0))
			).toEqual(delays.map((_, i) => i + 1));
		});

		it('waits for a host that is gone, and attaches when one writes the discovery file again', async () => {
			await connect();
			bridge.removeDiscovery();
			bridge.dropAll();
			await vi.waitFor(() => expect(client.connection.state()).toBe('waiting-for-host'));
			bridge.writeDiscovery();
			await vi.waitFor(() => expect(client.connection.state()).toBe('connected'), {
				timeout: 2000,
			});
		});

		it('reconnects on demand instead of waiting out the backoff', async () => {
			client = makeClient({ reconnect: { initialDelayMs: 60_000, maxDelayMs: 60_000 } });
			await connect();
			bridge.dropAll();
			await vi.waitFor(() => expect(client.connection.state()).toBe('reconnecting'));
			const result = await client.connection.reconnect();
			expect(result.ok).toBe(true);
			expect(client.connection.state()).toBe('connected');
		});

		it('stops retrying when the host refuses the client twice running', async () => {
			await connect();
			bridge.closeWith = 4401;
			bridge.dropAll();
			await vi.waitFor(() => expect(client.connection.state()).toBe('idle'), { timeout: 2000 });
			const losses = events.filter((e) => e.type === 'host.lost');
			expect(losses.at(-1)).toMatchObject({ reason: expect.stringMatching(/refused/) });
		});

		it('declares the host lost when a ping goes unanswered', async () => {
			client = makeClient({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 40 });
			await connect();
			bridge.answerPings = false;
			await vi.waitFor(() => expect(types()).toContain('host.lost'), { timeout: 2000 });
			expect(events.find((e) => e.type === 'host.lost')).toMatchObject({
				reason: expect.stringMatching(/stopped answering/),
			});
		});

		it('stays connected while pings are answered', async () => {
			client = makeClient({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 40 });
			await connect();
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(types()).not.toContain('host.lost');
			expect(bridge.sent('ping').length).toBeGreaterThanOrEqual(2);
		});

		it('ends a call in flight with host-lost when the socket drops', async () => {
			await connect();
			bridge.typed.set('rename_session', () => 'silent');
			const pending = client.agents.rename(A1, 'New');
			await vi.waitFor(() => expect(bridge.sent('rename_session')).toHaveLength(1));
			bridge.dropAll();
			expect(await pending).toMatchObject({ ok: false, error: { code: 'host-lost' } });
		});
	});

	// -----------------------------------------------------------------------

	describe('events', () => {
		it('filters by type and by agent, and survives a throwing listener', async () => {
			const onlyTabs: MaestroEvent[] = [];
			const forA2: MaestroEvent[] = [];
			const survivors: MaestroEvent[] = [];
			client.events.subscribe(() => {
				throw new Error('a bad listener');
			});
			client.events.subscribe((e) => onlyTabs.push(e), { types: ['tab.updated'] });
			client.events.subscribe((e) => forA2.push(e), { agentId: 'a2' });
			client.events.subscribe((e) => survivors.push(e));
			await client.connection.connect();

			bridge.push({
				type: 'tabs_changed',
				sessionId: A1,
				aiTabs: [{ id: A1_TAB, name: 'x' }],
				activeTabId: A1_TAB,
			});
			bridge.push({ type: 'session_state_change', sessionId: 'a2', state: 'busy' });
			await vi.waitFor(() => expect(forA2.map((e) => e.type)).toContain('agent.updated'));

			expect(onlyTabs.map((e) => e.type)).toEqual(['tab.updated']);
			// Agent-scoped events are narrowed; connection and snapshot events are about no one agent.
			expect(forA2.map((e) => e.type)).toEqual(['host.connected', 'snapshot', 'agent.updated']);
			expect(survivors.map((e) => e.type)).toContain('snapshot');
		});

		it('stops delivering after unsubscribe', async () => {
			const seen: MaestroEvent[] = [];
			const stop = client.events.subscribe((e) => seen.push(e));
			stop();
			await client.connection.connect();
			expect(seen).toEqual([]);
		});
	});
});
