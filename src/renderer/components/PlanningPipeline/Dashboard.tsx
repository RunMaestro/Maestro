/**
 * PipelineDashboard — Desktop renderer component
 *
 * Read-only column-per-stage view of the Planning Pipeline.  Each column
 * shows the stage name, an item-count chip, and a compact list of cards
 * with the item's workItemId and title.
 *
 * Boundary note: this dashboard covers ALL pipeline stages (idea → fork-merged,
 * plus failure-loop stages needs-fix/fix-active).  The Agent Dispatch board
 * (`src/renderer/components/AgentDispatch/KanbanBoard.tsx`) covers Work Graph
 * _lifecycle_ statuses (ready/claimed/in_progress/review/done/blocked) — a
 * different vocabulary.  Link from here to there when navigating from a
 * runner-active item.
 */

import React, { memo, useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import {
	PIPELINE_STAGES,
	PIPELINE_FAILURE_STAGES,
	type AnyPipelineStage,
} from '../../../shared/planning-pipeline-types';
import { planningPipelineService } from '../../services/planningPipeline';
import type { WorkItem } from '../../../shared/work-graph-types';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

interface ColumnDef {
	stage: AnyPipelineStage;
	label: string;
	colorKey: 'textDim' | 'success' | 'warning' | 'error' | 'accent';
}

const FORWARD_COLUMNS: ColumnDef[] = [
	{ stage: 'idea', label: 'Idea', colorKey: 'textDim' },
	{ stage: 'prd-draft', label: 'PRD Draft', colorKey: 'textDim' },
	{ stage: 'prd-finalized', label: 'PRD Final', colorKey: 'accent' },
	{ stage: 'epic-decomposed', label: 'Epic', colorKey: 'accent' },
	{ stage: 'tasks-decomposed', label: 'Tasks', colorKey: 'accent' },
	{ stage: 'agent-ready', label: 'Agent Ready', colorKey: 'success' },
	{ stage: 'runner-active', label: 'Running', colorKey: 'warning' },
	{ stage: 'needs-review', label: 'Review', colorKey: 'accent' },
	{ stage: 'review-approved', label: 'Approved', colorKey: 'success' },
	{ stage: 'fork-merged', label: 'Merged', colorKey: 'textDim' },
];

const FAILURE_COLUMNS: ColumnDef[] = [
	{ stage: 'needs-fix', label: 'Needs Fix', colorKey: 'error' },
	{ stage: 'fix-active', label: 'Fix Active', colorKey: 'warning' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardData {
	stages: Record<AnyPipelineStage, WorkItem[]>;
	unstaged: WorkItem[];
	total: number;
}

export interface PipelineDashboardProps {
	theme: Theme;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PipelineCard = memo(function PipelineCard({ item, theme }: { item: WorkItem; theme: Theme }) {
	return (
		<div
			className="rounded px-2 py-1.5 border"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
			}}
		>
			<p
				className="text-xs font-medium leading-tight truncate"
				style={{ color: theme.colors.textMain }}
				title={item.title}
			>
				{item.title}
			</p>
			<p
				className="text-xs truncate mt-0.5"
				style={{ color: theme.colors.textDim }}
				title={item.id}
			>
				{item.id}
			</p>
		</div>
	);
});

const StageColumn = memo(function StageColumn({
	column,
	items,
	theme,
}: {
	column: ColumnDef;
	items: WorkItem[];
	theme: Theme;
}) {
	const accentColor = theme.colors[column.colorKey];

	return (
		<div
			className="flex flex-col shrink-0 rounded border"
			style={{
				width: 200,
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
			}}
		>
			{/* Column header */}
			<div
				className="flex items-center justify-between px-3 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-xs font-semibold truncate" style={{ color: accentColor }}>
					{column.label}
				</span>
				<span
					className="text-xs rounded-full px-1.5 py-0.5 font-bold ml-2 shrink-0"
					style={{
						backgroundColor: `${accentColor}22`,
						color: accentColor,
						minWidth: 20,
						textAlign: 'center',
					}}
				>
					{items.length}
				</span>
			</div>

			{/* Card list */}
			<div className="flex flex-col gap-1.5 p-2 overflow-y-auto" style={{ maxHeight: 440 }}>
				{items.length === 0 ? (
					<p className="text-xs text-center py-4" style={{ color: theme.colors.textDim }}>
						—
					</p>
				) : (
					items.map((item) => <PipelineCard key={item.id} item={item} theme={theme} />)
				)}
			</div>
		</div>
	);
});

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

export const PipelineDashboard = memo(function PipelineDashboard({
	theme,
}: PipelineDashboardProps) {
	const [data, setData] = useState<DashboardData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await planningPipelineService.getDashboard();
			setData(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const forwardItems = (stage: AnyPipelineStage): WorkItem[] => data?.stages[stage] ?? [];

	return (
		<div
			className="flex flex-col h-full overflow-hidden"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			{/* Toolbar */}
			<div
				className="flex items-center justify-between px-4 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						Pipeline Dashboard
					</span>
					{data !== null && (
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{data.total} item{data.total !== 1 ? 's' : ''}
						</span>
					)}
				</div>
				<button
					onClick={() => void refresh()}
					disabled={loading}
					className="flex items-center gap-1 text-xs rounded px-2 py-1 border transition-opacity hover:opacity-70"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
						opacity: loading ? 0.4 : 1,
					}}
					aria-label="Refresh pipeline dashboard"
				>
					<RefreshCw
						size={11}
						style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}
					/>
					Refresh
				</button>
			</div>

			{/* Error banner */}
			{error && (
				<div
					role="alert"
					className="px-4 py-2 text-xs"
					style={{
						backgroundColor: `${theme.colors.error}18`,
						color: theme.colors.error,
						borderBottom: `1px solid ${theme.colors.error}`,
					}}
				>
					Error: {error}
				</div>
			)}

			{/* Column scroll area */}
			{loading && data === null ? (
				<div
					className="flex-1 flex items-center justify-center text-sm"
					style={{ color: theme.colors.textDim }}
				>
					Loading…
				</div>
			) : (
				<div className="flex-1 overflow-y-hidden overflow-x-auto">
					<div className="flex gap-3 h-full p-4" style={{ minWidth: 'max-content' }}>
						{/* Forward stages */}
						{FORWARD_COLUMNS.map((col) => (
							<StageColumn
								key={col.stage}
								column={col}
								items={forwardItems(col.stage)}
								theme={theme}
							/>
						))}

						{/* Divider */}
						<div
							className="shrink-0 w-px self-stretch my-2"
							style={{ backgroundColor: theme.colors.border }}
						/>

						{/* Failure-loop stages */}
						{FAILURE_COLUMNS.map((col) => (
							<StageColumn
								key={col.stage}
								column={col}
								items={forwardItems(col.stage)}
								theme={theme}
							/>
						))}

						{/* Unstaged column */}
						{data !== null && (
							<StageColumn
								column={{ stage: 'idea', label: 'Unstaged', colorKey: 'textDim' }}
								items={data.unstaged}
								theme={theme}
							/>
						)}
					</div>
				</div>
			)}

			<style>{`
				@keyframes spin {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
			`}</style>
		</div>
	);
});

export default PipelineDashboard;
