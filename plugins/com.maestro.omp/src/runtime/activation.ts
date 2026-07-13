import type {
	InteractiveRuntimeHandle,
	MaestroSdk,
	MaestroWorkspaceApi,
} from '@maestro/plugin-sdk';

type ActivationSdk = Pick<MaestroSdk, 'workspace' | 'interactivePanel' | 'interactiveRuntime'>;

let active:
	| {
			readonly sdk: ActivationSdk;
			readonly workspace: MaestroWorkspaceApi;
			handle?: InteractiveRuntimeHandle;
			unsubscribe?: () => void;
	  }
	| undefined;

/** Registers only a setup projection; filesystem-root consent is deferred to an explicit panel action. */
export async function activate(sdk: ActivationSdk): Promise<void> {
	if (active) throw new Error('OMP plugin is already active');
	if (!sdk.interactiveRuntime || !sdk.workspace || !sdk.interactivePanel) {
		throw new Error('OMP workspace, panel, or interactive runtime capability is unavailable');
	}
	try {
		await sdk.workspace.publishExternalSessions(1, []);
		await sdk.workspace.setStatus({ state: 'offline', label: 'OMP setup required' });
		await sdk.workspace.setBadge(null);
		active = { sdk, workspace: sdk.workspace };
	} catch (error) {
		await sdk.workspace.publishExternalSessions(2, []).catch(() => undefined);
		await sdk.workspace
			.setStatus({ state: 'error', label: 'OMP activation failed' })
			.catch(() => undefined);
		throw error;
	}
}

/** Called by the transport-owned panel endpoint for first explicit start/create action only. */
export async function startFromExplicitPanelAction(): Promise<boolean> {
	if (!active) throw new Error('OMP plugin is not active');
	if (active.handle) return true;
	const runtime = active.sdk.interactiveRuntime;
	if (!runtime) throw new Error('OMP interactive runtime capability is unavailable');
	const workspaceRoot = await runtime.requestWorkspaceRoot();
	if (!workspaceRoot) return false;
	const handle = await runtime.startOmpRuntime({
		workspaceRoot,
		options: { restore: false },
	});
	active = { ...active, handle, unsubscribe: handle.onEvent(() => undefined) };
	await active.workspace.setStatus({ state: 'ready', label: 'OMP ready' });
	return true;
}

export async function deactivate(): Promise<void> {
	if (!active) return;
	const current = active;
	active = undefined;
	current.unsubscribe?.();
	if (current.handle) await current.handle.stop('workspace-deactivated');
	await current.workspace.publishExternalSessions(2, []);
	await current.workspace.setStatus({ state: 'offline', label: 'OMP offline' });
	await current.workspace.setBadge(null);
}
