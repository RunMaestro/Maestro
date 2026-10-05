import { describe, expect, it, vi } from 'vitest';

const createDesktopBinding = vi.fn();
const installRuntimeStoreFacade = vi.fn();
const createDesktopEffects = vi.fn();
vi.mock('../../../main/library-runtime/desktop-binding', () => ({
	createDesktopBinding: (...args: unknown[]) => createDesktopBinding(...args),
}));
vi.mock('../../../main/library-runtime/store-facade', () => ({
	installRuntimeStoreFacade: (...args: unknown[]) => installRuntimeStoreFacade(...args),
}));
vi.mock('../../../main/library-runtime/desktop-effects', () => ({
	createDesktopEffects: (...args: unknown[]) => createDesktopEffects(...args),
}));

import { wireDesktopRuntime } from '../../../main/library-runtime/desktop-wiring';

describe('wireDesktopRuntime', () => {
	const effects = {
		recordSessionCreated: vi.fn(),
		recordSessionClosed: vi.fn(),
		syncProviderSessionName: vi.fn(),
	};

	it('builds nothing when the runtime has no desktop api', () => {
		expect(
			wireDesktopRuntime({
				runtime: {} as never,
				sessionsStore: {} as never,
				groupsStore: {} as never,
				effects,
			})
		).toBeNull();
		expect(createDesktopBinding).not.toHaveBeenCalled();
	});

	it('binds, installs the facade, starts the effects from the current agents, and takes it all down on dispose', () => {
		const stopEffects = vi.fn();
		const removeFacade = vi.fn();
		const binding = { onEvent: vi.fn(() => stopEffects), dispose: vi.fn() };
		createDesktopBinding.mockReturnValue(binding);
		installRuntimeStoreFacade.mockReturnValue(removeFacade);
		createDesktopEffects.mockReturnValue('listener');
		const desktop = { snapshot: () => ({ agents: [{ id: 'a1', name: 'One' }] }) };
		const sessionsStore = {};
		const groupsStore = {};

		const wiring = wireDesktopRuntime({
			runtime: { desktop } as never,
			sessionsStore: sessionsStore as never,
			groupsStore: groupsStore as never,
			effects,
		});

		expect(wiring?.binding).toBe(binding);
		expect(installRuntimeStoreFacade).toHaveBeenCalledWith({
			sessionsStore,
			groupsStore,
			desktop,
			binding,
		});
		expect(createDesktopEffects).toHaveBeenCalledWith({
			...effects,
			initialAgents: [{ id: 'a1', name: 'One' }],
		});
		expect(binding.onEvent).toHaveBeenCalledWith('listener');

		wiring?.dispose();
		expect(stopEffects).toHaveBeenCalled();
		expect(removeFacade).toHaveBeenCalled();
		expect(binding.dispose).toHaveBeenCalled();
	});
});
