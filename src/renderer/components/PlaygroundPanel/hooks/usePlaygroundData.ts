import { useAchievementPlayground } from './useAchievementPlayground';
import { useBatonPlayground } from './useBatonPlayground';
import { useConfettiPlayground } from './useConfettiPlayground';
import { usePlaygroundTabs } from './usePlaygroundTabs';
import type { PlaygroundData } from '../types';

export function usePlaygroundData(): PlaygroundData {
	return {
		tabs: usePlaygroundTabs(),
		achievements: useAchievementPlayground(),
		confetti: useConfettiPlayground(),
		baton: useBatonPlayground(),
	};
}
