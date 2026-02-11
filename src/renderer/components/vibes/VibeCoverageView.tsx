import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
	BarChart3,
	FileCheck,
	FileX,
	FileMinus,
	Filter,
	ArrowUpDown,
	AlertTriangle,
	Database,
	Loader2,
} from 'lucide-react';
import type { Theme } from '../../types';

// ============================================================================
// Types
// ============================================================================

/** A single file entry from `vibescheck coverage --json`. */
interface CoverageFileEntry {
	file_path?: string;
	file?: string;
	path?: string;
	coverage_status?: 'full' | 'partial' | 'uncovered';
	status?: 'full' | 'partial' | 'uncovered';
	annotation_count?: number;
	annotations?: number;
	count?: number;
}

/** Normalized coverage file data for display. */
interface NormalizedCoverageFile {
	filePath: string;
	status: 'full' | 'partial' | 'uncovered';
	annotationCount: number;
}

/** Props for the VibeCoverageView component. */
interface VibeCoverageViewProps {
	theme: Theme;
	projectPath: string | undefined;
}

type FilterMode = 'all' | 'covered' | 'uncovered';
type SortMode = 'status' | 'path' | 'annotations';

// ============================================================================
// Constants
// ============================================================================

const STATUS_CONFIG: Record<string, { label: string; color: string; sortOrder: number }> = {
	full: { label: 'Covered', color: '#22c55e', sortOrder: 0 },
	partial: { label: 'Partial', color: '#eab308', sortOrder: 1 },
	uncovered: { label: 'Uncovered', color: '#6b7280', sortOrder: 2 },
};

const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'covered', label: 'Covered' },
	{ value: 'uncovered', label: 'Uncovered' },
];

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
	{ value: 'status', label: 'Status' },
	{ value: 'path', label: 'Path' },
	{ value: 'annotations', label: 'Annotations' },
];

// ============================================================================
// Helpers
// ============================================================================

/** Normalize the raw coverage file entries into a consistent shape. */
function normalizeCoverageData(raw: string | undefined): NormalizedCoverageFile[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw);
		let entries: CoverageFileEntry[] = [];

		if (Array.isArray(data)) {
			entries = data;
		} else if (data.files && Array.isArray(data.files)) {
			entries = data.files;
		} else if (data.coverage && Array.isArray(data.coverage)) {
			entries = data.coverage;
		}

		return entries.map((entry) => ({
			filePath: entry.file_path ?? entry.file ?? entry.path ?? 'unknown',
			status: entry.coverage_status ?? entry.status ?? 'uncovered',
			annotationCount: entry.annotation_count ?? entry.annotations ?? entry.count ?? 0,
		}));
	} catch {
		return [];
	}
}

/** Calculate coverage summary statistics. */
function calculateSummary(files: NormalizedCoverageFile[]) {
	const total = files.length;
	const covered = files.filter((f) => f.status === 'full').length;
	const partial = files.filter((f) => f.status === 'partial').length;
	const uncovered = files.filter((f) => f.status === 'uncovered').length;
	const percentage = total > 0 ? Math.round(((covered + partial * 0.5) / total) * 100) : 0;
	const totalAnnotations = files.reduce((sum, f) => sum + f.annotationCount, 0);

	return { total, covered, partial, uncovered, percentage, totalAnnotations };
}

// ============================================================================
// Component
// ============================================================================

/**
 * VIBES Coverage View — shows which files in the project have AI
 * annotation coverage and which don't.
 *
 * Features:
 * - Coverage summary bar with overall percentage
 * - File list with coverage status, annotation count, color indicator
 * - Filter options (All / Covered / Uncovered)
 * - Sort options (Status / Path / Annotations)
 */
export const VibeCoverageView: React.FC<VibeCoverageViewProps> = ({
	theme,
	projectPath,
}) => {
	const [files, setFiles] = useState<NormalizedCoverageFile[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [needsBuild, setNeedsBuild] = useState(false);
	const [isBuilding, setIsBuilding] = useState(false);
	const [filter, setFilter] = useState<FilterMode>('all');
	const [sort, setSort] = useState<SortMode>('status');

	// ========================================================================
	// Fetch coverage data
	// ========================================================================

	const fetchCoverage = useCallback(async () => {
		if (!projectPath) return;

		setIsLoading(true);
		setError(null);
		setNeedsBuild(false);

		try {
			const result = await window.maestro.vibes.getCoverage(projectPath);
			if (result.success && result.data) {
				const normalized = normalizeCoverageData(result.data);
				setFiles(normalized);
			} else {
				const errMsg = result.error ?? 'Failed to fetch coverage data';
				if (
					errMsg.toLowerCase().includes('build') ||
					errMsg.toLowerCase().includes('database') ||
					errMsg.toLowerCase().includes('audit.db')
				) {
					setNeedsBuild(true);
				} else {
					setError(errMsg);
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to fetch coverage data');
		} finally {
			setIsLoading(false);
		}
	}, [projectPath]);

	useEffect(() => {
		fetchCoverage();
	}, [fetchCoverage]);

	// ========================================================================
	// Build Now handler
	// ========================================================================

	const handleBuild = useCallback(async () => {
		if (!projectPath) return;
		setIsBuilding(true);
		try {
			const result = await window.maestro.vibes.build(projectPath);
			if (result.success) {
				setNeedsBuild(false);
				fetchCoverage();
			} else {
				setError(result.error ?? 'Build failed');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Build failed');
		} finally {
			setIsBuilding(false);
		}
	}, [projectPath, fetchCoverage]);

	// ========================================================================
	// Summary stats
	// ========================================================================

	const summary = useMemo(() => calculateSummary(files), [files]);

	// ========================================================================
	// Filtered + sorted file list
	// ========================================================================

	const displayedFiles = useMemo(() => {
		let filtered = files;

		if (filter === 'covered') {
			filtered = files.filter((f) => f.status === 'full' || f.status === 'partial');
		} else if (filter === 'uncovered') {
			filtered = files.filter((f) => f.status === 'uncovered');
		}

		const sorted = [...filtered];
		if (sort === 'status') {
			sorted.sort((a, b) => {
				const aOrder = STATUS_CONFIG[a.status]?.sortOrder ?? 9;
				const bOrder = STATUS_CONFIG[b.status]?.sortOrder ?? 9;
				return aOrder - bOrder || a.filePath.localeCompare(b.filePath);
			});
		} else if (sort === 'path') {
			sorted.sort((a, b) => a.filePath.localeCompare(b.filePath));
		} else if (sort === 'annotations') {
			sorted.sort((a, b) => b.annotationCount - a.annotationCount || a.filePath.localeCompare(b.filePath));
		}

		return sorted;
	}, [files, filter, sort]);

	// ========================================================================
	// Render
	// ========================================================================

	return (
		<div className="flex flex-col h-full">
			{/* Header — summary + controls */}
			<div
				className="sticky top-0 z-10 flex flex-col gap-3 px-3 py-3"
				style={{ backgroundColor: theme.colors.bgSidebar }}
			>
				{/* Coverage summary bar */}
				{!isLoading && !error && !needsBuild && files.length > 0 && (
					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<BarChart3 className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
								<span className="text-[11px] font-semibold" style={{ color: theme.colors.textDim }}>
									Coverage
								</span>
							</div>
							<span className="text-sm font-bold tabular-nums" style={{ color: theme.colors.textMain }}>
								{summary.percentage}%
							</span>
						</div>

						{/* Progress bar */}
						<div
							className="w-full h-2 rounded-full overflow-hidden"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							{/* Full coverage portion (green) */}
							<div
								className="h-full float-left"
								style={{
									width: summary.total > 0 ? `${(summary.covered / summary.total) * 100}%` : '0%',
									backgroundColor: STATUS_CONFIG.full.color,
								}}
							/>
							{/* Partial coverage portion (yellow) */}
							<div
								className="h-full float-left"
								style={{
									width: summary.total > 0 ? `${(summary.partial / summary.total) * 100}%` : '0%',
									backgroundColor: STATUS_CONFIG.partial.color,
								}}
							/>
						</div>

						{/* Summary stats */}
						<div className="flex items-center gap-3 text-[10px]" style={{ color: theme.colors.textDim }}>
							<span>{summary.total} files</span>
							<span style={{ color: STATUS_CONFIG.full.color }}>{summary.covered} covered</span>
							<span style={{ color: STATUS_CONFIG.partial.color }}>{summary.partial} partial</span>
							<span>{summary.uncovered} uncovered</span>
							<span className="ml-auto">{summary.totalAnnotations} annotations</span>
						</div>
					</div>
				)}

				{/* Filter + sort controls */}
				{!isLoading && !error && !needsBuild && files.length > 0 && (
					<div className="flex items-center gap-3">
						{/* Filter */}
						<div className="flex items-center gap-1.5">
							<Filter className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
							<div className="flex items-center gap-0.5">
								{FILTER_OPTIONS.map((opt) => (
									<button
										key={opt.value}
										onClick={() => setFilter(opt.value)}
										className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors"
										style={{
											backgroundColor: filter === opt.value ? theme.colors.accentDim : 'transparent',
											color: filter === opt.value ? theme.colors.accent : theme.colors.textDim,
										}}
									>
										{opt.label}
									</button>
								))}
							</div>
						</div>

						{/* Sort */}
						<div className="flex items-center gap-1.5 ml-auto">
							<ArrowUpDown className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
							<div className="flex items-center gap-0.5">
								{SORT_OPTIONS.map((opt) => (
									<button
										key={opt.value}
										onClick={() => setSort(opt.value)}
										className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors"
										style={{
											backgroundColor: sort === opt.value ? theme.colors.accentDim : 'transparent',
											color: sort === opt.value ? theme.colors.accent : theme.colors.textDim,
										}}
									>
										{opt.label}
									</button>
								))}
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Content area */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
				{/* Loading */}
				{isLoading && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading coverage data...
						</span>
					</div>
				)}

				{/* Build Required notice */}
				{!isLoading && needsBuild && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<Database className="w-6 h-6 opacity-60" style={{ color: theme.colors.warning }} />
						<span
							className="text-sm font-medium"
							style={{ color: theme.colors.textMain }}
						>
							Build Required
						</span>
						<span
							className="text-xs max-w-xs"
							style={{ color: theme.colors.textDim }}
						>
							The audit database needs to be built before viewing coverage data.
						</span>
						<button
							onClick={handleBuild}
							disabled={isBuilding}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80 mt-1"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
								opacity: isBuilding ? 0.6 : 1,
							}}
						>
							<Database className="w-3.5 h-3.5" />
							{isBuilding ? 'Building...' : 'Build Now'}
						</button>
					</div>
				)}

				{/* Error */}
				{!isLoading && error && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<AlertTriangle className="w-6 h-6 opacity-60" style={{ color: theme.colors.error }} />
						<span className="text-xs" style={{ color: theme.colors.error }}>
							{error}
						</span>
					</div>
				)}

				{/* Empty state — no coverage data */}
				{!isLoading && !error && !needsBuild && files.length === 0 && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<BarChart3 className="w-6 h-6 opacity-40" style={{ color: theme.colors.textDim }} />
						<span
							className="text-sm font-medium"
							style={{ color: theme.colors.textMain }}
						>
							No coverage data
						</span>
						<span
							className="text-xs max-w-xs"
							style={{ color: theme.colors.textDim }}
						>
							No AI annotation coverage data is available for this project.
						</span>
					</div>
				)}

				{/* File list */}
				{!isLoading && !error && !needsBuild && displayedFiles.length > 0 && (
					<div className="flex flex-col">
						{displayedFiles.map((file) => (
							<CoverageFileRow
								key={file.filePath}
								theme={theme}
								file={file}
							/>
						))}
					</div>
				)}

				{/* No results for current filter */}
				{!isLoading && !error && !needsBuild && files.length > 0 && displayedFiles.length === 0 && (
					<div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							No files match the current filter.
						</span>
					</div>
				)}
			</div>

			{/* Footer */}
			{!isLoading && files.length > 0 && (
				<div
					className="flex items-center justify-between px-3 py-1.5 text-[10px] border-t"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
						backgroundColor: theme.colors.bgSidebar,
					}}
				>
					<span>
						{displayedFiles.length} of {files.length} files
					</span>
					<span>{summary.totalAnnotations} total annotations</span>
				</div>
			)}
		</div>
	);
};

// ============================================================================
// Sub-components
// ============================================================================

interface CoverageFileRowProps {
	theme: Theme;
	file: NormalizedCoverageFile;
}

const CoverageFileRow: React.FC<CoverageFileRowProps> = ({ theme, file }) => {
	const statusInfo = STATUS_CONFIG[file.status] ?? STATUS_CONFIG.uncovered;
	const StatusIcon = file.status === 'full'
		? FileCheck
		: file.status === 'partial'
			? FileMinus
			: FileX;

	return (
		<div
			className="flex items-center gap-2 px-3 py-2 border-b text-xs"
			style={{ borderColor: theme.colors.border }}
		>
			{/* Status color indicator */}
			<div
				className="w-2 h-2 rounded-full shrink-0"
				style={{ backgroundColor: statusInfo.color }}
			/>

			{/* File icon */}
			<StatusIcon className="w-3.5 h-3.5 shrink-0" style={{ color: statusInfo.color }} />

			{/* File path */}
			<span
				className="flex-1 min-w-0 truncate font-mono text-[11px]"
				style={{ color: theme.colors.textMain }}
				title={file.filePath}
			>
				{file.filePath}
			</span>

			{/* Status badge */}
			<span
				className="px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0"
				style={{
					backgroundColor: `${statusInfo.color}20`,
					color: statusInfo.color,
				}}
			>
				{statusInfo.label}
			</span>

			{/* Annotation count */}
			<span
				className="shrink-0 tabular-nums text-[10px] min-w-[3ch] text-right"
				style={{ color: theme.colors.textDim }}
			>
				{file.annotationCount}
			</span>
		</div>
	);
};
