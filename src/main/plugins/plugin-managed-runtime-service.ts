export interface ManagedRuntimeStartRequest {
	readonly ownerPluginId: string;
	readonly generation: bigint;
	readonly capabilities: readonly string[];
	readonly scope: string;
	readonly workspaceRoot: string;
	readonly options: { readonly restore?: boolean };
}

export interface ManagedRuntimeHandle {
	writeCanonicalJson(frame: Record<string, unknown>): void;
	onEvent(listener: (event: Record<string, unknown>) => void): () => void;
	stop(): Promise<void>;
}

export interface PluginManagedRuntimeServiceOptions {
	readonly authorize: (request: ManagedRuntimeStartRequest) => boolean;
	readonly launch: (request: ManagedRuntimeStartRequest) => Promise<ManagedRuntimeHandle>;
}

/** Host-owned generic runtime lease service; protocol and executable policy belong to its injected launcher. */
export class PluginManagedRuntimeService {
	private readonly active = new Map<string, ManagedRuntimeHandle>();

	constructor(private readonly options: PluginManagedRuntimeServiceOptions) {}

	async start(request: ManagedRuntimeStartRequest): Promise<ManagedRuntimeHandle> {
		if (!this.options.authorize(request))
			throw new Error('Managed runtime capability is not authorized');
		const key = `${request.ownerPluginId}:${request.generation.toString()}:${request.scope}`;
		if (this.active.has(key)) throw new Error('Managed runtime is already active');
		const handle = await this.options.launch(request);
		this.active.set(key, handle);
		return {
			writeCanonicalJson: (frame) => handle.writeCanonicalJson(frame),
			onEvent: (listener) => handle.onEvent(listener),
			stop: async () => {
				if (this.active.get(key) !== handle) return;
				this.active.delete(key);
				await handle.stop();
			},
		};
	}
}
