import {
	registerPluginWorkspaceIpc,
	type PluginWorkspaceIpcRegistration,
	type PluginWorkspaceIpcRegistrationOptions,
} from './plugin-workspace-registration';

export type { PluginWorkspaceIpcRegistrationOptions } from './plugin-workspace-registration';

export type PluginWorkspaceIpcRegistrar = (
	options: PluginWorkspaceIpcRegistrationOptions
) => PluginWorkspaceIpcRegistration;

export interface PluginWorkspaceIpcLifecycle {
	dispose(): void;
	disposeBefore(teardown: () => void): void;
}

/**
 * Owns the generic workspace IPC binder for one main-process lifetime.
 * Registration is immediate: callers must first supply their live dependencies.
 */
export function createPluginWorkspaceIpcLifecycle(
	options: PluginWorkspaceIpcRegistrationOptions,
	register: PluginWorkspaceIpcRegistrar = registerPluginWorkspaceIpc
): PluginWorkspaceIpcLifecycle {
	const registration = register(options);
	let disposed = false;

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		registration.dispose();
	};

	return Object.freeze({
		dispose,
		disposeBefore: (teardown: () => void): void => {
			if (disposed) return;
			dispose();
			teardown();
		},
	});
}
