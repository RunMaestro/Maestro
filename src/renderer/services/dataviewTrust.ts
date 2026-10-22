/**
 * dataviewTrust - the renderer's way to edit the DataviewJS trust list (D3, DV-12).
 *
 * Every edit goes through main's DataviewService (`dataview:trust`, `dataview:untrust`), the same methods
 * `maestro-cli dataview trust` and `untrust` reach, so the settings UI, a block's "Always trust this vault",
 * and the CLI store one normalized list. Main then tells every window to reload settings; this window
 * applies the answered list at once, so the block or the settings row it came from updates without waiting.
 */

import type { DataviewTrustResponse } from '../../shared/dataview';
import { useSettingsStore } from '../stores/settingsStore';

function applyTrustResponse(response: DataviewTrustResponse): DataviewTrustResponse {
	// Main already wrote the setting; set the store only, never write it back.
	useSettingsStore.setState({ dataviewJsTrustedRoots: response.roots });
	return response;
}

/** Trust a vault root: its DataviewJS blocks run without asking. */
export async function trustDataviewRoot(root: string): Promise<DataviewTrustResponse> {
	return applyTrustResponse(await window.maestro.dataview.trust({ root }));
}

/** Stop trusting a vault root: its DataviewJS blocks ask again, and its "Run once" grants end. */
export async function untrustDataviewRoot(root: string): Promise<DataviewTrustResponse> {
	return applyTrustResponse(await window.maestro.dataview.untrust({ root }));
}
