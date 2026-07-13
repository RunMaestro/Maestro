import { describe, expect, it, vi } from 'vitest';
import {
	createPluginWorkspaceIpcLifecycle,
	type PluginWorkspaceIpcRegistrationOptions,
} from '../../main/plugins/plugin-workspace-ipc-lifecycle';

function dependencies(): PluginWorkspaceIpcRegistrationOptions {
	return {
		ipcMain: {
			handle: () => undefined,
			removeHandler: () => undefined,
		},
		getMainWindow: () => null,
		registry: {} as never,
		panelHost: {} as never,
		getGuestWebContents: () => null,
		getPanelDescriptor: () => null,
	};
}

describe('plugin workspace IPC lifecycle', () => {
	it('registers only after every live dependency is supplied and disposes before host teardown', () => {
		const order: string[] = [];
		const deps = dependencies();
		const registrar = vi.fn((actual: PluginWorkspaceIpcRegistrationOptions) => {
			expect(actual).toBe(deps);
			order.push('registered');
			return { dispose: () => order.push('registration-disposed') };
		});

		const lifecycle = createPluginWorkspaceIpcLifecycle(deps, registrar);
		lifecycle.disposeBefore(() => order.push('host-torn-down'));
		lifecycle.disposeBefore(() => order.push('host-torn-down-again'));

		expect(registrar).toHaveBeenCalledOnce();
		expect(order).toEqual(['registered', 'registration-disposed', 'host-torn-down']);
	});
});
