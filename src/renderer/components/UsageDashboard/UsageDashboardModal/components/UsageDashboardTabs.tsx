import { forwardRef, type KeyboardEvent } from 'react';
import type { UsageDashboardViewMode as ViewMode } from '../../../../types';
import type { UsageDashboardTab, UsageDashboardModalProps } from '../types';

interface UsageDashboardTabsProps {
	theme: UsageDashboardModalProps['theme'];
	viewMode: ViewMode;
	viewModeTabs: UsageDashboardTab[];
	switchViewMode: (viewMode: ViewMode) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export const UsageDashboardTabs = forwardRef<HTMLDivElement, UsageDashboardTabsProps>(
	function UsageDashboardTabs({ theme, viewMode, viewModeTabs, switchViewMode, onKeyDown }, ref) {
		return (
			<div
				ref={ref}
				className="px-6 py-2 border-b flex items-center gap-1 flex-shrink-0 outline-none"
				style={{ borderColor: theme.colors.border }}
				role="tablist"
				aria-label="Dashboard view modes"
				tabIndex={0}
				onKeyDown={onKeyDown}
				data-testid="view-mode-tabs"
			>
				{viewModeTabs.map((tab) => (
					<button
						key={tab.value}
						onClick={() => switchViewMode(tab.value)}
						className="px-4 py-2 rounded-lg text-sm font-medium transition-colors outline-none"
						style={{
							backgroundColor: viewMode === tab.value ? `${theme.colors.accent}20` : 'transparent',
							color: viewMode === tab.value ? theme.colors.accent : theme.colors.textDim,
						}}
						onMouseEnter={(event) => {
							if (viewMode !== tab.value) {
								event.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
							}
						}}
						onMouseLeave={(event) => {
							if (viewMode !== tab.value) {
								event.currentTarget.style.backgroundColor = 'transparent';
							}
						}}
						role="tab"
						aria-selected={viewMode === tab.value}
						aria-controls={`tabpanel-${tab.value}`}
						id={`tab-${tab.value}`}
						tabIndex={-1}
					>
						{tab.label}
					</button>
				))}
			</div>
		);
	}
);
