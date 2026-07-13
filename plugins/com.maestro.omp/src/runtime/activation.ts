type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

interface InteractiveRuntimeHandle {
	writeCanonicalJson(value: JsonValue): void;
	onEvent(listener: (event: unknown) => void): () => void;
	stop(reason: 'deactivate' | 'revoked' | 'failed'): Promise<void>;
}

interface ActivationSdk {
	readonly interactiveRuntime?: {
		requestWorkspaceRoot(): Promise<unknown | null>;
		startOmpRuntime(input: {
			readonly workspaceRoot: unknown;
			readonly options: { readonly restore?: boolean };
		}): Promise<InteractiveRuntimeHandle>;
	};
	readonly workspace?: {
		publishExternalSessions?(sessions: readonly unknown[]): void;
		setStatus?(status: string): void;
		setBadge?(badge: unknown): void;
	};
}

let active:
	| { readonly sdk: ActivationSdk; handle?: InteractiveRuntimeHandle; unsubscribe?: () => void }
	| undefined;

/** Registers only a setup projection; filesystem-root consent is deferred to an explicit panel action. */
export async function activate(sdk: ActivationSdk): Promise<void> {
	if (active) throw new Error('OMP plugin is already active');
	if (!sdk.interactiveRuntime || !sdk.workspace)
		throw new Error('OMP interactive runtime capability is unavailable');
	active = { sdk };
	sdk.workspace.publishExternalSessions?.([]);
	sdk.workspace.setStatus?.('offline');
	sdk.workspace.setBadge?.(undefined);
}

/** Called by the transport-owned panel endpoint for first explicit start/create action only. */
export async function startFromExplicitPanelAction(): Promise<boolean> {
	if (!active) throw new Error('OMP plugin is not active');
	if (active.handle) return true;
	const workspaceRoot = await active.sdk.interactiveRuntime?.requestWorkspaceRoot();
	if (!workspaceRoot) return false;
	const handle = await active.sdk.interactiveRuntime?.startOmpRuntime({
		workspaceRoot,
		options: { restore: false },
	});
	if (!handle) throw new Error('OMP interactive runtime capability is unavailable');
	active = { ...active, handle, unsubscribe: handle.onEvent(() => undefined) };
	active.sdk.workspace?.setStatus?.('ready');
	return true;
}

export async function deactivate(): Promise<void> {
	if (!active) return;
	const current = active;
	active = undefined;
	current.unsubscribe?.();
	if (current.handle) await current.handle.stop('deactivate');
	current.sdk.workspace?.publishExternalSessions?.([]);
	current.sdk.workspace?.setStatus?.('offline');
	current.sdk.workspace?.setBadge?.(undefined);
}
