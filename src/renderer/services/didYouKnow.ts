import { buildTipOrder, pickRandomTip } from '../../shared/didYouKnow';
import { useModalStore } from '../stores/modalStore';
import { useSettingsStore } from '../stores/settingsStore';

/** Open a random tip using current settings for both manual entry points. */
export function openRandomDidYouKnowTip(): void {
	const { didYouKnowSeed, didYouKnowSeenTipIds } = useSettingsStore.getState();
	const tip = pickRandomTip(buildTipOrder(didYouKnowSeed), didYouKnowSeenTipIds);
	useModalStore.getState().openModal('didYouKnow', { startTipId: tip?.id });
}
