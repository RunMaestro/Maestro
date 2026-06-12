import { memo, useEffect, useRef } from 'react';
import { Hash, Star } from 'lucide-react';
import type { Theme } from '../../../types';
import type { RegisteredRepository } from '../../../../shared/symphony-types';
import { SYMPHONY_CATEGORIES } from '../../../../shared/symphony-constants';
import { compactNumber } from '../helpers/formatters';

export interface RepositoryTileSkeletonProps {
	theme: Theme;
}

export const RepositoryTileSkeleton = memo(function RepositoryTileSkeleton({
	theme,
}: RepositoryTileSkeletonProps) {
	return (
		<div
			className="p-4 rounded-lg border animate-pulse"
			style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-2 mb-2">
				<div className="w-16 h-5 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
			</div>
			<div className="h-5 w-3/4 rounded mb-1" style={{ backgroundColor: theme.colors.bgMain }} />
			<div className="h-4 w-full rounded mb-1" style={{ backgroundColor: theme.colors.bgMain }} />
			<div className="h-4 w-2/3 rounded mb-3" style={{ backgroundColor: theme.colors.bgMain }} />
			<div className="flex justify-between">
				<div className="h-3 w-20 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
				<div className="h-3 w-12 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
			</div>
		</div>
	);
});

export interface RepositoryTileProps {
	repo: RegisteredRepository;
	theme: Theme;
	isSelected: boolean;
	onSelect: () => void;
	issueCount: number | null;
}

export const RepositoryTile = memo(function RepositoryTile({
	repo,
	theme,
	isSelected,
	onSelect,
	issueCount,
}: RepositoryTileProps) {
	const tileRef = useRef<HTMLButtonElement>(null);
	const categoryInfo = SYMPHONY_CATEGORIES[repo.category] ?? { label: repo.category, emoji: '📦' };
	const hasNoIssues = issueCount !== null && issueCount === 0;

	useEffect(() => {
		if (isSelected && tileRef.current) {
			tileRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	}, [isSelected]);

	return (
		<button
			ref={tileRef}
			onClick={onSelect}
			className={`p-4 rounded-lg border text-left transition-all hover:scale-[1.02] ${isSelected ? 'ring-2' : ''}`}
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				opacity: hasNoIssues ? 0.45 : 1,
				...(isSelected && { boxShadow: `0 0 0 2px ${theme.colors.accent}` }),
			}}
		>
			<div className="flex items-center justify-between mb-2">
				<span
					className="px-2 py-0.5 rounded text-xs flex items-center gap-1"
					style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
				>
					<span>{categoryInfo.emoji}</span>
					<span>{categoryInfo.label}</span>
				</span>
				{repo.stars != null && (
					<span
						className="flex items-center gap-1 text-xs tabular-nums"
						style={{ color: theme.colors.textDim }}
					>
						<Star className="w-3 h-3" style={{ fill: 'currentColor' }} />
						{compactNumber.format(repo.stars)}
					</span>
				)}
			</div>

			<h3
				className="font-semibold mb-1 line-clamp-1"
				style={{ color: theme.colors.textMain }}
				title={repo.name}
			>
				{repo.name}
			</h3>

			<p className="text-sm line-clamp-2 mb-3" style={{ color: theme.colors.textDim }}>
				{repo.description}
			</p>

			<div
				className="flex items-center justify-between text-xs"
				style={{ color: theme.colors.textDim }}
			>
				<span>{repo.maintainer.name}</span>
				{issueCount === null ? (
					<span className="flex items-center gap-1" style={{ color: theme.colors.accent }}>
						<Hash className="w-3 h-3" />
						View Issues
					</span>
				) : issueCount > 0 ? (
					<span className="flex items-center gap-1" style={{ color: theme.colors.accent }}>
						<Hash className="w-3 h-3" />
						View {issueCount} {issueCount === 1 ? 'Issue' : 'Issues'}
					</span>
				) : (
					<span className="flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						No Issues
					</span>
				)}
			</div>
		</button>
	);
});
