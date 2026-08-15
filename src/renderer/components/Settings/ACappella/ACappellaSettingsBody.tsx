/**
 * The A Cappella config body for the extension detail pane's Settings sub-tab.
 *
 * Three surfaces stacked, in the order a user meets them: acquire the models
 * (Voice Setup), choose the engines and say where audio goes (Voice Providers),
 * then own the files (Models). The Models page is rendered whether or not the
 * Encore Feature is on, which is deliberate - the reclaim-disk offer only makes
 * sense after the feature has been switched off.
 */

import type { Theme } from '../../../types';
import { VoiceControlsPanel } from './VoiceControlsPanel';
import { VoiceModelsPage } from './VoiceModelsPage';
import { VoiceProvidersPanel } from './VoiceProvidersPanel';
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
			{enabled && <VoiceProvidersPanel theme={theme} enabled={enabled} />}
			{enabled && <VoiceControlsPanel theme={theme} enabled={enabled} />}
			<VoiceModelsPage theme={theme} enabled={enabled} />
		</div>
	);
}
