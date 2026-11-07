/** A Cappella's desktop HUD. Its originating app window remains the authority. */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { VoiceWidgetState } from '../../shared/floatingWidgets';
import { VoiceHud } from '../components/ACappella/VoiceHud';
import { LayerStackProvider } from '../contexts/LayerStackContext';
import { useVoiceSessionStore } from '../stores/voiceSessionStore';
import { useVoiceUiStore } from '../stores/voiceUiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { mirrorStoreState } from '../utils/windowStoreMirror';
import type { FloatingWidgetBodyProps } from './FloatingWidgetRoot';

const useVoiceWidgetSnapshot = create<{ snapshot: VoiceWidgetState | null }>()(() => ({
	snapshot: null,
}));

export function VoiceWidget({ theme }: FloatingWidgetBodyProps) {
	const snapshot = useVoiceWidgetSnapshot((s) => s.snapshot);
	useEffect(
		() =>
			mirrorStoreState('acappella-voice', useVoiceWidgetSnapshot, (next: VoiceWidgetState) => {
				// Apply data only. Existing store actions stay local, and the HUD sends
				// every control to the authority rather than invoking those actions.
				useVoiceSessionStore.setState(next.session);
				useVoiceUiStore.setState(next.ui);
				useSettingsStore.setState({ forcedParallelExecution: next.forceSendAllowed });
				return { snapshot: next };
			}),
		[]
	);

	if (!snapshot) return null;
	return (
		<LayerStackProvider>
			<VoiceHud
				theme={theme}
				enabled
				showDevHarness={false}
				floatingWindow
				widgetState={snapshot}
			/>
		</LayerStackProvider>
	);
}
