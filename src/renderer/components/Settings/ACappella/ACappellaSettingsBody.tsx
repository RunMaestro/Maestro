/**
 * The A Cappella config body for the extension detail pane's Settings sub-tab.
 *
 * Voice input, providers, controls, output, devices, and diagnostics live here.
 * Model files are managed in the global Models settings.
 */

import { useCallback, useState } from 'react';
import type { Theme } from '../../../types';
import { PairedDevicesPanel } from './PairedDevicesPanel';
import { VoiceControlsPanel } from './VoiceControlsPanel';
import { VoiceDiagnosticsCard } from './VoiceDiagnosticsCard';
import { VoiceLatencyCard } from './VoiceLatencyCard';
import { VoiceSelfTestCard } from './VoiceSelfTestCard';
import { VoiceOutputPanel } from './VoiceOutputPanel';
import { VoiceProvidersPanel } from './VoiceProvidersPanel';
import { VoiceSetupPanel } from './VoiceSetupPanel';

export interface ACappellaSettingsBodyProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

export function ACappellaSettingsBody({ theme, enabled }: ACappellaSettingsBodyProps) {
	const [selectionVersion, setSelectionVersion] = useState(0);
	const refreshSelection = useCallback(() => setSelectionVersion((version) => version + 1), []);
	return (
		<div className="space-y-5">
			{enabled && <VoiceSetupPanel theme={theme} enabled={enabled} />}
			{enabled && (
				<VoiceProvidersPanel
					theme={theme}
					enabled={enabled}
					onSelectionChanged={refreshSelection}
				/>
			)}
			{enabled && <VoiceControlsPanel theme={theme} enabled={enabled} />}
			{enabled && (
				<VoiceOutputPanel theme={theme} enabled={enabled} selectionVersion={selectionVersion} />
			)}
			{enabled && <PairedDevicesPanel theme={theme} enabled={enabled} />}
			{enabled && <VoiceDiagnosticsCard theme={theme} />}
			{enabled && <VoiceSelfTestCard theme={theme} />}
			{enabled && <VoiceLatencyCard theme={theme} />}
		</div>
	);
}
