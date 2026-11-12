import { forwardRef, useCallback, type KeyboardEvent } from 'react';
import { revealActiveProps, useRevealActiveItem } from '../../../../hooks/ui';
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
		// The strip scrolls sideways when it is narrower than its tabs, so the
		// active one has to be kept on screen: a tab picked by keyboard, restored
		// on reopen, or pushed off by resizing the modal.
		const revealRef = useRevealActiveItem<HTMLDivElement>(viewMode);
		const setStrip = useCallback(
			(element: HTMLDivElement | null) => {
				revealRef(element);
				if (typeof ref === 'function') ref(element);
				else if (ref) ref.current = element;
			},
			[revealRef, ref]
		);

		return (
			<div
				ref={setStrip}
				// The strip scrolls sideways rather than wrapping: seven tabs do not fit
				// a phone, and a wrapped tab row put "Agent Overview" on two lines.
				className="px-6 py-2 border-b flex items-center gap-1 flex-shrink-0 outline-none overflow-x-auto no-scrollbar"
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
						{...revealActiveProps(viewMode === tab.value)}
						onClick={() => switchViewMode(tab.value)}
						className="px-4 py-2 rounded-lg text-sm font-medium transition-colors outline-none whitespace-nowrap shrink-0"
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
