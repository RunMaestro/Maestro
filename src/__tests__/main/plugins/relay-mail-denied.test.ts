vi.mock('../../../main/plugins/plugin-scan', async () => await import('../../helpers/pluginScan'));
/**
 * Replay the shipped host's tool-authority construction through the real MCP
 * bridge, WebSocket handler, and manager. Only filesystem facts and the child
 * transport are synthetic; no provider process or Discord request is made.
 *
 * Like plugin-host-deps-wiring.test.ts, execute the production index.ts block
 * rather than copying its admission logic into a fixture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';

const active = vi.hoisted(() => ({ manager: null as unknown }));
const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({
	app: { getPath: () => path.resolve('/fixture/private-data') },
	utilityProcess: { fork },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/plugins/plugin-manager-singleton', () => ({
	getActivePluginManager: () => active.manager,
	isPluginsFeatureEnabled: () => true,
	getHeadlessAgentRunner: () => null,
}));

import { createMcpBridge } from '../../../cli/services/mcp-bridge';
import { PluginManager } from '../../../main/plugins/plugin-manager';
import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import { createSandboxRealm } from '../../../main/plugins/plugin-sandbox-entry';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import {
	pluginToolRunIdentity,
	type PluginToolRunIdentity,
} from '../../../main/plugins/plugin-tool-run-identity';
import type { PluginToolRunProofFiles } from '../../../main/plugins/plugin-tool-run-proof-file';
import { PluginAuthorityError } from '../../../main/plugins/plugin-authority';
import {
	handlePluginsCallTool,
	handlePluginsListTools,
} from '../../../main/web-server/handlers/messageHandlers/plugins';
import type {
	MessageHandlerContext,
	WebClient,
	WebClientMessage,
} from '../../../main/web-server/handlers/messageHandlers/types';
import { RELAY_PUBLISHER_KEY } from '../../../shared/plugins/relay-identity';

const source = fs.readFileSync(path.join(__dirname, '../../../main/index.ts'), 'utf8');
const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const owner = 'fixture-relay-agent';
const proofBase = path.resolve('/fixture/private-data');

interface FixtureSession {
	id: string;
	toolType: string;
	cwd: string;
	projectRoot: string;
	fullPath?: string;
}

function productionAuthority(
	sessions: FixtureSession[],
	missing?: string,
	storagePlatform: NodeJS.Platform = process.platform
) {
	let block: ts.Block | undefined;
	const visit = (node: ts.Node): void => {
		if (
			ts.isBlock(node) &&
			node.statements.some(
				(statement) =>
					ts.isVariableStatement(statement) &&
					statement.declarationList.declarations.some(
						(declaration) => declaration.name.getText(sf) === 'assertToolProofLocation'
					)
			)
		)
			block = node;
		ts.forEachChild(node, visit);
	};
	visit(sf);
	expect(block, 'production tool authority construction must be found').toBeDefined();
	const start = block!.statements.findIndex(
		(statement) =>
			ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.some(
				(declaration) => declaration.name.getText(sf) === 'toolIdentity'
			)
	);
	const end = block!.statements.findIndex((statement) =>
		statement.getText(sf).startsWith('const trustedKeysFor =')
	);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const js = ts.transpileModule(
		block!.statements
			.slice(start, end)
			.map((statement) => statement.getText(sf))
			.join('\n'),
		{ compilerOptions: { target: ts.ScriptTarget.ES2024 } }
	).outputText;
	const warn = vi.fn();
	const provision = vi.fn(() => ({ stop: vi.fn(), assertIdentity: vi.fn() }));
	const missingFile = (): never => {
		throw Object.assign(new Error('synthetic missing path'), { code: 'ENOENT' });
	};
	const result = new Function(
		'app',
		'process',
		'DEMO_MODE',
		'realpathSync',
		'lstatSync',
		'path',
		'sessionsStore',
		'PluginAuthorityError',
		'pluginToolRunIdentity',
		'PluginToolRunProofFiles',
		'getActivePluginManager',
		'resolveEncoreFeatures',
		'store',
		'isValidAgentId',
		'logger',
		`let toolOwner, pluginManager;\n${js}\nreturn { toolIdentity, toolProofFiles,
		assertToolProofStorageActive: typeof assertToolProofStorageActive === 'function'
			? assertToolProofStorageActive : undefined,
		setOwner(manager) { toolOwner = pluginManager = manager; } };`
	)(
		{ getPath: () => proofBase },
		{ platform: storagePlatform },
		false,
		(project: string) => (project === missing ? missingFile() : project),
		missingFile,
		path,
		{ get: () => sessions },
		PluginAuthorityError,
		pluginToolRunIdentity,
		{ provision },
		() => active.manager,
		() => ({ plugins: true }),
		{ get: () => ({ plugins: true }) },
		(tool: string) => tool === 'codex',
		{ warn }
	) as {
		toolIdentity?: PluginToolRunIdentity;
		toolProofFiles?: PluginToolRunProofFiles;
		assertToolProofStorageActive?: () => void;
		setOwner(manager: PluginManager): void;
	};
	return { ...result, warn, provision };
}

afterEach(() => {
	pluginToolRunIdentity.setAgentActiveAssertion(() => {});
	active.manager = null;
	vi.restoreAllMocks();
	fork.mockReset();
});

describe('Relay authenticated MCP actual host path', () => {
	it.each([
		['safe storage', 'valid', process.platform],
		['safe storage', 'valid', 'win32'],
		['unrelated overlapping project', 'valid', process.platform],
		['removed worktree', 'valid', process.platform],
		['removed overlapping worktree', 'valid', process.platform],
		['unrelated overlapping project', 'forged', process.platform],
		['unrelated overlapping project', 'revoked before call', process.platform],
		['unrelated overlapping project', 'revoked during call', process.platform],
	] as const)(
		'%s in the stored fleet with a %s proof on %s',
		async (scenario, proofState, storagePlatform) => {
			const sessions: FixtureSession[] = [
				{
					id: owner,
					toolType: 'codex',
					cwd: path.resolve('/projects/current'),
					projectRoot: path.resolve('/projects/current'),
				},
			];
			if (scenario !== 'safe storage')
				sessions.push({
					id: 'unrelated-agent',
					toolType: 'codex',
					cwd: path.resolve(
						scenario === 'removed worktree' ? '/projects/deleted-worktree' : '/fixture'
					),
					projectRoot: path.resolve(
						scenario === 'removed worktree' ? '/projects/deleted-worktree' : '/fixture'
					),
				});
			const authority = productionAuthority(
				sessions,
				scenario === 'removed worktree'
					? path.resolve('/projects/deleted-worktree')
					: scenario === 'removed overlapping worktree'
						? path.resolve('/fixture')
						: undefined,
				storagePlatform
			);
			const fixtureRoot = path.join(process.cwd(), '.maestro', 'relay-mail-denied-test');
			fs.mkdirSync(fixtureRoot, { recursive: true });
			const fixture = fs.mkdtempSync(path.join(fixtureRoot, 'child-'));
			fs.writeFileSync(path.join(fixture, 'entry.js'), '// synthetic entry');
			const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
			fork.mockReturnValue(child);
			const realm = createSandboxRealm({
				send: (json) => queueMicrotask(() => child.emit('message', JSON.parse(json))),
				log: vi.fn(),
				timerStart: vi.fn(),
				timerClear: vi.fn(),
			});
			realm.init('sh.maestro.relay');
			const contexts: unknown[] = [];
			child.postMessage.mockImplementation((message) => {
				if (message.kind === 'invokeTool') {
					contexts.push(message.context);
					void realm
						.invokeTool(JSON.stringify(message))
						.then((json) =>
							child.emit('message', { kind: 'toolResult', id: message.id, ...JSON.parse(json) })
						);
				} else if (typeof message.id === 'number') realm.deliverResponse(JSON.stringify(message));
			});
			realm.runScript(
				`module.exports={activate:function(sdk){
				sdk.commands.register('send',async function(args,ctx){
					if(!Object.isFrozen(ctx)||ctx.callerAgentId!=='${owner}'||args.threadId!=='30')
						throw new Error('synthetic caller or binding refused');
					return {messageIds:['100']};
				});
			}};`,
				'relay-fixture'
			);
			await realm.activate();
			const sandbox = new PluginSandboxHost({
				prepareToolPluginActive: async () => {},
				broker: new PermissionBroker({ getGrants: () => [] }),
				handlers: {},
				toolIdentity: authority.toolIdentity,
				assertToolPluginActive: () => {},
			});
			sandbox.start('sh.maestro.relay', fixture, 'entry.js');
			const manager = new PluginManager({
				prepareToolRecordActive: async () => {},
				isEnabled: () => true,
				getGrants: () => [],
				sandbox,
				toolIdentity: authority.toolIdentity,
				toolProofFiles: authority.toolProofFiles,
				assertToolProofStorageActive: authority.assertToolProofStorageActive,
				// Synthetic live-consent check; no mail permission is granted or used.
				assertToolRecordActive: () => {},
			});
			manager.getRegistry().records.push({
				id: 'sh.maestro.relay',
				source: '/fixture/relay',
				enabled: true,
				loadStatus: 'ok',
				errors: [],
				signature: { status: 'trusted', signerKey: RELAY_PUBLISHER_KEY },
				manifest: {
					id: 'sh.maestro.relay',
					name: 'Relay fixture',
					version: '0.0.26',
					tier: 1,
					entry: 'entry.js',
					maestro: { minHostApi: '1.27.0' },
					permissions: [],
					contributes: { tools: [{ id: 'send', name: 'Send reply', description: 'Send a reply' }] },
				},
			});
			active.manager = manager;
			authority.setOwner(manager);
			// Permit replay against the pre-fix initializer, which had no separate
			// storage callback, so red failures reach real run issuance/MCP admission.
			if (authority.assertToolProofStorageActive) {
				const assertStorage = authority.assertToolProofStorageActive;
				if (
					(scenario === 'safe storage' || scenario === 'removed worktree') &&
					['linux', 'darwin'].includes(storagePlatform)
				) {
					expect(() => assertStorage()).not.toThrow();
				} else {
					expect(() => assertStorage()).toThrow();
					expect(authority.provision).not.toHaveBeenCalled();
				}
			}
			// Same canonical host registry and old headless issuance path as delivered.
			const proof = pluginToolRunIdentity.issue(owner, 60_000, 'sh.maestro.relay/send');
			try {
				const client = { socket: { readyState: WebSocket.OPEN } } as WebClient;
				const bridge = createMcpBridge({
					serverInfo: { name: 'fixture', version: '1' },
					runToken: proofState === 'forged' ? 'f'.repeat(64) : proof,
					log: () => {},
					request: async <T>(message: Record<string, unknown>) => {
						let response: unknown;
						const ctx = {
							send: (_client, result) => {
								response = result;
							},
						} as MessageHandlerContext;
						if (message.type === 'plugins_list_tools')
							handlePluginsListTools(ctx, client, message as WebClientMessage);
						else await handlePluginsCallTool(ctx, client, message as WebClientMessage);
						return response as T;
					},
				});
				const [tool] = await bridge.listTools();
				expect(tool.name).toBe('sh_maestro_relay__send');
				if (proofState === 'revoked before call') pluginToolRunIdentity.revoke(proof);
				const pending = bridge.callTool(tool.name, {
					text: 'Completed',
					threadId: '30',
					callerAgentId: owner,
				});
				if (proofState === 'revoked during call') pluginToolRunIdentity.revoke(proof);
				const result = await pending;
				if (proofState === 'valid') {
					expect(
						result,
						'authorized bound-thread reply must not return Error: PLUGIN_DENIED'
					).toEqual({
						content: [{ type: 'text', text: '{"messageIds":["100"]}' }],
					});
					expect(contexts).toHaveLength(1);
					expect(contexts[0]).toMatchObject({ callerAgentId: owner });
					expect(pluginToolRunIdentity.getReceipts(proof)).toEqual([
						{
							agentId: owner,
							runId: expect.stringMatching(/^[0-9a-f]{32}$/),
							toolId: 'sh.maestro.relay/send',
							messageIds: ['100'],
						},
					]);
				} else {
					expect(result).toEqual({
						content: [{ type: 'text', text: 'Error: PLUGIN_DENIED' }],
						isError: true,
					});
					expect(pluginToolRunIdentity.getReceipts(proof)).toEqual([]);
					if (proofState !== 'revoked during call') expect(contexts).toEqual([]);
				}
			} finally {
				pluginToolRunIdentity.revoke(proof);
				const stopped = sandbox.stop('sh.maestro.relay');
				child.emit('exit', 0);
				await stopped;
				fs.rmSync(fixture, { recursive: true, force: true });
			}
		}
	);
});

it('keeps ordinary verified tool admission independent of unavailable sealed plugin data', () => {
	let statement: ts.VariableStatement | undefined;
	const visit = (node: ts.Node) => {
		if (
			ts.isVariableStatement(node) &&
			node.declarationList.declarations.some((d) => d.name.getText(sf) === 'assertToolRecordActive')
		)
			statement = node;
		ts.forEachChild(node, visit);
	};
	visit(sf);
	expect(statement).toBeDefined();
	const js = ts.transpileModule(statement!.getText(sf), {
		compilerOptions: { target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const unavailable = vi.fn(() => {
		throw new Error('synthetic keyring unavailable');
	});
	const admit = new Function(
		'assertToolOwnerActive',
		'toolOwner',
		'pluginIdentity',
		'trustedKeysFor',
		'authStore',
		'PluginAuthorityError',
		js + ';return assertToolRecordActive;'
	)(
		() => {},
		{ assertToolRecordCurrent: () => {} },
		() => ({ contentHash: 'fixture', signatureStatus: 'trusted', signerKey: 'fixture' }),
		() => [],
		{
			verify: () => ({ authorized: true }),
			entryIdentity: () => ({
				contentHash: 'fixture',
				signatureStatus: 'trusted',
				signerKey: 'fixture',
			}),
			assertPluginPersistent: unavailable,
		},
		PluginAuthorityError
	);
	expect(() =>
		admit({ id: 'sh.maestro.relay', source: '/fixture', manifest: { permissions: [] } })
	).not.toThrow();
	expect(unavailable).not.toHaveBeenCalled();
});
