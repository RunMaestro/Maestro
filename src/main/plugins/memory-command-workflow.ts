import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron';
import {
	MemoryCommandDraftService,
	type MemoryCommandDraftDeps,
	type MemoryCommandDraftOwner,
} from './memory-command-draft';
import { generateUUID } from '../../shared/uuid';
import type { MemoryCommandCliRequest } from '../../shared/memoryCommandDraft';
import {
	isMemoryCommandDraft,
	type MemoryCommandDraft,
	type MemoryCommandSaveResult,
} from '../../shared/memoryCommandDraft';
import { createCustomAICommand, type CustomAICommand } from '../../shared/customAICommands';

export const MEMORY_COMMAND_PLUGIN = 'example.memory-command-draft';
export const MEMORY_COMMAND_ACTION = 'generate';

export interface MemoryCommandWorkflowDeps extends Omit<
	MemoryCommandDraftDeps,
	'isAllowed' | 'retainPreview'
> {
	getHost: () => WebContents | undefined;
	/** Active contribution, sandbox, feature, signature, exact grants and unattended consent. */
	availability: (
		generatorAgentId: string
	) => 'available' | 'plugin-unavailable' | 'permission-denied';
	invoke: (requestId: string) => Promise<unknown>;
	getCommands: () => CustomAICommand[];
	saveCommands: (commands: CustomAICommand[], senderWebContentsId?: number) => Promise<boolean>;
}

/** Host identities come from authenticated transports, never renderer/plugin arguments. */
export function registerMemoryCommandWorkflow(deps: MemoryCommandWorkflowDeps) {
	const clients = new Map<string, WebContents>();
	const observed = new WeakSet<WebContents>();
	// All local CLI processes holding this boot's secret share one host principal.
	// Commands reconnect between verbs; socket close must not discard their requests.
	const cliClientId = `cli-${generateUUID()}`;
	const dispatching = new Set<string>();
	// The native form receives an opaque alias, never authority to choose a CLI owner.
	let editor:
		| { viewerId: string; client: string; owner: MemoryCommandDraftOwner; requestId: string }
		| undefined;
	const hostOwner = (client: string, viewerId: unknown, requestId?: string) => {
		if (editor && editor.viewerId === viewerId) {
			if (editor.client !== client || (requestId !== undefined && editor.requestId !== requestId))
				throw new Error('MemoryCommandDenied');
			return editor.owner;
		}
		return owner(client, viewerId);
	};
	const service = new MemoryCommandDraftService({
		retainPreview: (binding) => binding.hostClientId === cliClientId,
		getSource: deps.getSource,
		getGenerator: deps.getGenerator,
		isAllowed: (binding) => {
			const host = clients.get(binding.hostClientId);
			return (
				!!host &&
				!host.isDestroyed() &&
				host === deps.getHost() &&
				binding.pluginId === MEMORY_COMMAND_PLUGIN &&
				deps.availability(binding.generatorAgentId) === 'available'
			);
		},
	});
	const observeHost = (host: WebContents): string => {
		const id = String(host.id);
		clients.set(id, host);
		if (!observed.has(host)) {
			observed.add(host);
			const cleanup = () => {
				service.cleanupClient(id);
				service.cleanupClient(cliClientId);
				clients.delete(id);
				clients.delete(cliClientId);
				editor = undefined;
			};
			host.once('destroyed', cleanup);
			host.on('render-process-gone', cleanup);
			host.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
				if (mainFrame) cleanup();
			});
		}
		return id;
	};
	const authenticate = (event: IpcMainInvokeEvent): string => {
		const host = deps.getHost();
		if (
			!host ||
			host.isDestroyed() ||
			event.sender !== host ||
			event.senderFrame !== host.mainFrame
		)
			throw new Error('MemoryCommandDenied');
		return observeHost(host);
	};
	const owner = (client: string, viewerId: unknown): MemoryCommandDraftOwner => {
		if (typeof viewerId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(viewerId))
			throw new Error('MemoryCommandInvalid');
		return { hostClientId: client, viewerId, pluginId: MEMORY_COMMAND_PLUGIN };
	};
	// Return fixed codes only; IPC errors and provider replies can contain the source.
	const handle = (verb: string, action: (client: string, ...args: unknown[]) => unknown) => {
		ipcMain.handle(`memory:command:${verb}`, async (event, ...args) => {
			try {
				return await action(authenticate(event), ...args);
			} catch {
				throw new Error('MemoryCommandUnavailable');
			}
		});
	};
	handle('availability', (_client, generatorId) => ({
		status: typeof generatorId === 'string' ? deps.availability(generatorId) : 'permission-denied',
	}));
	const generate = async (binding: MemoryCommandDraftOwner, requestId: string) => {
		service.getStatus(binding, requestId); // Ownership before any dispatch/replay handling.
		if (dispatching.has(requestId)) throw new Error('MemoryCommandInvalid');
		await service.get(binding.pluginId, requestId); // Live checks; no caller-supplied text.
		if (dispatching.has(requestId)) throw new Error('MemoryCommandInvalid');
		dispatching.add(requestId);
		const run = async () => {
			try {
				await deps.invoke(requestId);
				const result = service.getStatus(binding, requestId);
				if (!['preview', 'saving', 'saved', 'cancelled'].includes(result.status))
					service.fail(binding, requestId);
			} catch {
				// Client/plugin cleanup may already have removed the request.
				try {
					service.fail(binding, requestId);
				} catch {
					/* Already cleaned up. */
				}
			} finally {
				dispatching.delete(requestId);
			}
		};
		return { run };
	};
	handle('generate', async (client, viewerId, selection) => {
		const binding = owner(client, viewerId);
		const status = await service.register(binding, selection);
		await (await generate(binding, status.requestId)).run();
		return service.getStatus(binding, status.requestId);
	});
	const requestIdOf = (value: unknown): string => {
		if (typeof value !== 'string') throw new Error('MemoryCommandInvalid');
		return value;
	};
	handle('status', (client, viewerId, requestId) =>
		service.getStatus(hostOwner(client, viewerId, requestIdOf(requestId)), requestIdOf(requestId))
	);
	handle('close', (client, viewerId) => {
		const binding = hostOwner(client, viewerId);
		if (editor && editor.viewerId === viewerId) {
			const target = editor;
			editor = undefined;
			// A replaced CLI selection may already have removed the old request.
			try {
				service.cancelForHost(binding, target.requestId);
			} catch {
				/* Already cleaned up. */
			}
			return;
		}
		service.closeViewer(binding.hostClientId, binding.viewerId);
	});
	handle('cancel', (client, viewerId, requestId) =>
		service.cancelForHost(
			hostOwner(client, viewerId, requestIdOf(requestId)),
			requestIdOf(requestId)
		)
	);
	const save = async (
		binding: MemoryCommandDraftOwner,
		requestId: string,
		fields: unknown,
		senderWebContentsId: number | undefined
	): Promise<MemoryCommandSaveResult> => {
		if (!isMemoryCommandDraft(fields)) throw new Error('MemoryCommandInvalid');
		const draft = { ...fields };
		let commands: CustomAICommand[] = [];
		let collision = false;
		const saved = await service.save(binding, requestId, () => {
			const current = deps.getCommands();
			const command = createCustomAICommand(draft, current);
			if (!command) {
				collision = true;
				return false;
			}
			commands = [...current, command];
			return deps.saveCommands(commands, senderWebContentsId);
		});
		return saved
			? { requestId, status: 'saved', commands }
			: { requestId, status: collision ? 'collision' : 'retry' };
	};
	handle('save', (client, viewerId, requestId, draft) =>
		save(
			hostOwner(client, viewerId, requestIdOf(requestId)),
			requestIdOf(requestId),
			draft,
			Number(client)
		)
	);
	return {
		service,
		/** Only the local CLI-secret WebSocket handler may call this entry. */
		cli: async (request: MemoryCommandCliRequest) => {
			const host = deps.getHost();
			if (!host || host.isDestroyed()) throw new Error('MemoryCommandUnavailable');
			// Reuse Electron lifecycle observation without accepting an IPC identity from the CLI.
			observeHost(host);
			clients.set(cliClientId, host);
			const binding = owner(cliClientId, request.viewerId);
			if (request.action === 'select')
				return { success: true, ...(await service.register(binding, request.selection)) };
			const requestId = requestIdOf(request.draftRequestId);
			if (request.action === 'generate') {
				const pending = await generate(binding, requestId);
				void pending.run(); // The existing runner owns timeout/abort; status is polled separately.
				return { success: true, ...service.getStatus(binding, requestId) };
			}
			if (request.action === 'cancel') service.cancelForHost(binding, requestId);
			if (request.action === 'save') {
				const result = await save(binding, requestId, request.draft, undefined);
				return { success: result.status === 'saved', ...result };
			}
			if (request.action === 'preview') {
				const draft = await service.getPreview(binding, requestId);
				if (request.editor) {
					if (editor && editor.requestId !== requestId) {
						let status: string | undefined;
						try {
							status = service.getStatus(editor.owner, editor.requestId).status;
						} catch {
							/* Cleaned up. */
						}
						if (status === 'preview' || status === 'saving') throw new Error('MemoryCommandBusy');
					}
					if (!editor || editor.requestId !== requestId)
						editor = {
							viewerId: generateUUID(),
							client: String(host.id),
							owner: binding,
							requestId,
						};
					host.send('memory:command:editor', {
						viewerId: editor.viewerId,
						requestId,
						draft,
						background: request.background === true,
					});
				}
				return {
					success: true,
					...service.getStatus(binding, requestId),
					draft,
					...(request.editor ? { editor: request.background === true ? 'staged' : 'opened' } : {}),
				};
			}
			if (request.action !== 'status' && request.action !== 'cancel')
				throw new Error('MemoryCommandInvalid');
			return { success: true, ...service.getStatus(binding, requestId) };
		},
		preview: (value: {
			owner: MemoryCommandDraftOwner;
			requestId: string;
			draft: MemoryCommandDraft;
		}) => {
			const host = clients.get(value.owner.hostClientId);
			if (!host || host.isDestroyed() || host !== deps.getHost())
				throw new Error('MemoryCommandUnavailable');
			if (value.owner.hostClientId === cliClientId) return; // CLI reads its own preview explicitly.
			host.send('memory:command:draft', {
				viewerId: value.owner.viewerId,
				requestId: value.requestId,
				draft: value.draft,
			});
		},
	};
}
