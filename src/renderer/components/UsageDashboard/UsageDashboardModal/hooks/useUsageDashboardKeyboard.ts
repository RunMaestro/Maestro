import {
	useCallback,
	useEffect,
	type MutableRefObject,
	type RefObject,
	type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { StatsAggregation } from '../../../../../shared/stats-types';
import type { UsageDashboardViewMode as ViewMode } from '../../../../types';
import type { SectionId } from '../sections';
import type { UsageDashboardTab } from '../types';

interface UseUsageDashboardKeyboardOptions {
	isOpen: boolean;
	viewMode: ViewMode;
	viewModeRef: MutableRefObject<ViewMode>;
	viewModeTabs: UsageDashboardTab[];
	switchViewMode: (mode: ViewMode) => void;
	currentSections: readonly SectionId[];
	data: StatsAggregation | null;
	tabsRef: RefObject<HTMLDivElement | null>;
	sectionRefs: MutableRefObject<Map<SectionId, HTMLDivElement>>;
	setFocusedSection: (sectionId: SectionId | null) => void;
}

export function useUsageDashboardKeyboard({
	isOpen,
	viewMode,
	viewModeRef,
	viewModeTabs,
	switchViewMode,
	currentSections,
	data,
	tabsRef,
	sectionRefs,
	setFocusedSection,
}: UseUsageDashboardKeyboardOptions) {
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.metaKey && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();

				const currentIndex = viewModeTabs.findIndex((tab) => tab.value === viewModeRef.current);

				if (e.key === '[') {
					const prevIndex = currentIndex > 0 ? currentIndex - 1 : viewModeTabs.length - 1;
					switchViewMode(viewModeTabs[prevIndex].value);
				} else {
					const nextIndex = currentIndex < viewModeTabs.length - 1 ? currentIndex + 1 : 0;
					switchViewMode(viewModeTabs[nextIndex].value);
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [isOpen, switchViewMode, viewModeTabs, viewModeRef]);

	const navigateToSection = useCallback(
		(sectionId: SectionId) => {
			setFocusedSection(sectionId);
			const sectionEl = sectionRefs.current.get(sectionId);
			if (sectionEl) {
				sectionEl.focus();
				sectionEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			}
		},
		[sectionRefs, setFocusedSection]
	);

	const handleTabKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			const currentIndex = viewModeTabs.findIndex((tab) => tab.value === viewMode);

			if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
				event.preventDefault();
				const prevIndex = currentIndex > 0 ? currentIndex - 1 : viewModeTabs.length - 1;
				switchViewMode(viewModeTabs[prevIndex].value);
			} else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
				event.preventDefault();
				const nextIndex = currentIndex < viewModeTabs.length - 1 ? currentIndex + 1 : 0;
				switchViewMode(viewModeTabs[nextIndex].value);
			} else if (event.key === 'Tab' && !event.shiftKey) {
				if (currentSections.length > 0 && data) {
					event.preventDefault();
					navigateToSection(currentSections[0]);
				}
			}
		},
		[viewMode, switchViewMode, currentSections, data, navigateToSection, viewModeTabs]
	);

	const handleSectionKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>, sectionId: SectionId) => {
			const sectionIndex = currentSections.indexOf(sectionId);

			if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
				event.preventDefault();
				if (sectionIndex > 0) {
					navigateToSection(currentSections[sectionIndex - 1]);
				} else {
					setFocusedSection(null);
					tabsRef.current?.focus();
				}
			} else if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
				event.preventDefault();
				if (sectionIndex < currentSections.length - 1) {
					navigateToSection(currentSections[sectionIndex + 1]);
				}
			} else if (event.key === 'Home') {
				event.preventDefault();
				navigateToSection(currentSections[0]);
			} else if (event.key === 'End') {
				event.preventDefault();
				navigateToSection(currentSections[currentSections.length - 1]);
			}
		},
		[currentSections, navigateToSection, setFocusedSection, tabsRef]
	);

	const setSectionRef = useCallback(
		(sectionId: SectionId) => (el: HTMLDivElement | null) => {
			if (el) {
				sectionRefs.current.set(sectionId, el);
			} else {
				sectionRefs.current.delete(sectionId);
			}
		},
		[sectionRefs]
	);

	return {
		handleTabKeyDown,
		handleSectionKeyDown,
		setSectionRef,
	};
}
