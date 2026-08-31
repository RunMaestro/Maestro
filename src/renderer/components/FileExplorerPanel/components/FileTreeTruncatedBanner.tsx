import { AlertTriangle, X } from 'lucide-react';
import type { Theme } from '../../../types';

interface FileTreeTruncatedBannerProps {
	theme: Theme;
	previousCap?: number;
	onLoadMore: () => void;
	onLoadAll: () => void;
	isRefreshing: boolean;
	/** Collapses the banner down to the hazard icon next to the path row. */
	onCollapse: () => void;
}

export function FileTreeTruncatedBanner({
	theme,
	previousCap,
	onLoadMore,
	onLoadAll,
	isRefreshing,
	onCollapse,
}: FileTreeTruncatedBannerProps) {
	const capLabel =
		previousCap !== undefined && Number.isFinite(previousCap)
			? previousCap.toLocaleString()
			: 'the configured cap';
	const nextCap =
		previousCap !== undefined && Number.isFinite(previousCap)
			? (previousCap * 2).toLocaleString()
			: 'more';

	return (
		<div
			className="flex items-start gap-2 px-3 py-2 rounded border mb-2"
			style={{
				borderColor: theme.colors.warning,
				backgroundColor: `${theme.colors.warning}15`,
				color: theme.colors.textMain,
			}}
		>
			<AlertTriangle
				className="w-4 h-4 mt-0.5 flex-shrink-0"
				style={{ color: theme.colors.warning }}
			/>
			<div className="flex-1 min-w-0">
				<div className="text-xs font-medium">Unable to load all files into the file panel.</div>
				<div className="text-[11px] opacity-70 mt-0.5">
					Scan stopped at {capLabel} entries to protect memory. Adjust the cap in Settings → Display
					→ File Indexing.
				</div>
				<div className="flex gap-2 mt-1.5">
					<button
						type="button"
						onClick={onLoadMore}
						disabled={isRefreshing}
						className="px-2 py-0.5 rounded text-[11px] font-medium transition-colors disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.bgMain,
						}}
					>
						Load more ({nextCap})
					</button>
					<button
						type="button"
						onClick={onLoadAll}
						disabled={isRefreshing}
						className="px-2 py-0.5 rounded text-[11px] font-medium border transition-colors disabled:opacity-50"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						Load all
					</button>
				</div>
			</div>
			<button
				type="button"
				onClick={onCollapse}
				aria-label="Minimize file scan warning"
				title="Minimize (click the warning icon next to the path to reopen)"
				className="flex-shrink-0 p-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
				style={{ color: theme.colors.textMain }}
			>
				<X className="w-3.5 h-3.5" />
			</button>
		</div>
	);
}
