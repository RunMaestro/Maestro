/**
 * CueModalHeader — Tab bar, master toggle, help button, close button.
 *
 * Pure presentational; all state lives in the parent CueModal. React.memo
 * wrapped so shallow-stable props avoid re-render (tab switches and toggles
 * change state; identity of other props stays fixed across renders).
 */

import { memo } from 'react';
import { X, Zap, HelpCircle, LayoutDashboard, GitFork, ArrowLeft } from 'lucide-react';
import type { Theme } from '../../types';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';

export type CueModalTab = 'dashboard' | 'pipeline';

export interface CueModalHeaderProps {
	theme: Theme;
	activeTab: CueModalTab;
	setActiveTab: (tab: CueModalTab) => void;
	isEnabled: boolean;
	toggling: boolean;
	handleToggle: () => void;
	showHelp: boolean;
	onOpenHelp: () => void;
	onCloseHelp: () => void;
	onClose: () => void;
}

function CueModalHeaderInner({
	theme,
	activeTab,
	setActiveTab,
	isEnabled,
	toggling,
	handleToggle,
	showHelp,
	onOpenHelp,
	onCloseHelp,
	onClose,
}: CueModalHeaderProps) {
	return (
		<div
			className="flex items-center justify-between px-5 py-4 border-b shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-3">
				{showHelp ? (
					<>
						<button
							onClick={onCloseHelp}
							className="p-1 rounded-md hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Back to dashboard"
							title="Back to dashboard"
						>
							<ArrowLeft className="w-4 h-4" />
						</button>
						<Zap className="w-5 h-5" style={{ color: CUE_COLOR }} />
						<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
							Maestro Cue Guide
						</h2>
					</>
				) : (
					<>
						<Zap className="w-5 h-5" style={{ color: CUE_COLOR }} />
						<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
							Maestro Cue
						</h2>

						{/* Tab bar */}
						<div
							className="flex items-center gap-1 ml-3 rounded-md p-0.5"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							<button
								onClick={() => setActiveTab('dashboard')}
								className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors"
								style={{
									backgroundColor: activeTab === 'dashboard' ? theme.colors.bgMain : 'transparent',
									color: activeTab === 'dashboard' ? theme.colors.textMain : theme.colors.textDim,
								}}
							>
								<LayoutDashboard className="w-3.5 h-3.5" />
								Dashboard
							</button>
							<button
								onClick={() => setActiveTab('pipeline')}
								className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors"
								style={{
									backgroundColor: activeTab === 'pipeline' ? theme.colors.bgMain : 'transparent',
									color: activeTab === 'pipeline' ? theme.colors.textMain : theme.colors.textDim,
								}}
							>
								<GitFork className="w-3.5 h-3.5" />
								Pipeline Editor
							</button>
						</div>
					</>
				)}
			</div>
			<div className="flex items-center gap-3">
				{!showHelp && (
					<>
						{/* Master toggle */}
						<button
							onClick={handleToggle}
							disabled={toggling}
							role="switch"
							aria-checked={isEnabled}
							aria-disabled={toggling || undefined}
							aria-label={isEnabled ? 'Disable Cue' : 'Enable Cue'}
							className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
							style={{
								backgroundColor: isEnabled ? `${theme.colors.accent}20` : theme.colors.bgActivity,
								color: isEnabled ? theme.colors.accent : theme.colors.textDim,
							}}
						>
							<div
								className="relative w-8 h-4 rounded-full transition-colors"
								style={{
									backgroundColor: isEnabled ? theme.colors.accent : theme.colors.border,
								}}
							>
								<div
									className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
									style={{
										transform: isEnabled ? 'translateX(17px)' : 'translateX(2px)',
									}}
								/>
							</div>
							{isEnabled ? 'Enabled' : 'Disabled'}
						</button>

						{/* Help button */}
						<button
							onClick={onOpenHelp}
							className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
							aria-label="Open help"
							title="Help"
							style={{ color: theme.colors.textDim }}
						>
							<HelpCircle className="w-4 h-4" />
						</button>
					</>
				)}

				{/* Close button */}
				<button
					onClick={onClose}
					className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
					aria-label="Close"
					title="Close"
				>
					<X className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
}

export const CueModalHeader = memo(CueModalHeaderInner);
