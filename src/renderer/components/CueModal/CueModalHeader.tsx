/**
 * CueModalHeader — Title row + tab row, master toggle, help button, close button.
 *
 * Pure presentational; all state lives in the parent CueModal. React.memo
 * wrapped so shallow-stable props avoid re-render (tab switches and toggles
 * change state; identity of other props stays fixed across renders).
 */

import { memo } from 'react';
import { X, Zap, HelpCircle, LayoutDashboard, GitFork, ArrowLeft, Activity } from 'lucide-react';
import type { Theme } from '../../types';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';

export type CueModalTab = 'dashboard' | 'pipeline' | 'activity';

const TABS: ReadonlyArray<{
	id: CueModalTab;
	label: string;
	icon: typeof LayoutDashboard;
}> = [
	{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
	{ id: 'pipeline', label: 'Pipeline Editor', icon: GitFork },
	{ id: 'activity', label: 'Activity Log', icon: Activity },
];

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
		<div className="shrink-0">
			{/* Title row */}
			<div
				className="flex items-center justify-between px-5 py-4 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
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
							{/* Help button */}
							<button
								onClick={onOpenHelp}
								className="p-1 rounded hover:bg-white/10 transition-colors"
								aria-label="Open help"
								title="About Maestro Cue"
								style={{ color: theme.colors.textDim }}
							>
								<HelpCircle className="w-4 h-4" />
							</button>
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

			{/* Tab row (hidden in help view) */}
			{!showHelp && (
				<div
					className="flex items-center gap-1 px-4 py-2 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					{TABS.map(({ id, label, icon: Icon }) => {
						const isActive = activeTab === id;
						return (
							<button
								key={id}
								onClick={() => setActiveTab(id)}
								className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
									isActive ? 'font-semibold' : ''
								}`}
								style={{
									backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
									color: isActive ? theme.colors.accent : theme.colors.textDim,
								}}
							>
								<Icon className="w-3.5 h-3.5" />
								{label}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

export const CueModalHeader = memo(CueModalHeaderInner);
