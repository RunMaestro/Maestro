import { mergeCustomAICommands } from '../../../shared/customAICommands';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import {
	registerMemoryCommandWorkflow,
	MEMORY_COMMAND_PLUGIN,
} from '../../../main/plugins/memory-command-workflow';
import {
	buildHostCallHandlers,
	type HostHandlerDeps,
} from '../../../main/plugins/plugin-host-handlers';
import { ActionGuard } from '../../../main/plugins/action-guard';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';
import type { MemoryCommandSelection } from '../../../shared/memoryCommandDraft';
import type { CustomAICommand } from '../../../shared/customAICommands';

const channels = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>());
vi.mock('electron', () => ({
	ipcMain: { handle: (channel: string, fn: any) => channels.set(channel, fn) },
}));
vi.mock('../../../main/agents/codex-memory', () => ({
	resolveCodexMemorySourceRef: async () => ({
		sourceAgentId: 'source',
		provider: 'codex',
		location: { kind: 'local' },
		codexHome: '/synthetic/codex',
		memoryRoot: '/synthetic/codex/memories',
		relativePath: 'memory.md',
	}),
}));

const ref = {
	sourceAgentId: 'source',
	provider: 'codex' as const,
	location: { kind: 'local' as const },
	codexHome: '/synthetic/codex',
	memoryRoot: '/synthetic/codex/memories',
	relativePath: 'memory.md',
};
const selection: MemoryCommandSelection = {
	requestId: 'provisional',
	status: 'selected',
	sourceRef: ref,
	textSnapshot: 'PRIVATE LEFT\r\n😀selected\r\nPRIVATE RIGHT',
	dirty: true,
	selection: { start: 14, end: 24 },
	generator: { agentId: 'generator', provider: 'codex', model: 'hint', effort: 'hint' },
};
const draft = {
	command: 'synthetic-command',
	description: 'Synthetic description',
	prompt: 'Reusable synthetic prompt',
};
let host: WebContents & EventEmitter;
let event: IpcMainInvokeEvent;
let availability: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let invoke: ReturnType<typeof vi.fn>;
let workflow: ReturnType<typeof registerMemoryCommandWorkflow>;
let commands: CustomAICommand[];
let mergeDefaults = false;
let saveCommands: ReturnType<typeof vi.fn>;
const call = (verb: string, ...args: unknown[]) =>
	channels.get(`memory:command:${verb}`)!(event, ...args);

beforeEach(async () => {
	channels.clear();
	mergeDefaults = false;
	host = Object.assign(new EventEmitter(), {
		id: 42,
		mainFrame: {},
		isDestroyed: () => false,
		send: vi.fn(),
	}) as unknown as typeof host;
	event = { sender: host, senderFrame: host.mainFrame } as IpcMainInvokeEvent;
	availability = vi.fn(() => 'available' as const);
	commands = [{ id: 'old', command: '/old', description: 'Old', prompt: 'Old prompt' }];
	saveCommands = vi.fn(async (value: CustomAICommand[]) => {
		commands = value;
		return true;
	});
	send = vi.fn(async () => ({
		success: true,
		response: JSON.stringify({ draft }),
		sessionId: null,
	}));
	let handler: (args: unknown) => Promise<unknown>;
	invoke = vi.fn((requestId: string) => handler({ requestId }));
	workflow = registerMemoryCommandWorkflow({
		getHost: () => host,
		availability,
		invoke,
		getCommands: () =>
			mergeDefaults ? mergeCustomAICommands(commands, 'effective prompt') : commands,
		saveCommands,
		getSource: async () => ({ sourceAgentId: 'source', codexHome: '/synthetic/home' }),
		getGenerator: () => ({
			agentId: 'generator',
			provider: 'codex',
			model: 'stored',
			effort: 'medium',
		}),
	});
	const grants = [
		{ capability: 'memory:selected' as const },
		{ capability: 'commands:preview' as const },
		{ capability: 'agents:dispatch' as const, scope: 'generator' },
	];
	// Only the draft slice is exercised; unrelated host services remain inaccessible.
	const deps = {
		broker: new PermissionBroker({ getGrants: () => grants }),
		actionGuard: new ActionGuard(),
		memoryCommandDraft: workflow.service,
		previewMemoryCommandDraft: workflow.preview,
		isPluginTrusted: () => true,
		dispatchUnattendedAllowed: () => true,
		sendAgent: send,
	} as unknown as HostHandlerDeps;
	const handlers = buildHostCallHandlers(deps);
	const rpc = (method: string, params: unknown) =>
		handlers[method as keyof typeof handlers]!(
			MEMORY_COMMAND_PLUGIN,
			JSON.parse(JSON.stringify(params))
		);
	const pluginModule = { exports: {} as { activate: (sdk: unknown) => void } };
	runInNewContext(readFileSync('examples/plugins/memory-command-draft/main.js', 'utf8'), {
		module: pluginModule,
	});
	pluginModule.exports.activate({
		commands: {
			register: (_id: string, fn: typeof handler) => {
				handler = fn;
			},
			openDraft: (requestId: string, draft: unknown) =>
				rpc('commands.openDraft', { requestId, draft }),
		},
		memory: {
			getSelectedSnapshot: (requestId: string) => rpc('memory.getSelectedSnapshot', { requestId }),
		},
		agents: {
			send: (agentId: string, prompt: string, opts: unknown) =>
				rpc('agents.send', { agentId, prompt, opts }),
		},
	});
});

describe('memory command workflow source package and authenticated host', () => {
	it('rejects a save after preview permissions are revoked', async () => {
		const { requestId } = await call('generate', 'viewer', selection);
		availability.mockReturnValue('permission-denied');
		await expect(call('save', 'viewer', requestId, draft)).rejects.toThrow(
			'MemoryCommandUnavailable'
		);
		expect((await call('status', 'viewer', requestId)).status).toBe('error');
		expect(saveCommands).not.toHaveBeenCalled();
	});

	it('preserves defaults on first host save and rejects a built-in collision', async () => {
		commands = [];
		mergeDefaults = true;
		const { requestId } = await call('generate', 'viewer', selection);
		expect(await call('save', 'viewer', requestId, { ...draft, command: 'commit' })).toMatchObject({
			status: 'collision',
		});
		expect(saveCommands).not.toHaveBeenCalled();
		const result = await call('save', 'viewer', requestId, draft);
		expect(result.status).toBe('saved');
		expect(result.commands.map((entry: CustomAICommand) => entry.command)).toEqual([
			'/commit',
			'/synthetic-command',
		]);
		expect(result.commands[0]).toMatchObject({
			id: 'commit',
			prompt: 'effective prompt',
			isBuiltIn: true,
		});
	});
	it('saves edited fields once through global persistence and reports saved without cancellation', async () => {
		const { requestId } = await call('generate', 'viewer', selection);
		expect(saveCommands).not.toHaveBeenCalled();
		commands.push({ id: 'newer', command: '/newer', description: 'Newer', prompt: 'Newer prompt' });
		const edited = {
			command: 'edited',
			description: 'Edited description',
			prompt: 'Edited prompt',
		};
		const result = await call('save', 'viewer', requestId, edited);
		expect(result).toEqual({ requestId, status: 'saved', commands });
		expect(commands.map((entry) => entry.command)).toEqual(['/old', '/newer', '/edited']);
		expect(commands[2]).toMatchObject({ ...edited, command: '/edited', isBuiltIn: false });
		expect(saveCommands).toHaveBeenCalledExactlyOnceWith(commands, host.id);
		expect((await call('status', 'viewer', requestId)).status).toBe('saved');
		expect(await call('cancel', 'viewer', requestId)).toBe(false);
		await expect(call('save', 'viewer', requestId, edited)).rejects.toThrow(
			'MemoryCommandUnavailable'
		);
		expect(saveCommands).toHaveBeenCalledOnce();
	});

	it.each(['cancel', 'plugin', 'client', 'viewer', 'frame', 'request'] as const)(
		'denies preview save for %s before writing',
		async (action) => {
			const { requestId } = await call('generate', 'viewer', selection);
			if (action === 'cancel') await call('cancel', 'viewer', requestId);
			if (action === 'plugin') workflow.service.cleanupPlugin(MEMORY_COMMAND_PLUGIN);
			if (action === 'client') host.emit('render-process-gone');
			if (action === 'frame') event = { ...event, senderFrame: {} } as IpcMainInvokeEvent;
			await expect(
				call(
					'save',
					action === 'viewer' ? 'foreign' : 'viewer',
					action === 'request' ? 'foreign-id' : requestId,
					draft
				)
			).rejects.toThrow('MemoryCommandUnavailable');
			expect(saveCommands).not.toHaveBeenCalled();
		}
	);

	it('allows one concurrent host save and rejects the competing replay before a second write', async () => {
		const { requestId } = await call('generate', 'viewer', selection);
		const results = await Promise.allSettled([
			call('save', 'viewer', requestId, draft),
			call('save', 'viewer', requestId, draft),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(saveCommands).toHaveBeenCalledOnce();
		expect((await call('status', 'viewer', requestId)).status).toBe('saved');
	});

	it('keeps collisions, false writes and persistence errors retryable without duplicate commands', async () => {
		const { requestId } = await call('generate', 'viewer', selection);
		expect(await call('save', 'viewer', requestId, { ...draft, command: 'old' })).toEqual({
			requestId,
			status: 'collision',
		});
		expect(saveCommands).not.toHaveBeenCalled();
		saveCommands
			.mockResolvedValueOnce(false)
			.mockRejectedValueOnce(new Error('synthetic disk failure'));
		expect(await call('save', 'viewer', requestId, draft)).toEqual({ requestId, status: 'retry' });
		expect((await call('status', 'viewer', requestId)).status).toBe('preview');
		await expect(call('save', 'viewer', requestId, draft)).rejects.toThrow(
			'MemoryCommandUnavailable'
		);
		expect((await call('status', 'viewer', requestId)).status).toBe('preview');
		expect((await call('save', 'viewer', requestId, draft)).status).toBe('saved');
		expect(commands.filter((entry) => entry.command === '/synthetic-command')).toHaveLength(1);
	});

	it('ships a valid installable manifest without write or general read capabilities', () => {
		const manifest = JSON.parse(
			readFileSync('examples/plugins/memory-command-draft/plugin.json', 'utf8')
		);
		expect(validatePluginManifest(manifest).errors).toEqual([]);
		expect(manifest.permissions.map((p: { capability: string }) => p.capability).sort()).toEqual([
			'agents:dispatch',
			'commands:preview',
			'memory:selected',
		]);
	});

	it('runs selection through the real plugin and brokered draft handlers, returning validated fields only to its viewer', async () => {
		const original = JSON.stringify(selection);
		const status = await call('generate', 'viewer', selection);
		expect(status).toEqual({ requestId: expect.any(String), status: 'preview' });
		expect(invoke).toHaveBeenCalledWith(status.requestId);
		expect(status.requestId).not.toBe(selection.requestId);
		const [agentId, prompt, resume, signal, , , , tools, options] = send.mock
			.calls[0] as unknown as any[];
		expect(agentId).toBe('generator');
		expect(prompt).toContain('😀selected');
		expect(prompt).not.toMatch(/PRIVATE LEFT|PRIVATE RIGHT/);
		expect(resume).toBeUndefined();
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(tools).toBe(false);
		expect(options).toEqual({ mode: 'draft' });
		expect(host.send).toHaveBeenCalledExactlyOnceWith('memory:command:draft', {
			viewerId: 'viewer',
			requestId: status.requestId,
			draft,
		});
		expect(await call('status', 'viewer', status.requestId)).toEqual(status);
		expect(JSON.stringify(status)).not.toContain('selected');
		expect(JSON.stringify(selection)).toBe(original);
	});

	it.each([
		'{}',
		'{"draft":{"command":"x","description":"x","prompt":"x","extra":1}}',
		'x'.repeat(128 * 1024 + 1),
	])(
		'rejects malformed or oversized provider response %# without text in status/events',
		async (response) => {
			send.mockResolvedValue({ success: true, response, sessionId: null });
			expect((await call('generate', 'viewer', selection)).status).toBe('error');
			expect(host.send).not.toHaveBeenCalled();
		}
	);

	it('rejects oversized snapshots before invoking the plugin', async () => {
		await expect(
			call('generate', 'viewer', { ...selection, textSnapshot: 'é'.repeat(65537) })
		).rejects.toThrow(/^MemoryCommandUnavailable$/);
		expect(invoke).not.toHaveBeenCalled();
	});

	it.each(['plugin-unavailable', 'permission-denied'])(
		'reports %s and refuses generation',
		async (status) => {
			availability.mockReturnValue(status);
			expect(await call('availability', 'generator')).toEqual({ status });
			await expect(call('generate', 'viewer', selection)).rejects.toThrow(
				/^MemoryCommandUnavailable$/
			);
			expect(invoke).not.toHaveBeenCalled();
		}
	);

	it.each(['foreign-window', 'subframe'])(
		'refuses %s callers before reading source',
		async (kind) => {
			event = {
				...event,
				...(kind === 'subframe' ? { senderFrame: {} } : { sender: {} }),
			} as IpcMainInvokeEvent;
			await expect(call('generate', 'viewer', selection)).rejects.toThrow(
				/^MemoryCommandUnavailable$/
			);
			expect(invoke).not.toHaveBeenCalled();
		}
	);

	it('closes during the run, aborts the existing signal and discards late results', async () => {
		let release!: (value: unknown) => void;
		send.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const pending = call('generate', 'viewer', selection);
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		await call('close', 'viewer');
		expect((send.mock.calls[0] as unknown as any[])[3].aborted).toBe(true);
		release({ success: true, response: JSON.stringify({ draft }), sessionId: null });
		expect((await pending).status).toBe('cancelled');
		expect(host.send).not.toHaveBeenCalled();
	});

	it('terminalizes plugin failure without retaining its exception text', async () => {
		invoke.mockRejectedValue(new Error(selection.textSnapshot));
		const status = await call('generate', 'viewer', selection);
		expect(status.status).toBe('error');
		expect(JSON.stringify(status)).not.toContain('PRIVATE');
		expect(host.send).not.toHaveBeenCalled();
	});

	it('cleans requests on client loss and refuses foreign viewer status/cancel', async () => {
		const status = await call('generate', 'viewer', selection);
		await expect(call('status', 'other', status.requestId)).rejects.toThrow(
			/^MemoryCommandUnavailable$/
		);
		await expect(call('cancel', 'other', status.requestId)).rejects.toThrow(
			/^MemoryCommandUnavailable$/
		);
		host.emit('render-process-gone');
		await expect(call('status', 'viewer', status.requestId)).rejects.toThrow(
			/^MemoryCommandUnavailable$/
		);
	});
});

// Exercise the authenticated WebSocket hop against the same real service/plugin/RPC fixture.
describe('local CLI memory command parity', () => {
	const id = 'transport-correlation';
	async function cli(
		action: string,
		fields: Record<string, unknown> = {},
		authenticated = true,
		address = '127.0.0.1'
	) {
		const { handleMemoryCommand } =
			await import('../../../main/web-server/handlers/messageHandlers/memoryCommand');
		const { setMemoryCommandCli } = await import('../../../main/plugins/plugin-manager-singleton');
		setMemoryCommandCli(workflow.cli);
		const respond = vi.fn();
		await handleMemoryCommand(
			{ send: respond } as any,
			{
				cliAuthenticated: authenticated,
				socket: { _socket: { remoteAddress: address } },
			} as any,
			{ type: 'memory_command', requestId: id, action, viewerId: 'cli', ...fields }
		);
		return respond.mock.calls[0][1];
	}

	it('registers without running, then starts once and reads its validated preview across connections', async () => {
		const original = JSON.stringify(selection);
		const selected = await cli('select', { selection });
		expect(selected).toMatchObject({
			success: true,
			status: 'selected',
			requestId: id,
			draftRequestId: expect.any(String),
		});
		expect(selected.draftRequestId).not.toBe(id);
		expect(invoke).not.toHaveBeenCalled();
		const args = { draftRequestId: selected.draftRequestId };
		expect((await cli('generate', args)).success).toBe(true);
		await vi.waitFor(async () => expect((await cli('status', args)).status).toBe('preview'));
		expect(await cli('preview', { ...args, background: true })).toMatchObject({
			success: true,
			status: 'preview',
			draft,
		});
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(host.send).not.toHaveBeenCalled();
		expect(JSON.stringify(await cli('status', args))).not.toMatch(/PRIVATE|prompt|description/);
		expect((await cli('generate', args)).success).toBe(false);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect((await cli('status', args)).status).toBe('preview');
		expect(JSON.stringify(selection)).toBe(original);
	});

	async function cliPreview(viewerId = 'cli') {
		const selected = await cli('select', { selection, viewerId });
		const args = { draftRequestId: selected.draftRequestId, viewerId };
		await cli('generate', args);
		await vi.waitFor(async () => expect((await cli('status', args)).status).toBe('preview'));
		return args;
	}

	it('saves edited CLI fields once using the same writer as the native form and reads saved', async () => {
		const args = await cliPreview();
		expect(saveCommands).not.toHaveBeenCalled();
		const edited = {
			command: 'cli-edited',
			description: 'CLI edit',
			prompt: 'Edited synthetic prompt',
		};
		expect(await cli('save', { ...args, draft: edited })).toMatchObject({
			success: true,
			status: 'saved',
			draftRequestId: args.draftRequestId,
			requestId: id,
		});
		expect(saveCommands).toHaveBeenCalledExactlyOnceWith(commands, undefined);
		expect(commands).toHaveLength(2);
		expect(commands[1]).toMatchObject({ ...edited, command: '/cli-edited' });
		expect((await cli('status', args)).status).toBe('saved');
		expect((await cli('save', { ...args, draft: edited })).success).toBe(false);
		expect((await cli('preview', args)).success).toBe(false);
		expect(saveCommands).toHaveBeenCalledOnce();
	});

	it.each(['revoke', 'cancel', 'plugin', 'client'] as const)(
		'preserves the confirmed CLI save after %s during an already authorized write',
		async (kind) => {
			const args = await cliPreview();
			let confirm!: (success: boolean) => void;
			const persisted = new Promise<boolean>((resolve) => {
				confirm = resolve;
			});
			saveCommands.mockImplementationOnce(async (value: CustomAICommand[]) => {
				const success = await persisted;
				if (success) commands = value;
				return success;
			});
			const saving = cli('save', { ...args, draft });
			await vi.waitFor(() => expect(saveCommands).toHaveBeenCalledOnce());
			expect((await cli('status', args)).status).toBe('saving');
			expect(commands).toHaveLength(1);
			if (kind === 'revoke') availability.mockReturnValue('permission-denied');
			if (kind === 'cancel') await cli('cancel', args);
			if (kind === 'plugin') workflow.service.cleanupPlugin(MEMORY_COMMAND_PLUGIN);
			if (kind === 'client') host.emit('render-process-gone');
			confirm(true);
			expect(await saving).toMatchObject({ success: true, status: 'saved' });
			expect((await cli('status', args)).status).toBe('saved');
			expect((await cli('cancel', args)).status).toBe('saved');
			expect((await cli('save', { ...args, draft })).success).toBe(false);
			expect(saveCommands).toHaveBeenCalledOnce();
			expect(commands.map((entry) => entry.command)).toEqual(['/old', '/synthetic-command']);
		}
	);

	it('requires a generated preview and the authenticated CLI transport before any save', async () => {
		const selected = await cli('select', { selection });
		const args = { draftRequestId: selected.draftRequestId, draft };
		expect((await cli('save', args)).success).toBe(false);
		expect((await cli('status', { draftRequestId: selected.draftRequestId })).status).toBe(
			'selected'
		);
		await cli('generate', { draftRequestId: selected.draftRequestId });
		await vi.waitFor(async () =>
			expect((await cli('status', { draftRequestId: selected.draftRequestId })).status).toBe(
				'preview'
			)
		);
		expect((await cli('save', args, false)).error).toBe('MemoryCommandDenied');
		expect((await cli('save', args, true, '192.0.2.2')).error).toBe('MemoryCommandDenied');
		expect(saveCommands).not.toHaveBeenCalled();
	});

	it('allows only one save when CLI and its delegated editor submit concurrently', async () => {
		const args = await cliPreview();
		await cli('preview', { ...args, editor: true, background: true });
		const preview = vi.mocked(host.send).mock.calls[0][1];
		const results = await Promise.allSettled([
			cli('save', { ...args, draft }),
			call('save', preview.viewerId, args.draftRequestId, draft),
		]);
		expect(
			results.filter((result) => result.status === 'fulfilled' && result.value.status === 'saved')
		).toHaveLength(1);
		expect(saveCommands).toHaveBeenCalledOnce();
		expect(commands).toHaveLength(2);
		expect((await cli('status', args)).status).toBe('saved');
	});

	it('reports collision and false/throwing writes without consuming the CLI preview or duplicating writes', async () => {
		const args = await cliPreview();
		expect(await cli('save', { ...args, draft: { ...draft, command: 'old' } })).toMatchObject({
			success: false,
			status: 'collision',
		});
		expect(saveCommands).not.toHaveBeenCalled();
		saveCommands
			.mockResolvedValueOnce(false)
			.mockRejectedValueOnce(new Error('synthetic write failure'));
		expect(await cli('save', { ...args, draft })).toMatchObject({
			success: false,
			status: 'retry',
		});
		expect((await cli('status', args)).status).toBe('preview');
		expect((await cli('save', { ...args, draft })).success).toBe(false);
		expect((await cli('preview', args)).draft).toEqual(draft);
		expect((await cli('save', { ...args, draft })).status).toBe('saved');
		expect(commands.filter((entry) => entry.command === '/synthetic-command')).toHaveLength(1);
	});

	it.each(['revoke', 'cancel', 'owner', 'plugin', 'client', 'unselected', 'fields'] as const)(
		'refuses CLI save after %s with zero writes',
		async (kind) => {
			const args = await cliPreview();
			if (kind === 'revoke') availability.mockReturnValue('permission-denied');
			if (kind === 'cancel') await cli('cancel', args);
			if (kind === 'plugin') workflow.service.cleanupPlugin(MEMORY_COMMAND_PLUGIN);
			if (kind === 'client') host.emit('render-process-gone');
			const result = await cli('save', {
				...args,
				...(kind === 'owner' ? { viewerId: 'foreign' } : {}),
				...(kind === 'unselected'
					? { draftRequestId: '00000000-0000-4000-8000-000000000001' }
					: {}),
				draft: kind === 'fields' ? { ...draft, scope: 'project' } : draft,
			});
			expect(result.success).toBe(false);
			expect(JSON.stringify(result)).not.toMatch(/PRIVATE|prompt|description/);
			expect(saveCommands).not.toHaveBeenCalled();
		}
	);

	it('delivers an editable preview on explicit request, with a host-issued alias bound to exactly one CLI request', async () => {
		const args = await cliPreview('cli-work');
		expect(await cli('preview', { ...args, editor: true, background: true })).toMatchObject({
			success: true,
			draft,
			editor: 'staged',
		});
		const [channel, preview] = vi.mocked(host.send).mock.calls[0];
		expect(channel).toBe('memory:command:editor');
		expect(preview).toMatchObject({
			requestId: args.draftRequestId,
			draft,
			background: true,
			viewerId: expect.any(String),
		});
		expect(preview.viewerId).not.toBe('cli-work');
		expect(saveCommands).not.toHaveBeenCalled();
		await expect(call('save', 'cli-work', args.draftRequestId, draft)).rejects.toThrow();
		await expect(call('save', preview.viewerId, 'foreign-request', draft)).rejects.toThrow();
		expect((await cli('preview', { ...args, editor: true, background: false })).editor).toBe(
			'opened'
		);
		expect(vi.mocked(host.send).mock.calls.at(-1)?.[1]).toMatchObject({
			viewerId: preview.viewerId,
			background: false,
		});
		const edited = { ...draft, command: 'from-editor', prompt: 'Editor edit' };
		expect((await call('save', preview.viewerId, args.draftRequestId, edited)).status).toBe(
			'saved'
		);
		expect((await cli('status', args)).status).toBe('saved');
		expect(saveCommands).toHaveBeenCalledExactlyOnceWith(commands, host.id);
		expect(commands[1]).toMatchObject({ ...edited, command: '/from-editor' });
	});

	it('does not replace a live editor from another CLI workflow or cancel a newer selection when an old editor closes', async () => {
		const first = await cliPreview('first');
		await cli('preview', { ...first, editor: true, background: true });
		const preview = vi.mocked(host.send).mock.calls[0][1];
		const second = await cliPreview('second');
		expect((await cli('preview', { ...second, editor: true })).success).toBe(false);
		expect(host.send).toHaveBeenCalledOnce();
		const newer = await cli('select', { viewerId: 'first', selection });
		await call('close', preview.viewerId);
		expect(
			(await cli('status', { viewerId: 'first', draftRequestId: newer.draftRequestId })).status
		).toBe('selected');
		expect((await cli('preview', { ...second, editor: true, background: true })).success).toBe(
			true
		);
		expect(saveCommands).not.toHaveBeenCalled();
	});

	it.each(['revoke', 'cancel', 'client', 'frame'] as const)(
		'refuses delegated editor save after %s',
		async (kind) => {
			const args = await cliPreview();
			await cli('preview', { ...args, editor: true, background: true });
			const preview = vi.mocked(host.send).mock.calls[0][1];
			if (kind === 'revoke') availability.mockReturnValue('permission-denied');
			if (kind === 'cancel') await cli('cancel', args);
			if (kind === 'client') host.emit('render-process-gone');
			if (kind === 'frame') event = { ...event, senderFrame: {} } as IpcMainInvokeEvent;
			await expect(call('save', preview.viewerId, args.draftRequestId, draft)).rejects.toThrow();
			expect(saveCommands).not.toHaveBeenCalled();
		}
	);

	it('denies unauthenticated calls and foreign viewer/desktop requests without text or dispatch', async () => {
		expect(await cli('select', { selection }, false)).toMatchObject({
			success: false,
			error: 'MemoryCommandDenied',
		});
		const desktop = await call('generate', 'viewer', selection);
		for (const action of ['generate', 'status', 'cancel', 'preview', 'save']) {
			expect((await cli(action, { draftRequestId: desktop.requestId })).success).toBe(false);
		}
		const selected = await cli('select', { selection });
		for (const action of ['generate', 'status', 'cancel', 'preview', 'save']) {
			expect(
				(await cli(action, { draftRequestId: selected.draftRequestId, viewerId: 'foreign' }))
					.success
			).toBe(false);
		}
		expect((await cli('status', { draftRequestId: selected.draftRequestId })).status).toBe(
			'selected'
		);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it('cancels the same running request after revoke and rejects late responses and preview', async () => {
		let finish!: (value: unknown) => void;
		send.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const selected = await cli('select', { selection });
		const args = { draftRequestId: selected.draftRequestId };
		await cli('generate', args);
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		const signal = (send.mock.calls[0] as unknown as any[])[3] as AbortSignal;
		expect((await cli('generate', args)).success).toBe(false);
		availability.mockReturnValue('permission-denied');
		expect((await cli('cancel', args)).status).toBe('cancelled');
		expect(signal.aborted).toBe(true);
		finish({ success: true, response: JSON.stringify({ draft }), sessionId: null });
		await expect(invoke.mock.results[0].value).rejects.toThrow('MemoryCommandFailed');
		expect(signal.aborted).toBe(true);
		expect((await cli('preview', args)).success).toBe(false);
		expect((await cli('status', args)).status).toBe('cancelled');
		expect(host.send).not.toHaveBeenCalled();
	});

	it('requires the secret and loopback even when payload claims a trusted owner', async () => {
		expect((await cli('select', { selection, hostClientId: '42' }, true, '192.0.2.2')).error).toBe(
			'MemoryCommandDenied'
		);
		for (const fields of [
			{ viewerId: '../invalid' },
			{ selection: { ...selection, textSnapshot: 'é'.repeat(65537) } },
		]) {
			expect((await cli('select', { selection, ...fields })).success).toBe(false);
		}
		expect((await cli('status', { draftRequestId: 'bad' })).success).toBe(false);
		expect((await cli('save', {})).success).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('clears the previous CLI selection and reports invocation failure without provider text', async () => {
		const previous = await cli('select', { selection });
		const current = await cli('select', { selection });
		expect((await cli('status', { draftRequestId: previous.draftRequestId })).status).toBe(
			'cancelled'
		);
		invoke.mockRejectedValueOnce(new Error('PRIVATE source provider failure'));
		const args = { draftRequestId: current.draftRequestId };
		await cli('generate', args);
		await vi.waitFor(async () => expect((await cli('status', args)).status).toBe('error'));
		expect(JSON.stringify(await cli('status', args))).not.toContain('PRIVATE');
	});

	it('rechecks preview permissions and clears CLI state when the host is lost', async () => {
		const selected = await cli('select', { selection });
		const args = { draftRequestId: selected.draftRequestId };
		await cli('generate', args);
		await vi.waitFor(async () => expect((await cli('status', args)).status).toBe('preview'));
		availability.mockReturnValue('permission-denied');
		expect((await cli('preview', args)).success).toBe(false);
		expect((await cli('status', args)).status).toBe('error');
		availability.mockReturnValue('available');
		const another = await cli('select', { selection });
		host.emit('render-process-gone');
		expect((await cli('status', { draftRequestId: another.draftRequestId })).success).toBe(false);
	});
});
