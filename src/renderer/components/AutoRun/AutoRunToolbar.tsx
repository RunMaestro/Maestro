import { memo } from 'react';
import { Eye, Edit, Play, Square, HelpCircle, Maximize2, LayoutGrid, Wand2 } from 'lucide-react';
import { Spinner } from '../ui';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import type { Theme, Shortcut } from '../../types';

export interface AutoRunToolbarProps {
	theme: Theme;
	mode: 'edit' | 'preview';
	isLocked: boolean;
	isAutoRunActive: boolean;
	isStopping: boolean;
	isAgentBusy: boolean;
	isDirty: boolean;
	sessionId: string;
	shortcuts?: Record<string, Shortcut>;
	// Callbacks
	onSwitchMode: (mode: 'edit' | 'preview') => void;
	onExpand?: () => void;
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
	mode,
	isLocked,
	isAutoRunActive,
	isStopping,
	isAgentBusy,
	isDirty,
	sessionId,
	shortcuts,
	onSwitchMode,
	onExpand,
	onOpenBatchRunner,
	onStopBatchRun,
	onOpenMarketplace,
	onLaunchWizard,
	onOpenHelp,
	onSave,
	fileInputRef,
	onFileSelect,
}: AutoRunToolbarProps) {
	return (
		<div className="flex gap-2 mb-3 justify-center pt-2">
			{/* Expand button */}
			{onExpand && (
				<button
					onClick={onExpand}
					className="flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-white/10"
					style={{
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
					}}
					title={`Expand to full screen${shortcuts?.toggleAutoRunExpanded ? ` (${formatShortcutKeys(shortcuts.toggleAutoRunExpanded.keys)})` : ''}`}
				>
					<Maximize2 className="w-3.5 h-3.5" />
				</button>
			)}
			<button
				onClick={() => !isLocked && onSwitchMode('edit')}
				disabled={isLocked}
				className={`flex items-center justify-center w-8 h-8 rounded transition-colors ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
				style={{
					backgroundColor: mode === 'edit' && !isLocked ? theme.colors.bgActivity : 'transparent',
					color: isLocked
						? theme.colors.textDim
						: mode === 'edit'
							? theme.colors.textMain
							: theme.colors.textDim,
					border: `1px solid ${mode === 'edit' && !isLocked ? theme.colors.accent : theme.colors.border}`,
				}}
				title={isLocked ? 'Editing disabled while Auto Run active' : 'Edit document'}
			>
				<Edit className="w-3.5 h-3.5" />
			</button>
			<button
				onClick={() => onSwitchMode('preview')}
				className="flex items-center justify-center w-8 h-8 rounded transition-colors"
				style={{
					backgroundColor: mode === 'preview' || isLocked ? theme.colors.bgActivity : 'transparent',
					color: mode === 'preview' || isLocked ? theme.colors.textMain : theme.colors.textDim,
					border: `1px solid ${mode === 'preview' || isLocked ? theme.colors.accent : theme.colors.border}`,
				}}
				title="Preview document"
			>
				<Eye className="w-3.5 h-3.5" />
			</button>
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
					className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors font-semibold ${isStopping ? 'cursor-not-allowed' : ''}`}
					style={{
						backgroundColor: isStopping ? theme.colors.warning : theme.colors.error,
						color: isStopping ? theme.colors.bgMain : 'white',
						border: `1px solid ${isStopping ? theme.colors.warning : theme.colors.error}`,
						pointerEvents: isStopping ? 'none' : 'auto',
					}}
					title={isStopping ? 'Stopping after current task...' : 'Stop auto-run'}
				>
					{isStopping ? (
						<Spinner size="xs" className="w-3.5 h-3.5" />
					) : (
						<Square className="w-3.5 h-3.5" />
					)}
					{isStopping ? 'Stopping...' : 'Stop'}
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
					className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${isAgentBusy ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}`}
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
						border: `1px solid ${theme.colors.accent}`,
					}}
					title={isAgentBusy ? 'Cannot run while agent is thinking' : 'Run auto-run on tasks'}
				>
					<Play className="w-3.5 h-3.5" />
					Run
				</button>
			)}
			{/* Playbook Exchange button */}
			{onOpenMarketplace && (
				<button
					onClick={onOpenMarketplace}
					className="flex items-center gap-1.5 px-2 h-8 rounded transition-colors hover:opacity-90"
					style={{
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.accent}40`,
						backgroundColor: `${theme.colors.accent}15`,
					}}
					title="Browse Playbook Exchange - discover and share community playbooks"
				>
					<LayoutGrid className="w-3.5 h-3.5" />
					<span className="text-xs font-medium">Exchange</span>
				</button>
			)}
			{/* Launch Wizard button */}
			{onLaunchWizard && (
				<button
					onClick={onLaunchWizard}
					className="flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-white/10"
					style={{
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.border}`,
					}}
					title="Launch In-Tab Wizard"
				>
					<Wand2 className="w-3.5 h-3.5" />
				</button>
			)}
			{/* Help button */}
			<button
				onClick={onOpenHelp}
				className="flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-white/10"
				style={{
					color: theme.colors.textDim,
					border: `1px solid ${theme.colors.border}`,
				}}
				title="Learn about Auto Runner"
			>
				<HelpCircle className="w-3.5 h-3.5" />
			</button>
		</div>
	);
});
