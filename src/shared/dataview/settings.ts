/**
 * Maestro's one Dataview settings object (DV-2). It holds Dataview 0.5.68's own defaults
 * (`DEFAULT_SETTINGS`): date and datetime formats, `renderNullAs`, task completion tracking off,
 * the inline query prefixes, and the rest. Every evaluation, query, and render passes this object,
 * so no caller builds ad-hoc settings. Upstream's `enableDataviewJs` and similar switches are
 * ignored; the `dataview` Encore Feature and the DataviewJS settings gate those instead (D3).
 */

import {
	DEFAULT_SETTINGS,
	type DataviewSettings as UpstreamDataviewSettings,
} from './vendor/settings';

export type DataviewSettings = UpstreamDataviewSettings;

/** Frozen so a caller cannot change the defaults for every later evaluation. */
export const DataviewSettings: Readonly<DataviewSettings> = Object.freeze({ ...DEFAULT_SETTINGS });
