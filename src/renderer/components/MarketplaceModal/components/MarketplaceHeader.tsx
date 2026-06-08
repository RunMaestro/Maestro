import { forwardRef } from 'react';
import { Github, HelpCircle, LayoutGrid, RefreshCw, X } from 'lucide-react';
import { formatCacheAge } from '../../../../shared/formatters';
import { GhostIconButton } from '../../ui/GhostIconButton';
import { buildMaestroUrl } from '../../../utils/buildMaestroUrl';
import { openUrl } from '../../../utils/openUrl';
import type { MarketplaceHeaderProps } from '../types';

export const MarketplaceHeader = forwardRef<HTMLButtonElement, MarketplaceHeaderProps>(
	function MarketplaceHeader(
		{
			theme,
			fromCache,
			cacheAge,
			isRefreshing,
			showHelp,
			onToggleHelp,
			onCloseHelp,
			onRefresh,
			onClose,
		},
		helpButtonRef
	) {
		return (
			<div
				className="flex items-center justify-between px-4 py-3 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<LayoutGrid className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h2
						id="marketplace-title"
						className="text-lg font-semibold"
						style={{ color: theme.colors.textMain }}
					>
						Playbook Exchange
					</h2>
					<div className="relative">
						<button
							ref={helpButtonRef}
							onClick={onToggleHelp}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							title="About the Playbook Exchange"
							aria-label="Help"
						>
							<HelpCircle className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						</button>
						{showHelp && (
							<div
								className="absolute top-full left-0 mt-2 w-80 p-4 rounded-lg shadow-xl z-50"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<h3 className="text-sm font-semibold mb-2" style={{ color: theme.colors.textMain }}>
									About the Playbook Exchange
								</h3>
								<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
									The Playbook Exchange is a curated collection of Auto Run playbooks for common
									workflows. Browse, preview, and import playbooks directly into your Auto Run
									folder.
								</p>
								<h4 className="text-xs font-semibold mb-1" style={{ color: theme.colors.textMain }}>
									Submit Your Playbook
								</h4>
								<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
									Want to share your playbook with the community? Submit a pull request to the
									Maestro-Playbooks repository:
								</p>
								<button
									onClick={() => {
										openUrl('https://github.com/RunMaestro/Maestro-Playbooks');
										onCloseHelp();
									}}
									className="text-xs hover:opacity-80 transition-colors"
									style={{ color: theme.colors.accent }}
								>
									github.com/RunMaestro/Maestro-Playbooks
								</button>
								<button
									onClick={() => {
										openUrl(buildMaestroUrl('https://docs.runmaestro.ai/playbook-exchange'));
										onCloseHelp();
									}}
									className="text-xs hover:opacity-80 transition-colors mt-2 block"
									style={{ color: theme.colors.accent }}
								>
									Read more at docs.runmaestro.ai/playbook-exchange
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
					<button
						onClick={() => {
							openUrl('https://github.com/RunMaestro/Maestro-Playbooks');
						}}
						className="px-2 py-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1.5 text-xs"
						title="Submit your playbook to the community"
						style={{ color: theme.colors.textDim }}
					>
						<Github className="w-3.5 h-3.5" />
						<span>Submit Playbook via GitHub</span>
					</button>
				</div>
				<div className="flex items-center gap-3">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{fromCache ? `Cached ${formatCacheAge(cacheAge)}` : 'Live'}
					</span>
					<button
						onClick={onRefresh}
						disabled={isRefreshing}
						className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
						title="Refresh marketplace data"
						aria-label="Refresh marketplace"
						aria-busy={isRefreshing}
					>
						<RefreshCw
							className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
							style={{ color: theme.colors.textDim }}
						/>
					</button>
					<GhostIconButton
						onClick={onClose}
						padding="p-1.5"
						title="Close (Esc)"
						ariaLabel="Close marketplace"
					>
						<X className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					</GhostIconButton>
				</div>
			</div>
		);
	}
);
