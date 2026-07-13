import { OmpProtocolError, OmpRpcClient, type OmpCommandOptions } from './rpc-client';
import type {
	OmpAvailableSlashCommand,
	OmpHostToolDefinition,
	OmpHostUriSchemeDefinition,
	OmpInboundCallback,
	OmpOutboundCallback,
	OmpRpcCommand,
	OmpRpcEvent,
	OmpRpcResponse,
	OmpSessionState,
} from './types';

export type OmpWorkspaceControllerState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'crashed';

/** Structural injection seam for host-owned authority; this plugin never imports host implementation. */
export interface OmpOpaqueHostBrokers {
	readonly tools: {
		call(request: {
			readonly id: string;
			readonly toolCallId: string;
			readonly toolName: string;
			readonly arguments: unknown;
			readonly signal?: AbortSignal;
		}): Promise<unknown>;
		cancel(targetId: string): void;
	};
}

export interface OmpWorkspaceControllerSetup {
	readonly tools: readonly OmpHostToolDefinition[];
	/** The v16.4.8 URI catalog is intentionally empty. */
	/** The v16.4.8 URI catalog is intentionally empty. */
	readonly uriSchemes: readonly OmpHostUriSchemeDefinition[];
	readonly brokers?: OmpOpaqueHostBrokers;
}

/** One generation-bound OMP RPC process owner for exactly one Maestro workspace. */
export class OmpWorkspaceController {
	private stateValue: OmpWorkspaceControllerState = 'starting';
	private latestState: OmpSessionState | undefined;
	private availableCommandValues: readonly OmpAvailableSlashCommand[] = [];
	private availableModelValues: readonly unknown[] = [];
	private selectionTail: Promise<void> = Promise.resolve();
	private readonly activeToolCalls = new Map<string, AbortController>();

	constructor(
		readonly workspaceKey: string,
		private readonly client: OmpRpcClient,
		private readonly setup: OmpWorkspaceControllerSetup
	) {
		if (setup.uriSchemes.length !== 0) {
			throw new OmpProtocolError('OMP 16.4.8 URI catalog must be empty');
		}
		client.onCallback((callback) => {
			this.acceptCallbackProjection(callback);
			void this.handleHostCallback(callback);
		});
	}

	get state(): OmpWorkspaceControllerState {
		return this.stateValue;
	}

	get selectedSessionId(): string | undefined {
		return this.latestState?.sessionId;
	}

	get availableCommands(): readonly OmpAvailableSlashCommand[] {
		return this.availableCommandValues;
	}

	get availableModels(): readonly unknown[] {
		return this.availableModelValues;
	}

	getState(): OmpSessionState | undefined {
		return this.latestState;
	}

	onEvent(listener: (event: OmpRpcEvent) => void): () => void {
		return this.client.onEvent(listener);
	}

	onCallback(listener: (callback: OmpOutboundCallback) => void): () => void {
		return this.client.onCallback(listener);
	}

	onDiagnostic(listener: (diagnostic: string) => void): () => void {
		return this.client.onDiagnostic(listener);
	}

	async initialize(): Promise<void> {
		await this.client.waitForReady();
		const [tools, uris, state, commands, models] = await Promise.all([
			this.client.command({ type: 'set_host_tools', tools: this.setup.tools }),
			this.client.command({ type: 'set_host_uri_schemes', schemes: this.setup.uriSchemes }),
			this.client.command({ type: 'get_state' }),
			this.client.command({ type: 'get_available_commands' }),
			this.client.command({ type: 'get_available_models' }),
		]);
		if (!tools.success || !uris.success) {
			throw new OmpProtocolError('OMP rejected mandatory host setup');
		}
		this.acceptState(state);
		this.acceptAvailableCommands(commands);
		this.acceptAvailableModels(models);
		this.stateValue = 'ready';
	}

	command(command: OmpRpcCommand, options?: OmpCommandOptions): Promise<OmpRpcResponse> {
		if (command.type === 'bash' || command.type === 'abort_bash') {
			return Promise.reject(new OmpProtocolError('raw OMP bash RPC is unavailable'));
		}
		if (this.stateValue !== 'ready') {
			return Promise.reject(
				new OmpProtocolError(`OMP workspace is not ready (${this.stateValue})`)
			);
		}
		if (
			isSelectionMutation(command.type) ||
			command.type === 'prompt' ||
			command.type === 'abort_and_prompt' ||
			command.type === 'bash' ||
			command.type === 'login'
		) {
			return this.enqueueSerialized(() => this.execute(command, options));
		}
		return this.execute(command, options);
	}

	respond(callback: OmpInboundCallback): Promise<void> {
		return this.client.sendInbound(callback);
	}

	beginShutdown(): void {
		if (this.stateValue === 'stopped') return;
		this.stateValue = 'stopping';
	}

	markStopped(): void {
		this.stateValue = 'stopped';
		this.client.close();
	}

	private async execute(
		command: OmpRpcCommand,
		options?: OmpCommandOptions
	): Promise<OmpRpcResponse> {
		const response = await this.client.command(command, options);
		if (command.type === 'get_state') this.acceptState(response);
		if (command.type === 'get_available_commands') this.acceptAvailableCommands(response);
		if (command.type === 'get_available_models') this.acceptAvailableModels(response);
		return response;
	}

	private enqueueSerialized<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.selectionTail.then(operation, operation);
		this.selectionTail = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	}

	private acceptState(response: OmpRpcResponse): void {
		if (!response.success || !isSessionState(response.data)) {
			throw new OmpProtocolError('OMP get_state response did not contain a valid session state');
		}
		this.latestState = response.data;
	}

	private acceptAvailableCommands(response: OmpRpcResponse): void {
		if (!response.success || !isRecord(response.data) || !Array.isArray(response.data.commands)) {
			throw new OmpProtocolError('OMP get_available_commands response was invalid');
		}
		this.availableCommandValues = projectSlashCommands(response.data.commands);
	}

	private acceptAvailableModels(response: OmpRpcResponse): void {
		if (!response.success || !isRecord(response.data)) {
			throw new OmpProtocolError('OMP get_available_models response was invalid');
		}
		const models = Array.isArray(response.data.models) ? response.data.models : [];
		this.availableModelValues = Object.freeze([...models]);
	}

	private acceptCallbackProjection(callback: OmpOutboundCallback): void {
		if (callback.type !== 'available_commands_update' || !Array.isArray(callback.commands)) return;
		this.availableCommandValues = projectSlashCommands(callback.commands);
	}

	private async handleHostCallback(callback: OmpOutboundCallback): Promise<void> {
		if (callback.type === 'host_uri_request') {
			if (typeof callback.id === 'string')
				await this.respond({
					type: 'host_uri_result',
					id: callback.id,
					isError: true,
					error: 'capability_unavailable',
				}).catch(() => undefined);
			return;
		}
		if (callback.type === 'host_uri_cancel') return;
		if (callback.type === 'host_tool_cancel') {
			if (!isHostToolCancel(callback)) return;
			this.activeToolCalls.get(callback.targetId)?.abort();
			this.setup.brokers?.tools.cancel(callback.targetId);
			return;
		}
		if (callback.type !== 'host_tool_call' || !isHostToolCall(callback)) return;
		const broker = this.setup.brokers;
		if (!broker || this.activeToolCalls.has(callback.toolCallId)) {
			await this.respond({
				type: 'host_tool_result',
				id: callback.id,
				result: { code: 'capability_unavailable' },
				isError: true,
			}).catch(() => undefined);
			return;
		}
		const abort = new AbortController();
		this.activeToolCalls.set(callback.toolCallId, abort);
		try {
			const result = await broker.tools.call({
				id: callback.id,
				toolCallId: callback.toolCallId,
				toolName: callback.toolName,
				arguments: callback.arguments,
				signal: abort.signal,
			});
			await this.respond({ type: 'host_tool_result', id: callback.id, result }).catch(
				() => undefined
			);
		} catch {
			await this.respond({
				type: 'host_tool_result',
				id: callback.id,
				result: { code: 'policy_denied' },
				isError: true,
			}).catch(() => undefined);
		} finally {
			this.activeToolCalls.delete(callback.toolCallId);
		}
	}
}

function isSelectionMutation(command: OmpRpcCommand['type']): boolean {
	return (
		command === 'new_session' ||
		command === 'switch_session' ||
		command === 'branch' ||
		command === 'handoff'
	);
}

function isSessionState(value: unknown): value is OmpSessionState {
	if (!isRecord(value) || typeof value.sessionId !== 'string') return false;
	return (
		typeof value.isStreaming === 'boolean' &&
		typeof value.isCompacting === 'boolean' &&
		typeof value.steeringMode === 'string' &&
		typeof value.followUpMode === 'string' &&
		typeof value.interruptMode === 'string' &&
		typeof value.autoCompactionEnabled === 'boolean' &&
		typeof value.messageCount === 'number' &&
		typeof value.queuedMessageCount === 'number' &&
		Array.isArray(value.todoPhases)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHostToolCall(callback: OmpOutboundCallback): callback is OmpOutboundCallback & {
	readonly type: 'host_tool_call';
	readonly id: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly arguments: unknown;
} {
	return (
		typeof callback.id === 'string' &&
		typeof callback.toolCallId === 'string' &&
		typeof callback.toolName === 'string' &&
		'arguments' in callback
	);
}

function isHostToolCancel(callback: OmpOutboundCallback): callback is OmpOutboundCallback & {
	readonly type: 'host_tool_cancel';
	readonly targetId: string;
} {
	return typeof callback.targetId === 'string';
}

function projectSlashCommands(values: readonly unknown[]): readonly OmpAvailableSlashCommand[] {
	const projected = values.map((value) => {
		if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0)
			throw new OmpProtocolError('OMP slash command metadata was invalid');
		if (value.description !== undefined && typeof value.description !== 'string')
			throw new OmpProtocolError('OMP slash command description was invalid');
		if (
			value.aliases !== undefined &&
			(!Array.isArray(value.aliases) || !value.aliases.every((alias) => typeof alias === 'string'))
		)
			throw new OmpProtocolError('OMP slash command aliases were invalid');
		return Object.freeze({
			name: value.name,
			...(typeof value.description === 'string' ? { description: value.description } : {}),
			...(Array.isArray(value.aliases) ? { aliases: Object.freeze([...value.aliases]) } : {}),
		});
	});
	return Object.freeze(projected);
}
