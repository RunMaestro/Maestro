/**
 * Which mode the renderer runs in: today's (it owns the agent tree) or the library runtime's (main
 * owns it and this window mirrors it). Asked of main once, because the mode is fixed for the run
 * (DM2). A missing preload namespace, a failed call, and a test all read as OFF, so nothing changes
 * for code that does not know this exists.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` section 4.3.
 */

import { LIBRARY_RUNTIME_OFF, type LibraryRuntimeStatus } from '../../shared/libraryRuntime';

let known: LibraryRuntimeStatus | undefined;
let pending: Promise<LibraryRuntimeStatus> | undefined;

/** Ask main once and remember the answer. Never rejects. */
export function loadLibraryRuntimeStatus(): Promise<LibraryRuntimeStatus> {
	pending ??= (async () => {
		try {
			const api = window.maestro?.libraryRuntime;
			known = api ? await api.status() : LIBRARY_RUNTIME_OFF;
		} catch {
			known = LIBRARY_RUNTIME_OFF;
		}
		return known;
	})();
	return pending;
}

/** The answer `loadLibraryRuntimeStatus` found. False until it has. */
export function isLibraryRuntimeHosting(): boolean {
	return known?.hosting === true;
}

/** Forget the answer. For tests. */
export function resetLibraryRuntimeStatus(): void {
	known = undefined;
	pending = undefined;
}
