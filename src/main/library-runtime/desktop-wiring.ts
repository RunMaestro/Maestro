/**
 * Everything main puts around a hosted runtime, assembled in one place so `index.ts` makes one call:
 * the desktop binding, the store facade over the sessions and groups stores, and the side-effect
 * listener (4.9). With no runtime hosted nothing here is built.
 */

import type Store from 'electron-store';

import { createDesktopBinding, type DesktopBinding, type DesktopRuntime } from './desktop-binding';
import { createDesktopEffects, type DesktopEffectsDeps } from './desktop-effects';
import { installRuntimeStoreFacade } from './store-facade';
import type { MaestroRuntime } from '../../shared/maestro-lib/runtime';

export interface DesktopWiringOptions {
	runtime: MaestroRuntime;
	sessionsStore: Store<any>;
	groupsStore: Store<any>;
	effects: Omit<DesktopEffectsDeps, 'initialAgents'>;
}

export interface DesktopWiring {
	binding: DesktopBinding;
	/** Stop the listeners, put the stores back, and let go of the runtime. Does not close the runtime. */
	dispose(): void;
}

/** Null when the runtime has no desktop API (it was not started in mode `desktop`). */
export function wireDesktopRuntime(options: DesktopWiringOptions): DesktopWiring | null {
	const { runtime } = options;
	if (!runtime.desktop) return null;
	const hosted = runtime as DesktopRuntime;

	const binding = createDesktopBinding(hosted);
	const removeFacade = installRuntimeStoreFacade({
		sessionsStore: options.sessionsStore,
		groupsStore: options.groupsStore,
		desktop: hosted.desktop,
		binding,
	});
	const stopEffects = binding.onEvent(
		createDesktopEffects({ ...options.effects, initialAgents: hosted.desktop.snapshot().agents })
	);

	return {
		binding,
		dispose() {
			stopEffects();
			removeFacade();
			binding.dispose();
		},
	};
}
