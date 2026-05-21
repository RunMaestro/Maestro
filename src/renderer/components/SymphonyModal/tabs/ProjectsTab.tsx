import { memo, type RefObject } from 'react';
import { Search, Loader2, AlertCircle, Music } from 'lucide-react';
import type { Theme } from '../../../types';
import type { RegisteredRepository } from '../../../../shared/symphony-types';
import { SYMPHONY_CATEGORIES } from '../../../../shared/symphony-constants';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { STATUS_COLORS } from '../helpers/statusInfo';
import { RepositoryTile, RepositoryTileSkeleton } from '../components/RepositoryTile';

export interface ProjectsTabProps {
	theme: Theme;
	isLoading: boolean;
	error: string | null;
	filteredRepositories: RegisteredRepository[];
	categories: string[];
	selectedCategory: string;
	onCategoryChange: (category: string) => void;
	searchQuery: string;
	onSearchChange: (value: string) => void;
	selectedTileIndex: number;
	onSelectRepo: (repo: RegisteredRepository) => void;
	issueCounts: Record<string, number | null> | null | undefined;
	isLoadingIssueCounts: boolean;
	onRetry: () => void;
	searchInputRef: RefObject<HTMLInputElement>;
	tileGridRef: RefObject<HTMLDivElement>;
}

const SKELETON_IDS = [
	'repo-skeleton-1',
	'repo-skeleton-2',
	'repo-skeleton-3',
	'repo-skeleton-4',
	'repo-skeleton-5',
	'repo-skeleton-6',
] as const;

export const ProjectsTab = memo(function ProjectsTab({
	theme,
	isLoading,
	error,
	filteredRepositories,
	categories,
	selectedCategory,
	onCategoryChange,
	searchQuery,
	onSearchChange,
	selectedTileIndex,
	onSelectRepo,
	issueCounts,
	isLoadingIssueCounts,
	onRetry,
	searchInputRef,
	tileGridRef,
}: ProjectsTabProps) {
	return (
		<>
			{/* Search + Category tabs */}
			<div
				className="px-4 py-3 border-b"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<div className="flex items-center gap-4">
					<div className="relative flex-1 max-w-xs">
						<Search
							className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
							style={{ color: theme.colors.textDim }}
						/>
						<input
							ref={searchInputRef}
							type="text"
							value={searchQuery}
							onChange={(e) => onSearchChange(e.target.value)}
							placeholder="Search repositories..."
							className="w-full pl-9 pr-3 py-2 rounded border outline-none text-sm focus:ring-1"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgActivity,
							}}
						/>
					</div>

					<div className="flex items-center gap-1 flex-wrap">
						<button
							onClick={() => onCategoryChange('all')}
							className={`px-3 py-1.5 rounded text-sm transition-colors ${selectedCategory === 'all' ? 'font-semibold' : ''}`}
							style={{
								backgroundColor:
									selectedCategory === 'all' ? theme.colors.bgActivity : 'transparent',
								color: selectedCategory === 'all' ? theme.colors.accent : theme.colors.textDim,
								border:
									selectedCategory === 'all'
										? `1px solid ${theme.colors.accent}`
										: '1px solid transparent',
							}}
						>
							All
						</button>
						{categories.map((cat) => {
							const info = SYMPHONY_CATEGORIES[cat];
							return (
								<button
									key={cat}
									onClick={() => onCategoryChange(cat)}
									className={`px-3 py-1.5 rounded text-sm transition-colors flex items-center gap-1 ${
										selectedCategory === cat ? 'font-semibold' : ''
									}`}
									style={{
										backgroundColor:
											selectedCategory === cat ? theme.colors.bgActivity : 'transparent',
										color: selectedCategory === cat ? theme.colors.accent : theme.colors.textDim,
										border:
											selectedCategory === cat
												? `1px solid ${theme.colors.accent}`
												: '1px solid transparent',
									}}
								>
									<span>{info?.emoji ?? '📦'}</span>
									<span>{info?.label ?? cat}</span>
								</button>
							);
						})}
					</div>
				</div>
			</div>

			{/* Repository grid */}
			<div className="flex-1 overflow-y-auto p-4" style={{ backgroundColor: theme.colors.bgMain }}>
				{isLoading ? (
					<div className="grid grid-cols-3 gap-4">
						{SKELETON_IDS.map((skeletonId) => (
							<RepositoryTileSkeleton key={skeletonId} theme={theme} />
						))}
					</div>
				) : error ? (
					<div className="flex flex-col items-center justify-center h-48">
						<AlertCircle className="w-8 h-8 mb-2" style={{ color: STATUS_COLORS.failed }} />
						<p style={{ color: theme.colors.textDim }}>{error}</p>
						<button
							onClick={onRetry}
							className="mt-3 px-3 py-1.5 rounded text-sm"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							Retry
						</button>
					</div>
				) : filteredRepositories.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-48">
						<Music className="w-8 h-8 mb-2" style={{ color: theme.colors.textDim }} />
						<p style={{ color: theme.colors.textDim }}>
							{searchQuery ? 'No repositories match your search' : 'No repositories available'}
						</p>
					</div>
				) : (
					<div
						ref={tileGridRef}
						tabIndex={0}
						className="grid grid-cols-3 gap-4 outline-none"
						role="grid"
						aria-label="Repository tiles"
					>
						{filteredRepositories.map((repo, index) => (
							<RepositoryTile
								key={repo.slug}
								repo={repo}
								theme={theme}
								isSelected={index === selectedTileIndex}
								onSelect={() => onSelectRepo(repo)}
								issueCount={issueCounts?.[repo.slug] ?? null}
							/>
						))}
					</div>
				)}
			</div>

			{/* Footer */}
			<div
				className="px-4 py-2 border-t flex items-center justify-between text-xs"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				<span className="flex items-center gap-1">
					{filteredRepositories.length} repositories • Contribute to open source with AI
					{isLoadingIssueCounts && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
				</span>
				<span>{`↑↓←→ navigate • Enter select • / search • ${formatShortcutKeys(['Meta', 'Shift'])}[] tabs`}</span>
			</div>
		</>
	);
});
