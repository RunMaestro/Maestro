import { Package, Search } from 'lucide-react';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import type { MarketplaceBrowseTabProps } from '../types';
import { getCategoryCount, LOADING_TILE_IDS } from '../helpers';
import { PlaybookTile } from './PlaybookTile';
import { PlaybookTileSkeleton } from './PlaybookTileSkeleton';

export function MarketplaceBrowseTab({
	theme,
	manifest,
	categories,
	selectedCategory,
	onCategoryChange,
	searchQuery,
	onSearchChange,
	filteredPlaybooks,
	compatiblePlaybooks,
	incompatiblePlaybooks,
	selectedTileIndex,
	isLoading,
	error,
	runningVersion,
	onRefresh,
	onSelectPlaybook,
	searchInputRef,
	gridContainerRef,
}: MarketplaceBrowseTabProps) {
	return (
		<>
			<div
				className="flex items-center gap-1 px-4 py-2 border-b overflow-x-auto"
				style={{ borderColor: theme.colors.border }}
			>
				{categories.map((category) => {
					const count = getCategoryCount(category, manifest?.playbooks ?? []);
					return (
						<button
							key={category}
							onClick={() => onCategoryChange(category)}
							className={`px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
								selectedCategory === category ? 'font-semibold' : ''
							}`}
							style={{
								backgroundColor:
									selectedCategory === category ? theme.colors.accent : 'transparent',
								color:
									selectedCategory === category
										? theme.colors.accentForeground
										: theme.colors.textMain,
							}}
						>
							{category}
							<span className="ml-1.5 text-xs opacity-60">({count})</span>
						</button>
					);
				})}
			</div>

			<div
				className="px-4 py-3 border-b"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="relative">
					<Search
						className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
						style={{ color: theme.colors.textDim }}
					/>
					<input
						ref={searchInputRef}
						type="text"
						value={searchQuery}
						onChange={(e) => onSearchChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Escape') {
								e.preventDefault();
								e.stopPropagation();
								gridContainerRef.current?.focus();
							}
						}}
						placeholder="Search playbooks..."
						className="w-full pl-10 pr-4 py-2 rounded border outline-none"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgActivity,
						}}
					/>
				</div>
			</div>

			<div
				ref={gridContainerRef}
				tabIndex={-1}
				className="flex-1 overflow-y-auto p-4 outline-none"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				{isLoading ? (
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
						{LOADING_TILE_IDS.map((tileId) => (
							<PlaybookTileSkeleton key={tileId} theme={theme} />
						))}
					</div>
				) : error ? (
					<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center py-12">
						<Package
							className="w-16 h-16 mb-4"
							style={{ color: theme.colors.error, opacity: 0.7 }}
						/>
						<p className="text-lg font-medium mb-2" style={{ color: theme.colors.error }}>
							Failed to load marketplace
						</p>
						<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
							{error}
						</p>
						<button
							onClick={onRefresh}
							className="px-4 py-2 rounded text-sm font-medium"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							Try Again
						</button>
					</div>
				) : filteredPlaybooks.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center py-12">
						<Package
							className="w-16 h-16 mb-4"
							style={{ color: theme.colors.textDim, opacity: 0.5 }}
						/>
						{searchQuery ? (
							<>
								<p className="text-lg font-medium mb-2" style={{ color: theme.colors.textMain }}>
									No results found
								</p>
								<p className="text-sm" style={{ color: theme.colors.textDim }}>
									Try adjusting your search or browse a different category
								</p>
							</>
						) : (
							<>
								<p className="text-lg font-medium mb-2" style={{ color: theme.colors.textMain }}>
									No playbooks available
								</p>
								<p className="text-sm" style={{ color: theme.colors.textDim }}>
									Check back later for new playbooks
								</p>
							</>
						)}
					</div>
				) : (
					<>
						{compatiblePlaybooks.length > 0 && (
							<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
								{compatiblePlaybooks.map((playbook, index) => (
									<PlaybookTile
										key={playbook.id}
										playbook={playbook}
										theme={theme}
										isSelected={selectedTileIndex === index}
										runningVersion={runningVersion}
										onSelect={() => onSelectPlaybook(playbook)}
									/>
								))}
							</div>
						)}

						{incompatiblePlaybooks.length > 0 && (
							<>
								<div
									className="flex items-center gap-3 mt-6 mb-3"
									aria-label="Incompatible playbooks section"
								>
									<div className="flex-1 h-px" style={{ backgroundColor: theme.colors.border }} />
									<span
										className="text-xs uppercase tracking-wide font-semibold"
										style={{ color: theme.colors.textDim }}
									>
										Requires a newer Maestro
									</span>
									<div className="flex-1 h-px" style={{ backgroundColor: theme.colors.border }} />
								</div>
								<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
									{incompatiblePlaybooks.map((playbook, index) => (
										<PlaybookTile
											key={playbook.id}
											playbook={playbook}
											theme={theme}
											isSelected={selectedTileIndex === compatiblePlaybooks.length + index}
											runningVersion={runningVersion}
											onSelect={() => onSelectPlaybook(playbook)}
										/>
									))}
								</div>
							</>
						)}
					</>
				)}
			</div>

			<div
				className="px-4 py-2 border-t text-xs flex items-center justify-between"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textDim,
				}}
			>
				<span>Use arrow keys to navigate, Enter to select</span>
				<span className="flex items-center gap-3">
					<span>
						<kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px]">
							{formatShortcutKeys(['Meta', 'f'])}
						</kbd>{' '}
						search
					</span>
					<span>
						<kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px]">
							{formatShortcutKeys(['Meta', 'Shift'])}+[/]
						</kbd>{' '}
						to switch tabs
					</span>
				</span>
			</div>
		</>
	);
}
