/**
 * The desktop's library-runtime hosting, as the renderer and the bridge see it.
 *
 * Main hosts the maestro-lib runtime only when the `libraryRuntime` setting is on and the runtime
 * started (`src/main/library-runtime/`). The answer is fixed for the run: the setting is read once at
 * startup (DM2), so flipping it needs a restart and the renderer asks main instead of reading the
 * setting to learn which mode it is in.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` sections 4.1, 4.2 and 5.
 */

/** The preload namespace `window.maestro.libraryRuntime` and its channels. */
export const LIBRARY_RUNTIME_STATUS_CHANNEL = 'libraryRuntime:status';
/** Runtime events main forwards to every window, as `{ event: MaestroEvent }`. */
export const LIBRARY_RUNTIME_EVENT_CHANNEL = 'libraryRuntime:event';

export interface LibraryRuntimeStatus {
	/** Main runs the runtime and owns agent state this run. */
	hosting: boolean;
	/** Why not, when `hosting` is false: the setting is off, or the runtime refused. */
	reason?: string;
}

/** What a renderer reads when main has no answer: OFF, today's code. */
export const LIBRARY_RUNTIME_OFF: LibraryRuntimeStatus = {
	hosting: false,
	reason: 'The libraryRuntime setting is off.',
};
