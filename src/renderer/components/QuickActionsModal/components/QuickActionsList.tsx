import React from 'react';
import type { Theme } from '../../../types';
import { getStatusColor } from '../../../utils/theme';
import type { QuickAction } from '../types';
import { QuickActionRow } from './QuickActionRow';
import { SectionHeader } from './SectionHeader';

interface QuickActionsListProps {
	filtered: QuickAction[];
	selectedIndex: number;
	firstVisibleIndex: number;
	showBucketHeaders: boolean;
	now: number;
	theme: Theme;
	scrollContainerRef: React.Ref<HTMLDivElement>;
	selectedItemRef: React.Ref<HTMLButtonElement>;
	onScroll: () => void;
	onActionClick: (action: QuickAction) => void;
}

export function QuickActionsList({
	filtered,
	selectedIndex,
	firstVisibleIndex,
	showBucketHeaders,
	now,
	theme,
	scrollContainerRef,
	selectedItemRef,
	onScroll,
	onActionClick,
}: QuickActionsListProps) {
	return (
		<div
			className="overflow-y-auto py-2 scrollbar-thin"
			ref={scrollContainerRef}
			onScroll={onScroll}
		>
			{filtered.map((action, index) => {
				const maxFirstIndex = Math.max(0, filtered.length - 10);
				const effectiveFirstIndex = Math.min(firstVisibleIndex, maxFirstIndex);
				const distanceFromFirstVisible = index - effectiveFirstIndex;
				const showNumber = distanceFromFirstVisible >= 0 && distanceFromFirstVisible < 10;
				const numberBadge = distanceFromFirstVisible === 9 ? 0 : distanceFromFirstVisible + 1;

				const prev = index > 0 ? filtered[index - 1] : null;
				const isFirstRunning =
					showBucketHeaders && action.isRunningAgent === true && prev?.isRunningAgent !== true;
				const isFirstIdle =
					showBucketHeaders && action.isRunningAgent === false && prev?.isRunningAgent !== false;

				return (
					<React.Fragment key={action.id}>
						{isFirstRunning && <SectionHeader label="LIVE" color={getStatusColor('busy', theme)} />}
						{isFirstIdle && <SectionHeader label="IDLE" color={theme.colors.textDim} />}
						<QuickActionRow
							action={action}
							isSelected={index === selectedIndex}
							showNumber={showNumber}
							numberBadge={numberBadge}
							now={now}
							theme={theme}
							selectedItemRef={selectedItemRef}
							onClick={onActionClick}
						/>
					</React.Fragment>
				);
			})}
			{filtered.length === 0 && (
				<div className="px-4 py-4 text-center opacity-50 text-sm">No actions found</div>
			)}
		</div>
	);
}
