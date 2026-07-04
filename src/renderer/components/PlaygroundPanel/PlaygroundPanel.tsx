import { useEffect, useRef } from 'react';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useFocusAfterRender } from '../../hooks/utils/useFocusAfterRender';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { CONDUCTOR_BADGES } from '../../constants/conductorBadges';
import { StandingOvationOverlay } from '../StandingOvationOverlay';
import { KeyboardMasteryCelebration } from '../KeyboardMasteryCelebration';
import { ResizeHandles } from '../ui/ResizeHandles';
import { usePlaygroundData } from './hooks';
import {
	AchievementsView,
	BatonView,
	ConfettiView,
	PlaygroundHeader,
	PlaygroundTabs,
} from './components';
import type { PlaygroundPanelProps } from './types';

export function PlaygroundPanel({ theme, themeMode, onClose }: PlaygroundPanelProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	const shouldFocusRef = useRef(true);
	onCloseRef.current = onClose;

	const { tabs, achievements, confetti, baton } = usePlaygroundData();
	const { activeTab, setActiveTab } = tabs;
	const ovationBadge = CONDUCTOR_BADGES.find(
		(badge) => badge.level === achievements.ovationBadgeLevel
	);

	useModalLayer(MODAL_PRIORITIES.STANDING_OVATION - 1, 'Developer Playground', () =>
		onCloseRef.current()
	);

	useFocusAfterRender(containerRef, shouldFocusRef.current);
	useEffect(() => {
		shouldFocusRef.current = false;
	}, []);
	const resizableModal = useResizableModal({
		resizeKey: 'developer-playground',
		defaultSize: { width: 960, height: 760 },
		minSize: { width: 720, height: 520 },
	});

	return (
		<>
			<div
				ref={containerRef}
				className="fixed inset-0 modal-overlay flex items-center justify-center z-[9998] animate-in fade-in duration-200"
				role="dialog"
				aria-modal="true"
				aria-label="Developer Playground"
				tabIndex={-1}
			>
				<div
					ref={resizableModal.modalRef}
					className="relative border rounded-lg shadow-2xl overflow-hidden flex flex-col select-none"
					style={{
						...resizableModal.style,
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
					}}
					data-modal-resize-key="developer-playground"
				>
					<ResizeHandles
						onResizeStart={resizableModal.onResizeStart}
						accentColor={theme.colors.accent}
					/>

					<PlaygroundHeader theme={theme} onClose={onClose} />
					<PlaygroundTabs theme={theme} activeTab={activeTab} onSelectTab={setActiveTab} />

					<div className="flex-1 overflow-auto p-6">
						{activeTab === 'achievements' && (
							<AchievementsView theme={theme} achievements={achievements} />
						)}
						{activeTab === 'confetti' && <ConfettiView theme={theme} confetti={confetti} />}
						{activeTab === 'baton' && <BatonView theme={theme} baton={baton} />}
					</div>
				</div>
			</div>

			{achievements.showStandingOvation && ovationBadge && (
				<StandingOvationOverlay
					theme={theme}
					themeMode={themeMode}
					badge={ovationBadge}
					cumulativeTimeMs={achievements.mockCumulativeTime}
					recordTimeMs={achievements.mockLongestRun}
					isNewRecord={achievements.ovationIsNewRecord}
					onClose={achievements.closeStandingOvation}
				/>
			)}

			{achievements.showKeyboardMasteryCelebration && (
				<KeyboardMasteryCelebration
					theme={theme}
					level={achievements.keyboardMasteryLevel}
					onClose={achievements.closeKeyboardMastery}
				/>
			)}
		</>
	);
}

export default PlaygroundPanel;
