import type { BrowserWindow } from 'electron';
import type { IpcBootstrapDependencies } from './types';

/** Resolve the primary catch-all only when no secondary explicitly owns the agent. */
export function resolveSessionWindow(
	sessionId: string,
	deps: Pick<IpcBootstrapDependencies, 'windowRegistry' | 'getMainWindow'>
): BrowserWindow | null {
	const ownerId = deps.windowRegistry.getWindowForSession(sessionId);
	if (ownerId) return deps.windowRegistry.get(ownerId)?.browserWindow ?? null;
	return deps.getMainWindow();
}
