import React, { useState, useMemo, useCallback } from 'react';
import {
	Filter,
	Search,
	ChevronDown,
	ChevronRight,
	FileCode,
	Clock,
	Terminal,
	MessageSquare,
	Brain,
	Play,
	Square,
	AlertTriangle,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	VibesAnnotation,
	VibesAction,
	VibesAssuranceLevel,
} from '../../../shared/vibes-types';

// ============================================================================
// Filter Types
// ============================================================================

/** Agent tool names used for filtering annotations. */
type AgentFilter = 'all' | 'claude-code' | 'codex' | 'maestro';

/** Action filter values. */
type ActionFilter = 'all' | VibesAction;

/** Assurance level filter values. */
type AssuranceLevelFilter = 'all' | VibesAssuranceLevel;

interface AnnotationFilters {
	agent: AgentFilter;
	action: ActionFilter;
	assuranceLevel: AssuranceLevelFilter;
	fileSearch: string;
}

// ============================================================================
// Props
// ============================================================================

interface VibesAnnotationLogProps {
	theme: Theme;
	annotations: VibesAnnotation[];
	isLoading: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const AGENT_OPTIONS: { value: AgentFilter; label: string }[] = [
	{ value: 'all', label: 'All Agents' },
	{ value: 'claude-code', label: 'Claude Code' },
	{ value: 'codex', label: 'Codex' },
	{ value: 'maestro', label: 'Maestro' },
];

const ACTION_OPTIONS: { value: ActionFilter; label: string }[] = [
	{ value: 'all', label: 'All Actions' },
	{ value: 'create', label: 'Create' },
	{ value: 'modify', label: 'Modify' },
	{ value: 'delete', label: 'Delete' },
	{ value: 'review', label: 'Review' },
];

const ASSURANCE_OPTIONS: { value: AssuranceLevelFilter; label: string }[] = [
	{ value: 'all', label: 'All Levels' },
	{ value: 'low', label: 'Low' },
	{ value: 'medium', label: 'Medium' },
	{ value: 'high', label: 'High' },
];

const ACTION_COLORS: Record<VibesAction, { bg: string; text: string }> = {
	create: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e' },
	modify: { bg: 'rgba(59, 130, 246, 0.15)', text: '#3b82f6' },
	delete: { bg: 'rgba(239, 68, 68, 0.15)', text: '#ef4444' },
	review: { bg: 'rgba(234, 179, 8, 0.15)', text: '#eab308' },
};

const ASSURANCE_COLORS: Record<VibesAssuranceLevel, { bg: string; text: string }> = {
	low: { bg: 'rgba(234, 179, 8, 0.15)', text: '#eab308' },
	medium: { bg: 'rgba(59, 130, 246, 0.15)', text: '#3b82f6' },
	high: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e' },
};

// ============================================================================
// Helpers
// ============================================================================

/** Check if an annotation has minimum required fields to be renderable. */
function isValidAnnotation(annotation: VibesAnnotation): boolean {
	if (!annotation || typeof annotation !== 'object') return false;
	if (!annotation.type || !annotation.timestamp) return false;
	if (annotation.type === 'session') {
		return typeof annotation.session_id === 'string' && typeof annotation.event === 'string';
	}
	if (annotation.type === 'line' || annotation.type === 'function') {
		return typeof annotation.file_path === 'string' && typeof annotation.action === 'string';
	}
	return false;
}

/** Format a timestamp as relative time (e.g., "2 min ago"). */
function formatRelativeTime(timestamp: string): string {
	const now = Date.now();
	const then = new Date(timestamp).getTime();
	if (isNaN(then)) return timestamp;

	const diffMs = now - then;
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHr = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHr / 24);

	if (diffSec < 60) return 'just now';
	if (diffMin < 60) return `${diffMin} min ago`;
	if (diffHr < 24) return `${diffHr}h ago`;
	if (diffDay < 30) return `${diffDay}d ago`;
	return new Date(timestamp).toLocaleDateString();
}

/** Check if an annotation's environment hash loosely matches an agent filter. */
function matchesAgentFilter(annotation: VibesAnnotation, agent: AgentFilter): boolean {
	if (agent === 'all') return true;
	// Session records don't have environment hashes — always show them
	if (annotation.type === 'session') return true;
	// Heuristic: environment_hash is an opaque hash, but if tool_name is embedded
	// in the annotation data we use it. Since the annotation itself doesn't carry
	// tool_name, we rely on the environment hash prefix convention (future).
	// For now, pass all annotations when agent filter is set — the filter is a UI hint
	// until manifest-enriched data is available.
	return true;
}

/** Check if an annotation matches the current filters. */
function matchesFilters(annotation: VibesAnnotation, filters: AnnotationFilters): boolean {
	// Agent filter
	if (!matchesAgentFilter(annotation, filters.agent)) return false;

	// Action filter
	if (filters.action !== 'all') {
		if (annotation.type === 'session') return false; // Sessions don't have actions
		if ('action' in annotation && annotation.action !== filters.action) return false;
	}

	// Assurance level filter
	if (filters.assuranceLevel !== 'all') {
		if ('assurance_level' in annotation && annotation.assurance_level !== filters.assuranceLevel) {
			return false;
		}
	}

	// File path search
	if (filters.fileSearch.trim()) {
		const search = filters.fileSearch.toLowerCase();
		if (annotation.type === 'session') {
			return (annotation.description ?? '').toLowerCase().includes(search);
		}
		if ('file_path' in annotation) {
			return annotation.file_path.toLowerCase().includes(search);
		}
		return false;
	}

	return true;
}

// ============================================================================
// Component
// ============================================================================

/**
 * VIBES Annotation Log — scrollable, filterable list of VIBES annotations.
 *
 * Features:
 * - Filter bar with agent type, action, assurance level, and file path search
 * - Annotation list with timestamps, file paths, action badges, and assurance indicators
 * - Session annotations styled differently (start/end markers)
 * - Detail expansion showing full environment context, commands, prompts, reasoning
 */
export const VibesAnnotationLog: React.FC<VibesAnnotationLogProps> = ({
	theme,
	annotations,
	isLoading,
}) => {
	const [filters, setFilters] = useState<AnnotationFilters>({
		agent: 'all',
		action: 'all',
		assuranceLevel: 'all',
		fileSearch: '',
	});
	const [expandedId, setExpandedId] = useState<string | null>(null);

	// Filter out malformed annotations and track parse errors
	const { validAnnotations, parseErrorCount } = useMemo(() => {
		const valid: VibesAnnotation[] = [];
		let errors = 0;
		for (const a of annotations) {
			if (isValidAnnotation(a)) {
				valid.push(a);
			} else {
				errors++;
			}
		}
		return { validAnnotations: valid, parseErrorCount: errors };
	}, [annotations]);

	const filteredAnnotations = useMemo(
		() => validAnnotations.filter((a) => matchesFilters(a, filters)),
		[validAnnotations, filters],
	);

	const updateFilter = useCallback(
		<K extends keyof AnnotationFilters>(key: K, value: AnnotationFilters[K]) => {
			setFilters((prev) => ({ ...prev, [key]: value }));
		},
		[],
	);

	const toggleExpanded = useCallback((id: string) => {
		setExpandedId((prev) => (prev === id ? null : id));
	}, []);

	/** Generate a unique key for an annotation. */
	const annotationKey = useCallback((annotation: VibesAnnotation, index: number): string => {
		if (annotation.type === 'session') {
			return `session-${annotation.session_id}-${annotation.event}-${index}`;
		}
		if (annotation.type === 'line') {
			return `line-${annotation.file_path}-${annotation.line_start}-${annotation.timestamp}-${index}`;
		}
		return `fn-${annotation.file_path}-${annotation.function_name}-${annotation.timestamp}-${index}`;
	}, []);

	const activeFilterCount = useMemo(() => {
		let count = 0;
		if (filters.agent !== 'all') count++;
		if (filters.action !== 'all') count++;
		if (filters.assuranceLevel !== 'all') count++;
		if (filters.fileSearch.trim()) count++;
		return count;
	}, [filters]);

	// ========================================================================
	// Empty / Loading states
	// ========================================================================

	if (isLoading) {
		return (
			<div className="flex flex-col gap-0">
				{Array.from({ length: 6 }).map((_, i) => (
					<div
						key={i}
						className="flex items-center gap-2 px-3 py-2.5 border-b animate-pulse"
						style={{ borderColor: theme.colors.border }}
					>
						<div
							className="w-3 h-3 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						/>
						<div
							className="w-14 h-3 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						/>
						<div
							className="flex-1 h-3 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						/>
						<div
							className="w-12 h-4 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						/>
					</div>
				))}
				<div className="flex items-center justify-center gap-2 py-3">
					<Clock className="w-4 h-4 animate-pulse" style={{ color: theme.colors.textDim }} />
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						Loading annotations...
					</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Filter Bar */}
			<div
				className="sticky top-0 z-10 flex flex-col gap-2 px-3 py-2"
				style={{ backgroundColor: theme.colors.bgSidebar }}
			>
				<div className="flex items-center gap-2">
					<Filter className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
					<FilterDropdown
						theme={theme}
						options={AGENT_OPTIONS}
						value={filters.agent}
						onChange={(v) => updateFilter('agent', v as AgentFilter)}
					/>
					<FilterDropdown
						theme={theme}
						options={ACTION_OPTIONS}
						value={filters.action}
						onChange={(v) => updateFilter('action', v as ActionFilter)}
					/>
					<FilterDropdown
						theme={theme}
						options={ASSURANCE_OPTIONS}
						value={filters.assuranceLevel}
						onChange={(v) => updateFilter('assuranceLevel', v as AssuranceLevelFilter)}
					/>
				</div>
				<div className="flex items-center gap-2">
					<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
					<input
						type="text"
						placeholder="Filter by file path..."
						value={filters.fileSearch}
						onChange={(e) => updateFilter('fileSearch', e.target.value)}
						className="flex-1 px-2 py-1 rounded text-xs bg-transparent outline-none"
						style={{
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.textMain,
						}}
					/>
					{activeFilterCount > 0 && (
						<button
							onClick={() =>
								setFilters({ agent: 'all', action: 'all', assuranceLevel: 'all', fileSearch: '' })
							}
							className="px-2 py-0.5 rounded text-[10px] font-medium"
							style={{
								backgroundColor: theme.colors.accentDim,
								color: theme.colors.accent,
							}}
						>
							Clear ({activeFilterCount})
						</button>
					)}
				</div>
			</div>

			{/* Parse Error Warning */}
			{parseErrorCount > 0 && (
				<div
					className="flex items-center gap-2 mx-3 mt-2 px-2.5 py-1.5 rounded text-[11px]"
					style={{
						backgroundColor: 'rgba(234, 179, 8, 0.1)',
						border: '1px solid rgba(234, 179, 8, 0.25)',
					}}
				>
					<AlertTriangle className="w-3 h-3 shrink-0" style={{ color: '#eab308' }} />
					<span style={{ color: '#eab308' }}>
						{parseErrorCount} annotation{parseErrorCount !== 1 ? 's' : ''} skipped due to malformed data
					</span>
				</div>
			)}

			{/* Annotation List */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
				{filteredAnnotations.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 py-12 px-4 text-center">
						<FileCode className="w-6 h-6 opacity-40" style={{ color: theme.colors.textDim }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{validAnnotations.length === 0
								? 'No annotations recorded yet'
								: 'No annotations match the current filters'}
						</span>
					</div>
				) : (
					<div className="flex flex-col">
						{filteredAnnotations.map((annotation, idx) => {
							const key = annotationKey(annotation, idx);
							const isExpanded = expandedId === key;

							if (annotation.type === 'session') {
								return (
									<SessionAnnotationRow
										key={key}
										theme={theme}
										annotation={annotation}
									/>
								);
							}

							return (
								<AnnotationRow
									key={key}
									theme={theme}
									annotation={annotation}
									isExpanded={isExpanded}
									onToggle={() => toggleExpanded(key)}
								/>
							);
						})}
					</div>
				)}
			</div>

			{/* Footer count */}
			<div
				className="flex items-center justify-between px-3 py-1.5 text-[10px] border-t"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textDim,
					backgroundColor: theme.colors.bgSidebar,
				}}
			>
				<span>
					{filteredAnnotations.length} of {validAnnotations.length} annotations
					{parseErrorCount > 0 && ` (${parseErrorCount} skipped)`}
				</span>
				{activeFilterCount > 0 && (
					<span>{activeFilterCount} filter{activeFilterCount !== 1 ? 's' : ''} active</span>
				)}
			</div>
		</div>
	);
};

// ============================================================================
// Sub-components
// ============================================================================

interface FilterDropdownProps {
	theme: Theme;
	options: { value: string; label: string }[];
	value: string;
	onChange: (value: string) => void;
}

const FilterDropdown: React.FC<FilterDropdownProps> = ({ theme, options, value, onChange }) => {
	const selected = options.find((o) => o.value === value);
	return (
		<select
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className="px-1.5 py-1 rounded text-[11px] outline-none cursor-pointer appearance-none"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
				color: value === 'all' ? theme.colors.textDim : theme.colors.textMain,
			}}
			title={selected?.label}
		>
			{options.map((opt) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
	);
};

// ----------------------------------------------------------------------------
// Session annotation row (start/end markers)
// ----------------------------------------------------------------------------

interface SessionAnnotationRowProps {
	theme: Theme;
	annotation: Extract<VibesAnnotation, { type: 'session' }>;
}

const SessionAnnotationRow: React.FC<SessionAnnotationRowProps> = ({ theme, annotation }) => {
	const isStart = annotation.event === 'start';
	return (
		<div
			className="flex items-center gap-2 px-3 py-2 text-xs border-b"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: isStart
					? 'rgba(34, 197, 94, 0.05)'
					: 'rgba(239, 68, 68, 0.05)',
			}}
		>
			{isStart ? (
				<Play className="w-3 h-3 shrink-0" style={{ color: '#22c55e' }} />
			) : (
				<Square className="w-3 h-3 shrink-0" style={{ color: '#ef4444' }} />
			)}
			<span
				className="font-medium"
				style={{ color: isStart ? '#22c55e' : '#ef4444' }}
			>
				Session {isStart ? 'Started' : 'Ended'}
			</span>
			<span className="text-[10px] font-mono" style={{ color: theme.colors.textDim }}>
				{annotation.session_id.slice(0, 8)}
			</span>
			{annotation.description && (
				<span className="text-[10px] truncate" style={{ color: theme.colors.textDim }}>
					— {annotation.description}
				</span>
			)}
			<span className="text-[10px] ml-auto shrink-0" style={{ color: theme.colors.textDim }}>
				{formatRelativeTime(annotation.timestamp)}
			</span>
		</div>
	);
};

// ----------------------------------------------------------------------------
// Line/function annotation row
// ----------------------------------------------------------------------------

interface AnnotationRowProps {
	theme: Theme;
	annotation: Exclude<VibesAnnotation, { type: 'session' }>;
	isExpanded: boolean;
	onToggle: () => void;
}

const AnnotationRow: React.FC<AnnotationRowProps> = ({
	theme,
	annotation,
	isExpanded,
	onToggle,
}) => {
	const actionColor = ACTION_COLORS[annotation.action];
	const assuranceColor = ASSURANCE_COLORS[annotation.assurance_level];

	return (
		<div
			className="border-b"
			style={{ borderColor: theme.colors.border }}
		>
			{/* Main row — clickable */}
			<button
				onClick={onToggle}
				className="flex items-center gap-2 w-full px-3 py-2 text-left text-xs transition-colors hover:opacity-90"
				style={{
					backgroundColor: isExpanded ? theme.colors.bgActivity : 'transparent',
				}}
			>
				{isExpanded ? (
					<ChevronDown className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
				) : (
					<ChevronRight className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
				)}

				{/* Timestamp */}
				<span className="text-[10px] shrink-0 w-16 tabular-nums" style={{ color: theme.colors.textDim }}>
					{formatRelativeTime(annotation.timestamp)}
				</span>

				{/* File path + line range */}
				<span className="flex-1 truncate font-mono text-[11px]" style={{ color: theme.colors.textMain }}>
					{annotation.file_path}
					{annotation.type === 'line' && (
						<span style={{ color: theme.colors.accent }}>
							:{annotation.line_start}
							{annotation.line_end !== annotation.line_start && `-${annotation.line_end}`}
						</span>
					)}
					{annotation.type === 'function' && (
						<span style={{ color: theme.colors.accent }}>
							:{annotation.function_name}
						</span>
					)}
				</span>

				{/* Action badge */}
				<span
					className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase shrink-0"
					style={{ backgroundColor: actionColor.bg, color: actionColor.text }}
				>
					{annotation.action}
				</span>

				{/* Assurance level indicator */}
				<span
					className="w-1.5 h-1.5 rounded-full shrink-0"
					title={`Assurance: ${annotation.assurance_level}`}
					style={{ backgroundColor: assuranceColor.text }}
				/>
			</button>

			{/* Expanded detail panel */}
			{isExpanded && (
				<AnnotationDetail theme={theme} annotation={annotation} />
			)}
		</div>
	);
};

// ----------------------------------------------------------------------------
// Annotation detail expansion
// ----------------------------------------------------------------------------

interface AnnotationDetailProps {
	theme: Theme;
	annotation: Exclude<VibesAnnotation, { type: 'session' }>;
}

const AnnotationDetail: React.FC<AnnotationDetailProps> = ({ theme, annotation }) => {
	const [showFullReasoning, setShowFullReasoning] = useState(false);

	return (
		<div
			className="flex flex-col gap-2 px-4 py-2.5 text-xs"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderTop: `1px solid ${theme.colors.border}`,
			}}
		>
			{/* Environment context */}
			<DetailSection theme={theme} icon={<Terminal className="w-3 h-3" />} label="Environment">
				<DetailRow theme={theme} label="Hash" value={annotation.environment_hash} mono />
				{annotation.session_id && (
					<DetailRow theme={theme} label="Session" value={annotation.session_id.slice(0, 12)} mono />
				)}
				{annotation.commit_hash && (
					<DetailRow theme={theme} label="Commit" value={annotation.commit_hash.slice(0, 8)} mono />
				)}
				<DetailRow theme={theme} label="Assurance" value={annotation.assurance_level} />
				<DetailRow theme={theme} label="Timestamp" value={new Date(annotation.timestamp).toLocaleString()} />
			</DetailSection>

			{/* Command info (if command_hash present) */}
			{annotation.command_hash && (
				<DetailSection theme={theme} icon={<Terminal className="w-3 h-3" />} label="Command">
					<DetailRow theme={theme} label="Hash" value={annotation.command_hash} mono />
				</DetailSection>
			)}

			{/* Prompt info (Medium+ assurance only) */}
			{annotation.prompt_hash && (
				<DetailSection theme={theme} icon={<MessageSquare className="w-3 h-3" />} label="Prompt">
					<DetailRow theme={theme} label="Hash" value={annotation.prompt_hash} mono />
				</DetailSection>
			)}

			{/* Reasoning info (High assurance only) */}
			{annotation.reasoning_hash && (
				<DetailSection theme={theme} icon={<Brain className="w-3 h-3" />} label="Reasoning">
					<DetailRow theme={theme} label="Hash" value={annotation.reasoning_hash} mono />
					{!showFullReasoning && (
						<button
							onClick={() => setShowFullReasoning(true)}
							className="text-[10px] mt-1"
							style={{ color: theme.colors.accent }}
						>
							Show more...
						</button>
					)}
				</DetailSection>
			)}

			{/* Annotation type-specific info */}
			{annotation.type === 'line' && (
				<DetailSection theme={theme} icon={<FileCode className="w-3 h-3" />} label="Line Range">
					<DetailRow
						theme={theme}
						label="Lines"
						value={`${annotation.line_start} – ${annotation.line_end}`}
					/>
				</DetailSection>
			)}
			{annotation.type === 'function' && (
				<DetailSection theme={theme} icon={<FileCode className="w-3 h-3" />} label="Function">
					<DetailRow theme={theme} label="Name" value={annotation.function_name} mono />
					{annotation.function_signature && (
						<DetailRow theme={theme} label="Signature" value={annotation.function_signature} mono />
					)}
				</DetailSection>
			)}
		</div>
	);
};

// ----------------------------------------------------------------------------
// Detail sub-components
// ----------------------------------------------------------------------------

interface DetailSectionProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	children: React.ReactNode;
}

const DetailSection: React.FC<DetailSectionProps> = ({ theme, icon, label, children }) => (
	<div className="flex flex-col gap-1">
		<div className="flex items-center gap-1.5">
			<span style={{ color: theme.colors.textDim }}>{icon}</span>
			<span
				className="text-[10px] font-semibold uppercase tracking-wider"
				style={{ color: theme.colors.textDim }}
			>
				{label}
			</span>
		</div>
		<div className="flex flex-col gap-0.5 pl-5">{children}</div>
	</div>
);

interface DetailRowProps {
	theme: Theme;
	label: string;
	value: string;
	mono?: boolean;
}

const DetailRow: React.FC<DetailRowProps> = ({ theme, label, value, mono }) => (
	<div className="flex items-baseline gap-2 text-[11px]">
		<span className="shrink-0 w-20" style={{ color: theme.colors.textDim }}>
			{label}:
		</span>
		<span
			className={`truncate ${mono ? 'font-mono' : ''}`}
			style={{ color: theme.colors.textMain }}
			title={value}
		>
			{value}
		</span>
	</div>
);
