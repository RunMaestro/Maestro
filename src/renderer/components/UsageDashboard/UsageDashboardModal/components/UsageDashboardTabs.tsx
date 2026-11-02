import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import { useElementWidth, useScrollIntoView } from '../../../../hooks/ui';
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
		const stripRef = useRef<HTMLDivElement>(null);
		useImperativeHandle(ref, () => stripRef.current as HTMLDivElement);

		// When the strip is narrower than its tabs, the active one must stay on
		// screen: a tab picked by keyboard, or restored on reopen, can otherwise be
		// selected while scrolled out of sight.
		const activeIndex = viewModeTabs.findIndex((tab) => tab.value === viewMode);
		const tabRefs = useScrollIntoView<HTMLButtonElement>(true, activeIndex, viewModeTabs.length);

		// The modal is resizable, so narrowing it can push the active tab out of
		// view without the selection changing. Re-reveal it on every width change.
		// Keyed on width alone: a selection change is already revealed above, and
		// an instant scroll here would cancel that smooth one mid-flight.
		const stripWidth = useElementWidth(stripRef);
		useEffect(() => {
			if (stripWidth > 0) {
				tabRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
		}, [stripWidth]);

		return (
			<div
				ref={stripRef}
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
				{viewModeTabs.map((tab, index) => (
					<button
						key={tab.value}
						ref={(el) => {
							tabRefs.current[index] = el;
						}}
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
