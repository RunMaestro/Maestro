/**
 * Chain of thought export: the IPC channels of its one control.
 *
 * These channels turn the log on and off, pick its folder, and read it back.
 * A person at the desktop app is the only caller they serve. The main-process
 * handlers refuse every other sender (`assertDesktopSender` in
 * `src/main/ipc/handlers/cot-export.ts`), because the web bridge would
 * otherwise hand any registered channel to anything that holds its token, and
 * an agent's shell can read that token.
 *
 * The second lock is in the bridge itself: each channel is marked desktop-only
 * when its handler is registered (`src/main/ipc/desktop-only-channels.ts`),
 * and the bridge answers for a marked channel as it does for one nobody
 * registered.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

/** Every channel of the feature, by what it does. */
export const COT_EXPORT_CHANNELS = {
	/** What the person chose for an agent. */
	get: 'cotExport:get',
	/** Changes what the person chose. */
	set: 'cotExport:set',
	/** What the Edit Agent dialog shows about an agent's log. */
	status: 'cotExport:status',
	/** Whether a folder may hold an agent's log, with nothing changed. */
	validateFolder: 'cotExport:validateFolder',
	/** Walks every chain of an agent and checks it. */
	verify: 'cotExport:verify',
} as const;

/** The name of one channel in `COT_EXPORT_CHANNELS`. */
export type CotExportChannelName = keyof typeof COT_EXPORT_CHANNELS;

/** One channel of the feature, as it goes over IPC. */
export type CotExportChannel = (typeof COT_EXPORT_CHANNELS)[CotExportChannelName];
