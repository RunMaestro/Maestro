import { forwardRef } from 'react';
import { Music, HelpCircle, Github, RefreshCw, X } from 'lucide-react';
import { GhostIconButton } from '../../ui/GhostIconButton';
import type { Theme } from '../../../types';
import { buildMaestroUrl } from '../../../utils/buildMaestroUrl';
import { openUrl } from '../../../utils/openUrl';
import { formatCacheAge } from '../helpers/formatters';

export interface SymphonyHeaderProps {
	theme: Theme;
	/** Show the "Cached / Live" indicator. Hidden on tabs other than Projects. */
	showCacheStatus: boolean;
	fromCache: boolean;
	cacheAge: number | null;
	isRefreshing: boolean;
	onRefresh: () => void;
	onClose: () => void;
	/** Sets the shared `showHelp` flag in the shell. The header owns the popover UI. */
	showHelp: boolean;
	onToggleHelp: () => void;
	onCloseHelp: () => void;
}

/**
 * Top header of the SymphonyModal - title, help popover, register-link,
 * refresh button, close button.
 *
 * `forwardRef` exposes the help-button DOM node so the shell can manage focus
 * when the help popover is opened by the layer-stack Esc handler.
 */
export const SymphonyHeader = forwardRef<HTMLButtonElement, SymphonyHeaderProps>(
	function SymphonyHeader(
		{
			theme,
			showCacheStatus,
			fromCache,
			cacheAge,
			isRefreshing,
			onRefresh,
			onClose,
			showHelp,
			onToggleHelp,
			onCloseHelp,
		},
		helpButtonRef
	) {
		const helpPopoverId = 'symphony-help-popover';

		return (
			<div
				className="flex items-center justify-between px-4 py-3 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<Music className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h2
						id="symphony-modal-title"
						className="text-lg font-semibold"
						style={{ color: theme.colors.textMain }}
					>
						Maestro Symphony
					</h2>
					{/* Help button */}
					<div className="relative">
						<button
							ref={helpButtonRef}
							onClick={onToggleHelp}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							title="About Maestro Symphony"
							aria-label="Help"
							aria-expanded={showHelp}
							aria-controls={helpPopoverId}
						>
							<HelpCircle className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						</button>
						{showHelp && (
							<div
								id={helpPopoverId}
								className="absolute top-full left-0 mt-2 w-80 p-4 rounded-lg shadow-xl z-50"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<h3 className="text-sm font-semibold mb-2" style={{ color: theme.colors.textMain }}>
									About Maestro Symphony
								</h3>
								<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
									Symphony connects Maestro users with open source projects seeking AI-assisted
									contributions. Browse projects, find issues labeled with{' '}
									<code
										className="px-1 py-0.5 rounded text-xs"
										style={{ backgroundColor: theme.colors.bgActivity }}
									>
										runmaestro.ai
									</code>
									, and contribute by running Auto Run documents that maintainers have prepared.
								</p>
								<h4 className="text-xs font-semibold mb-1" style={{ color: theme.colors.textMain }}>
									Register Your Project
								</h4>
								<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
									Want to receive Symphony contributions for your open source project? Add your
									repository to the registry:
								</p>
								<button
									onClick={() => {
										openUrl(buildMaestroUrl('https://docs.runmaestro.ai/symphony'));
										onCloseHelp();
									}}
									className="text-xs hover:opacity-80 transition-colors"
									style={{ color: theme.colors.accent }}
								>
									docs.runmaestro.ai/symphony
								</button>
								<div className="mt-3 pt-3 border-t" style={{ borderColor: theme.colors.border }}>
									<button
										onClick={onCloseHelp}
										className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textDim }}
									>
										Close
									</button>
								</div>
							</div>
						)}
					</div>
					{/* Register Project link */}
					<button
						onClick={() => {
							openUrl(buildMaestroUrl('https://docs.runmaestro.ai/symphony'));
						}}
						className="px-2 py-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1.5 text-xs"
						title="Register your project for Symphony contributions"
						style={{ color: theme.colors.textDim }}
					>
						<Github className="w-3.5 h-3.5" />
						<span>Register Your Project</span>
					</button>
				</div>
				<div className="flex items-center gap-3">
					{showCacheStatus && (
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{fromCache ? `Cached ${formatCacheAge(cacheAge)}` : 'Live'}
						</span>
					)}
					<button
						onClick={onRefresh}
						disabled={isRefreshing}
						className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
						title="Refresh"
					>
						<RefreshCw
							className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
							style={{ color: theme.colors.textDim }}
						/>
					</button>
					<GhostIconButton onClick={onClose} padding="p-1.5" title="Close (Esc)">
						<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					</GhostIconButton>
				</div>
			</div>
		);
	}
);
