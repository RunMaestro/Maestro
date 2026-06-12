import { useState } from 'react';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import type { TabId } from '../types';

const TAB_ORDER: TabId[] = ['achievements', 'confetti', 'baton'];

export function usePlaygroundTabs() {
	const [activeTab, setActiveTab] = useState<TabId>('achievements');

	useEventListener('keydown', (event) => {
		const e = event as KeyboardEvent;
		if (!e.metaKey || !e.shiftKey) return;

		if (e.key === '[' || e.key === '{') {
			e.preventDefault();
			setActiveTab((previousTab) => {
				const currentIndex = TAB_ORDER.findIndex((tab) => tab === previousTab);
				const newIndex = currentIndex <= 0 ? TAB_ORDER.length - 1 : currentIndex - 1;
				return TAB_ORDER[newIndex];
			});
		} else if (e.key === ']' || e.key === '}') {
			e.preventDefault();
			setActiveTab((previousTab) => {
				const currentIndex = TAB_ORDER.findIndex((tab) => tab === previousTab);
				const newIndex = currentIndex >= TAB_ORDER.length - 1 ? 0 : currentIndex + 1;
				return TAB_ORDER[newIndex];
			});
		}
	});

	return { activeTab, setActiveTab };
}
