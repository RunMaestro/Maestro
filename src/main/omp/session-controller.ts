import { OmpProtocolError, OmpRpcClient, type OmpCommandOptions } from './rpc-client';
import type {
	OmpOutboundCallback,
	OmpProcessTransport,
	OmpRpcCommand,
	OmpRpcEvent,
	OmpRpcResponse,
	OmpSessionState,
} from './types';

export type OmpSessionControllerState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'crashed';

export class OmpSessionController {
	private stateValue: OmpSessionControllerState = 'starting';
	private latestState: OmpSessionState | undefined;
	private exitResolve!: () => void;
	private readonly exitedPromise = new Promise<void>((resolve) => {
		this.exitResolve = resolve;
	});

	constructor(
		readonly sessionKey: string,
		readonly transport: OmpProcessTransport,
		private readonly client: OmpRpcClient
	) {
		transport.onExit(() => {
			if (this.stateValue !== 'stopping' && this.stateValue !== 'stopped')
				this.stateValue = 'crashed';
			this.exitResolve();
		});
	}

	get state(): OmpSessionControllerState {
		return this.stateValue;
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

	async command(command: OmpRpcCommand, options?: OmpCommandOptions): Promise<OmpRpcResponse> {
		const response = await this.client.command(command, options);
		if (command.type === 'get_state' && response.success) this.acceptState(response);
		return response;
	}

	async initialize(): Promise<void> {
		await this.client.waitForReady();
		const response = await this.command({ type: 'get_state' });
		this.acceptState(response);
		this.stateValue = 'ready';
	}

	beginShutdown(): void {
		if (this.stateValue === 'stopped') return;
		this.stateValue = 'stopping';
	}

	markStopped(): void {
		this.stateValue = 'stopped';
		this.client.close();
	}

	waitForExit(): Promise<void> {
		return this.exitedPromise;
	}

	private acceptState(response: OmpRpcResponse): void {
		if (!response.success || !isSessionState(response.data)) {
			throw new OmpProtocolError('OMP get_state response did not contain a valid session state');
		}
		this.latestState = response.data;
	}
}

function isSessionState(value: unknown): value is OmpSessionState {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	if (!('sessionId' in value) || typeof value.sessionId !== 'string') return false;
	return (
		'thinkingLevel' in value &&
		'isStreaming' in value &&
		typeof value.isStreaming === 'boolean' &&
		'isCompacting' in value &&
		typeof value.isCompacting === 'boolean' &&
		'steeringMode' in value &&
		typeof value.steeringMode === 'string' &&
		'followUpMode' in value &&
		typeof value.followUpMode === 'string' &&
		'interruptMode' in value &&
		typeof value.interruptMode === 'string' &&
		'autoCompactionEnabled' in value &&
		typeof value.autoCompactionEnabled === 'boolean' &&
		'messageCount' in value &&
		typeof value.messageCount === 'number' &&
		'queuedMessageCount' in value &&
		typeof value.queuedMessageCount === 'number' &&
		'todoPhases' in value &&
		Array.isArray(value.todoPhases)
	);
}
