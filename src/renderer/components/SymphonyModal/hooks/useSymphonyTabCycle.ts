import { useEffect } from 'react';
import type { ModalTab } from '../types';
import { SYMPHONY_TABS } from '../types';

export interface UseSymphonyTabCycleParams {
	isOpen: boolean;
	activeTab: ModalTab;
	onTabChange: (tab: ModalTab) => void;
}

/**
 * Wires Cmd+Shift+[ and Cmd+Shift+] to cycle through the four SymphonyModal
 * tabs, wrapping at both ends. No-op when the modal is closed.
 *
 * Uses preventDefault + stopPropagation so the shortcut doesn't bubble out of
 * the modal (e.g. to global app-level keybindings).
 */
export function useSymphonyTabCycle({
	isOpen,
	activeTab,
	onTabChange,
}: UseSymphonyTabCycleParams): void {
	useEffect(() => {
		if (!isOpen) return;
		const tabs = SYMPHONY_TABS;
		const handle = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();
				const currentIndex = tabs.indexOf(activeTab);
				const newIndex =
					e.key === '['
						? currentIndex <= 0
							? tabs.length - 1
							: currentIndex - 1
						: currentIndex >= tabs.length - 1
							? 0
							: currentIndex + 1;
				onTabChange(tabs[newIndex]);
			}
		};
		window.addEventListener('keydown', handle);
		return () => window.removeEventListener('keydown', handle);
	}, [isOpen, activeTab, onTabChange]);
}
