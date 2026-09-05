import { memo } from 'react';
import { Play, Square, HelpCircle, LayoutGrid, Wand2 } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { useSettingsStore } from '../../stores/settingsStore';
import { RIGHT_PANEL_COMPACT_THRESHOLD } from '../../constants/rightPanel';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import type { Theme } from '../../types';

export interface AutoRunToolbarProps {
	theme: Theme;
	isAutoRunActive: boolean;
	isStopping: boolean;
	isAgentBusy: boolean;
	isDirty: boolean;
	sessionId: string;
	// Callbacks
	onOpenBatchRunner?: () => void;
	onStopBatchRun?: (sessionId?: string) => void;
	onOpenMarketplace?: () => void;
	onLaunchWizard?: () => void;
	onOpenHelp: () => void;
	onSave: () => Promise<void>;
	// File input
	fileInputRef: React.RefObject<HTMLInputElement>;
	onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const AutoRunToolbar = memo(function AutoRunToolbar({
	theme,
	isAutoRunActive,
	isStopping,
	isAgentBusy,
	isDirty,
	sessionId,
	onOpenBatchRunner,
	onStopBatchRun,
	onOpenMarketplace,
	onLaunchWizard,
	onOpenHelp,
	onSave,
	fileInputRef,
	onFileSelect,
}: AutoRunToolbarProps) {
	const rightPanelWidth = useSettingsStore((s) => s.rightPanelWidth);
	// Two ways to fit four buttons in a narrow bar, chosen by what is scarce:
	//   - `compact` (a narrow DESKTOP right panel) drops the icons and keeps the
	//     words, because a mouse user reads labels.
	//   - `iconOnly` (a PHONE) drops the words and keeps the icons, sized for a
	//     finger, with the label moved into the tooltip / accessible name. The
	//     row was overflowing its drawer by a full button before this.
	const phone = usePhoneLayout();
	const iconOnly = phone;
	const compact = !phone && rightPanelWidth < RIGHT_PANEL_COMPACT_THRESHOLD;
	const iconClass = iconOnly ? 'w-4 h-4' : 'w-3.5 h-3.5';
	const btnClass = `flex-1 flex items-center justify-center gap-1.5 rounded text-xs font-medium transition-colors hover:bg-white/10 ${
		iconOnly ? 'py-2.5 min-h-[44px]' : 'py-1.5'
	}`;

	return (
		<div className="flex gap-1.5 mb-3 px-2 pt-2">
			<input
				ref={fileInputRef}
				type="file"
				accept="image/*"
				onChange={onFileSelect}
				className="hidden"
			/>
			{/* Run / Stop button */}
			{isAutoRunActive ? (
				<button
					onClick={() => !isStopping && onStopBatchRun?.(sessionId)}
					disabled={isStopping}
					className={`flex-1 flex items-center justify-center gap-1.5 rounded text-xs font-medium transition-colors ${
						iconOnly ? 'py-2.5 min-h-[44px]' : 'py-1.5'
					} ${isStopping ? 'cursor-not-allowed' : ''}`}
					style={{
						backgroundColor: isStopping ? theme.colors.warning : theme.colors.error,
						color: isStopping ? theme.colors.bgMain : 'white',
						border: `1px solid ${isStopping ? theme.colors.warning : theme.colors.error}`,
						pointerEvents: isStopping ? 'none' : 'auto',
					}}
					title={isStopping ? 'Stopping after current task...' : 'Stop auto-run'}
					aria-label={isStopping ? 'Stopping' : 'Stop'}
				>
					{isStopping ? <Spinner size={14} /> : !compact && <Square className={iconClass} />}
					{!iconOnly && (isStopping ? 'Stopping' : 'Stop')}
				</button>
			) : (
				<button
					onClick={async () => {
						// Save before opening batch runner if dirty
						if (isDirty) {
							try {
								await onSave();
							} catch {
								return; // Don't open runner if save failed
							}
						}
						onOpenBatchRunner?.();
					}}
					className={btnClass}
					style={{
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.accent}40`,
						backgroundColor: `${theme.colors.accent}15`,
					}}
					title={
						isAgentBusy
							? 'Agent is thinking - you can configure auto-run, but launching is paused until it finishes'
							: 'Run auto-run on tasks'
					}
					aria-label="Run"
				>
					{!compact && <Play className={iconClass} />}
					{!iconOnly && 'Run'}
				</button>
			)}
			{/* PlayBooks button */}
			{onOpenMarketplace && (
				<button
					onClick={onOpenMarketplace}
					className={btnClass}
					style={{
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.accent}40`,
						backgroundColor: `${theme.colors.accent}15`,
					}}
					title="Browse PlayBooks - discover and share community playbooks"
					aria-label="PlayBooks"
				>
					{!compact && <LayoutGrid className={iconClass} />}
					{!iconOnly && 'PlayBooks'}
				</button>
			)}
			{/* Launch Wizard button */}
			{onLaunchWizard && (
				<button
					onClick={onLaunchWizard}
					className={btnClass}
					style={{
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.accent}40`,
						backgroundColor: `${theme.colors.accent}15`,
					}}
					title="Launch In-Tab Wizard"
					aria-label="Wizard"
				>
					{!compact && <Wand2 className={iconClass} />}
					{!iconOnly && 'Wizard'}
				</button>
			)}
			{/* Help button */}
			<button
				onClick={onOpenHelp}
				className={btnClass}
				style={{
					color: theme.colors.accent,
					border: `1px solid ${theme.colors.accent}40`,
					backgroundColor: `${theme.colors.accent}15`,
				}}
				title="Learn about Auto Runner"
				aria-label="Help"
			>
				{!compact && <HelpCircle className={iconClass} />}
				{!iconOnly && 'Help'}
			</button>
		</div>
	);
});
