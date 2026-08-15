/**
 * The A Cappella config body for the extension detail pane's Settings sub-tab.
 *
 * Two surfaces stacked, in the order a user meets them: acquire the models
 * (Voice Setup), then own them (Models). Rendered whether or not the Encore
 * Feature is on, which is deliberate - the reclaim-disk offer on the Models page
 * only makes sense after the feature has been switched off.
 */

import type { Theme } from '../../../types';
import { VoiceModelsPage } from './VoiceModelsPage';
import { VoiceSetupPanel } from './VoiceSetupPanel';

export interface ACappellaSettingsBodyProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

export function ACappellaSettingsBody({ theme, enabled }: ACappellaSettingsBodyProps) {
	return (
		<div className="space-y-6">
			{enabled && <VoiceSetupPanel theme={theme} enabled={enabled} />}
			<VoiceModelsPage theme={theme} enabled={enabled} />
		</div>
	);
}
