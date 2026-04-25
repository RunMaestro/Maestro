import { memo } from 'react';
import { Play, Square, HelpCircle, LayoutGrid, Wand2 } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { useSettingsStore } from '../../stores/settingsStore';
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
	const compact = rightPanelWidth < 340;
	const btnClass =
		'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium transition-colors hover:bg-white/10';

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
					className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium transition-colors ${isStopping ? 'cursor-not-allowed' : ''}`}
					style={{
						backgroundColor: isStopping ? theme.colors.warning : theme.colors.error,
						color: isStopping ? theme.colors.bgMain : 'white',
						border: `1px solid ${isStopping ? theme.colors.warning : theme.colors.error}`,
						pointerEvents: isStopping ? 'none' : 'auto',
					}}
					title={isStopping ? 'Stopping after current task...' : 'Stop auto-run'}
				>
					{isStopping ? <Spinner size={14} /> : <Square className="w-3.5 h-3.5" />}
					{isStopping ? 'Stopping' : 'Stop'}
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
					disabled={isAgentBusy}
					className={`${btnClass} ${isAgentBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
					style={{
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.accent}40`,
						backgroundColor: `${theme.colors.accent}15`,
					}}
					title={isAgentBusy ? 'Cannot run while agent is thinking' : 'Run auto-run on tasks'}
				>
					{!compact && <Play className="w-3.5 h-3.5" />}
					Run
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
				>
					{!compact && <LayoutGrid className="w-3.5 h-3.5" />}
					PlayBooks
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
				>
					{!compact && <Wand2 className="w-3.5 h-3.5" />}
					Wizard
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
			>
				{!compact && <HelpCircle className="w-3.5 h-3.5" />}
				Help
			</button>
		</div>
	);
});
