import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { UsageDashboardViewMode as ViewMode } from '../../../../types';
import { useUIStore } from '../../../../stores/uiStore';
import { BASE_VIEW_MODE_TABS } from '../constants';
import type { UsageDashboardTab } from '../types';

interface UseUsageDashboardTabsOptions {
	cueTabEnabled: boolean;
	hasAnthropicUsageDetails: boolean;
	hasCodexUsageDetails: boolean;
	contentRef: RefObject<HTMLDivElement | null>;
	onViewModeChanged: () => void;
}

export function useUsageDashboardTabs({
	cueTabEnabled,
	hasAnthropicUsageDetails,
	hasCodexUsageDetails,
	contentRef,
	onViewModeChanged,
}: UseUsageDashboardTabsOptions) {
	const setUsageDashboardViewMode = useUIStore((s) => s.setUsageDashboardViewMode);
	const [viewMode, setViewMode] = useState<ViewMode>(
		() => useUIStore.getState().usageDashboardViewMode
	);
	const viewModeRef = useRef(viewMode);
	viewModeRef.current = viewMode;

	const viewModeTabs = useMemo<UsageDashboardTab[]>(() => {
		const tabs: UsageDashboardTab[] = [];
		for (const tab of BASE_VIEW_MODE_TABS) {
			tabs.push(tab);
			if (tab.value === 'autorun' && cueTabEnabled) {
				tabs.push({ value: 'cue', label: 'Cue' });
			}
		}
		if (hasAnthropicUsageDetails) {
			tabs.push({ value: 'anthropic-usage', label: 'Anthropic Usage' });
		}
		if (hasCodexUsageDetails) {
			tabs.push({ value: 'codex-usage', label: 'OpenAI Usage' });
		}
		return tabs;
	}, [cueTabEnabled, hasAnthropicUsageDetails, hasCodexUsageDetails]);

	const switchViewMode = useCallback(
		(mode: ViewMode) => {
			setViewMode(mode);
			setUsageDashboardViewMode(mode);
			onViewModeChanged();
			if (contentRef.current) {
				contentRef.current.scrollTop = 0;
			}
		},
		[contentRef, onViewModeChanged, setUsageDashboardViewMode]
	);

	useEffect(() => {
		if (!viewModeTabs.some((tab) => tab.value === viewMode)) {
			switchViewMode('overview');
		}
	}, [viewModeTabs, viewMode, switchViewMode]);

	return {
		viewMode,
		viewModeRef,
		viewModeTabs,
		switchViewMode,
	};
}
