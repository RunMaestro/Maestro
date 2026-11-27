import { useState } from 'react';
import { AlertCircle, AlertTriangle, ExternalLink, History } from 'lucide-react';
import type { Theme } from '../types';
import { Spinner } from './ui/Spinner';
import { UpdateReleaseCard } from './UpdateReleaseCard';
import { openUrl } from '../utils/openUrl';
import type { RollbackTargetsResult } from '../../shared/updateRollback';

interface UpdateRollbackPanelProps {
	theme: Theme;
	loading: boolean;
	result: RollbackTargetsResult | null;
	/** The tag being downloaded or already downloaded, if any. */
	activeTag: string | null;
	/** True while any download (update or rollback) is running. */
	downloading: boolean;
	onRollback: (tag: string) => void;
}

/**
 * The rollback section of the Check for Updates modal: earlier releases this
 * platform can install, each with its notes and a Roll Back button. Picking one
 * only DOWNLOADS it; the modal's restart controls install it.
 */
export function UpdateRollbackPanel({
	theme,
	loading,
	result,
	activeTag,
	downloading,
	onRollback,
}: UpdateRollbackPanelProps) {
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const toggle = (tag: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(tag)) next.delete(tag);
			else next.add(tag);
			return next;
		});

	return (
		<div className="space-y-4">
			<div
				className="p-4 rounded-lg border"
				style={{ backgroundColor: `${theme.colors.warning}15`, borderColor: theme.colors.warning }}
			>
				<div className="flex items-start gap-3">
					<AlertTriangle
						className="w-5 h-5 mt-0.5 shrink-0"
						style={{ color: theme.colors.warning }}
					/>
					<div className="flex-1 text-xs space-y-1.5" style={{ color: theme.colors.textDim }}>
						<p>
							This installs an older build over{' '}
							<span className="font-mono">v{result?.currentVersion ?? __APP_VERSION__}</span>. Your
							agents, settings, and history stay in place, but an older version may not read data
							that a newer one wrote.
						</p>
						<p>
							Auto Runs in progress may not resume after a rollback. This window will offer the
							newest version again, so you can move forward when the fix ships.
						</p>
					</div>
				</div>
			</div>

			{loading ? (
				<div className="flex flex-col items-center justify-center py-8 gap-3">
					<Spinner size={32} color={theme.colors.accent} />
					<span className="text-sm" style={{ color: theme.colors.textDim }}>
						Loading earlier releases...
					</span>
				</div>
			) : result?.error ? (
				<div className="flex flex-col items-center justify-center py-6 gap-3">
					<AlertCircle className="w-8 h-8" style={{ color: theme.colors.error }} />
					<span className="text-sm text-center" style={{ color: theme.colors.textDim }}>
						{result.error}
					</span>
				</div>
			) : !result || result.releases.length === 0 ? (
				<div className="text-sm text-center py-6" style={{ color: theme.colors.textDim }}>
					No earlier releases can be installed on this platform.
				</div>
			) : (
				<div className="space-y-2">
					{result.releases.map((release) => {
						const isActive = activeTag === release.tag_name;
						return (
							<UpdateReleaseCard
								key={release.tag_name}
								theme={theme}
								release={release}
								expanded={expanded.has(release.tag_name)}
								onToggle={() => toggle(release.tag_name)}
								trailing={
									<button
										onClick={() => onRollback(release.tag_name)}
										disabled={downloading}
										className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition-colors hover:bg-white/10 disabled:opacity-50"
										style={{
											borderColor: isActive ? theme.colors.accent : theme.colors.border,
											color: isActive ? theme.colors.accent : theme.colors.textMain,
										}}
									>
										{downloading && isActive ? (
											<Spinner size={12} />
										) : (
											<History className="w-3.5 h-3.5" />
										)}
										Roll Back
									</button>
								}
							/>
						);
					})}
				</div>
			)}

			<button
				onClick={() =>
					openUrl(result?.releasesUrl ?? 'https://github.com/RunMaestro/Maestro/releases')
				}
				className="w-full flex items-center justify-center gap-2 p-2 rounded text-xs transition-colors hover:bg-white/5"
				style={{ color: theme.colors.textDim }}
			>
				Or download an older installer from GitHub
				<ExternalLink className="w-3 h-3" />
			</button>
		</div>
	);
}
