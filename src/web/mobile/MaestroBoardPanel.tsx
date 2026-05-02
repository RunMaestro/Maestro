import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { buildApiUrl } from '../utils/config';
import type { WorkItem, WorkItemStatus } from '../../shared/work-graph-types';

interface MaestroBoardPanelProps {
	projectPath: string | null | undefined;
	onOpenFullBoard?: () => void;
	displayMode?: 'panel' | 'full';
}

interface BoardResponse {
	items: WorkItem[];
	total: number;
}

const STATUS_ORDER: WorkItemStatus[] = [
	'ready',
	'claimed',
	'in_progress',
	'blocked',
	'review',
	'planned',
	'discovered',
	'backlog',
	'done',
];

const STATUS_LABELS: Record<WorkItemStatus, string> = {
	backlog: 'Backlog',
	discovered: 'Discovered',
	planned: 'Planned',
	ready: 'Ready',
	claimed: 'Claimed',
	in_progress: 'Running',
	blocked: 'Blocked',
	review: 'Review',
	done: 'Done',
	archived: 'Archived',
	canceled: 'Canceled',
};

const ACTIVE_STATUSES = new Set<WorkItemStatus>([
	'ready',
	'claimed',
	'in_progress',
	'blocked',
	'review',
]);

const CURRENT_WORK_ORDER: Record<WorkItemStatus, number> = {
	blocked: 0,
	in_progress: 1,
	claimed: 2,
	review: 3,
	ready: 4,
	planned: 5,
	discovered: 6,
	backlog: 7,
	done: 8,
	archived: 9,
	canceled: 10,
};

function statusAccent(status: WorkItemStatus, colors: ReturnType<typeof useThemeColors>): string {
	if (status === 'ready' || status === 'done') return colors.accent;
	if (status === 'blocked') return colors.error;
	if (status === 'claimed' || status === 'in_progress') return colors.warning;
	if (status === 'review') return '#22d3ee';
	return colors.textDim;
}

function formatUpdated(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

function projectLabel(projectPath: string): string {
	const normalized = projectPath.replace(/\/+$/, '');
	const lastSegment = normalized.split('/').filter(Boolean).pop();
	return lastSegment || projectPath;
}

function sortWorkItems(a: WorkItem, b: WorkItem): number {
	const statusDelta = CURRENT_WORK_ORDER[a.status] - CURRENT_WORK_ORDER[b.status];
	if (statusDelta !== 0) return statusDelta;
	const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
	if (priorityDelta !== 0) return priorityDelta;
	return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function countStatus(items: WorkItem[], statuses: WorkItemStatus[]): number {
	return items.filter((item) => statuses.includes(item.status)).length;
}

function StatTile({ label, value, color }: { label: string; value: number; color: string }) {
	const colors = useThemeColors();
	return (
		<div
			style={{
				border: `1px solid ${colors.border}`,
				borderRadius: '8px',
				backgroundColor: colors.bgSidebar,
				padding: '9px 10px',
				minWidth: 0,
			}}
		>
			<div style={{ fontSize: '18px', lineHeight: 1, fontWeight: 750, color }}>{value}</div>
			<div
				style={{
					marginTop: '4px',
					fontSize: '10px',
					fontWeight: 700,
					textTransform: 'uppercase',
					color: colors.textDim,
				}}
			>
				{label}
			</div>
		</div>
	);
}

function WorkItemCard({
	item,
	accent,
	compact,
}: {
	item: WorkItem;
	accent: string;
	compact: boolean;
}) {
	const colors = useThemeColors();
	const ownerLabel =
		item.claim?.owner?.name ?? item.claim?.owner?.id ?? item.owner?.name ?? item.owner?.id;
	return (
		<article
			style={{
				border: `1px solid ${colors.border}`,
				borderLeft: `3px solid ${accent}`,
				borderRadius: '8px',
				backgroundColor: colors.bgSidebar,
				padding: compact ? '9px' : '10px',
				minWidth: 0,
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'flex-start',
					justifyContent: 'space-between',
					gap: '8px',
				}}
			>
				<div
					style={{
						fontSize: compact ? '12px' : '13px',
						fontWeight: 650,
						color: colors.textMain,
						lineHeight: 1.35,
						overflow: 'hidden',
						display: '-webkit-box',
						WebkitLineClamp: compact ? 2 : 3,
						WebkitBoxOrient: 'vertical' as const,
					}}
				>
					{item.title}
				</div>
				{item.priority != null && item.priority > 0 && (
					<span
						style={{
							fontSize: '10px',
							fontWeight: 700,
							color: colors.accent,
							backgroundColor: `${colors.accent}18`,
							border: `1px solid ${colors.accent}35`,
							borderRadius: '999px',
							padding: '1px 6px',
							flexShrink: 0,
						}}
					>
						P{item.priority}
					</span>
				)}
			</div>
			<div
				style={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: '5px',
					marginTop: '7px',
					fontSize: '10px',
					color: colors.textDim,
				}}
			>
				<span style={{ fontFamily: 'monospace' }}>{item.id}</span>
				<span>{item.type}</span>
				{item.pipeline?.currentRole && <span>{item.pipeline.currentRole}</span>}
			</div>
			{ownerLabel && (
				<div
					style={{
						marginTop: '6px',
						fontSize: '10px',
						color: item.claim?.status === 'active' ? colors.warning : colors.textDim,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{item.claim?.status === 'active' ? 'Claimed by ' : 'Owner: '}
					{ownerLabel}
				</div>
			)}
			<div style={{ fontSize: '10px', color: colors.textDim, marginTop: '5px' }}>
				Updated {formatUpdated(item.updatedAt)}
			</div>
		</article>
	);
}

export function MaestroBoardPanel({
	projectPath,
	onOpenFullBoard,
	displayMode = 'panel',
}: MaestroBoardPanelProps) {
	const colors = useThemeColors();
	const [items, setItems] = useState<WorkItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadBoard = useCallback(async () => {
		if (!projectPath) return;
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(
				buildApiUrl(`/work-graph/items?projectPath=${encodeURIComponent(projectPath)}`)
			);
			const json = await res.json();
			if (!res.ok || !json.success) {
				if (res.status === 403 && json.code === 'FEATURE_DISABLED') {
					throw new Error(
						`Feature flag is off for ${json.feature ?? 'this board surface'}. Work Graph read access did not complete.`
					);
				}
				throw new Error(json.error ?? `HTTP ${res.status}`);
			}
			const data = json.data as BoardResponse;
			setItems(data.items.filter((item) => item.projectPath === projectPath).sort(sortWorkItems));
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [projectPath]);

	useEffect(() => {
		void loadBoard();
	}, [loadBoard]);

	const grouped = useMemo(() => {
		const map = new Map<WorkItemStatus, WorkItem[]>();
		for (const status of STATUS_ORDER) map.set(status, []);
		for (const item of items) {
			const bucket = map.get(item.status) ?? [];
			bucket.push(item);
			map.set(item.status, bucket);
		}
		return map;
	}, [items]);

	const activeItems = useMemo(
		() => items.filter((item) => ACTIVE_STATUSES.has(item.status)).sort(sortWorkItems),
		[items]
	);
	const currentWork = displayMode === 'full' ? activeItems.slice(0, 8) : activeItems.slice(0, 4);
	const shownStatuses =
		displayMode === 'full'
			? STATUS_ORDER
			: STATUS_ORDER.filter((status) => {
					if (status === 'done')
						return (grouped.get(status)?.length ?? 0) > 0 && activeItems.length === 0;
					return status !== 'backlog' || (grouped.get(status)?.length ?? 0) > 0;
				});

	const gridStyle: CSSProperties =
		displayMode === 'full'
			? {
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
					gap: '12px',
				}
			: {
					display: 'flex',
					flexDirection: 'column',
					gap: '10px',
				};

	if (!projectPath) {
		return (
			<div
				style={{ padding: '24px', textAlign: 'center', color: colors.textDim, fontSize: '13px' }}
			>
				Open a project to view Maestro Board.
			</div>
		);
	}

	return (
		<div style={{ padding: displayMode === 'full' ? '16px' : '12px' }}>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					marginBottom: '12px',
				}}
			>
				<div>
					<div
						style={{
							fontSize: '11px',
							fontWeight: 700,
							textTransform: 'uppercase',
							letterSpacing: '0.06em',
							color: colors.textDim,
						}}
					>
						Project Work
					</div>
					<div
						style={{
							fontSize: displayMode === 'full' ? '18px' : '14px',
							fontWeight: 750,
							color: colors.textMain,
							marginTop: '2px',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
							maxWidth: displayMode === 'full' ? '60vw' : '170px',
						}}
						title={projectPath}
					>
						{projectLabel(projectPath)}
					</div>
					<div style={{ fontSize: '11px', color: colors.textDim, marginTop: '2px' }}>
						{items.length} project item{items.length === 1 ? '' : 's'}
					</div>
				</div>
				<div style={{ display: 'flex', gap: '6px' }}>
					{displayMode === 'panel' && onOpenFullBoard && (
						<button
							onClick={onOpenFullBoard}
							style={{
								background: `${colors.accent}18`,
								border: `1px solid ${colors.accent}55`,
								borderRadius: '6px',
								cursor: 'pointer',
								color: colors.accent,
								fontSize: '12px',
								padding: '5px 8px',
								fontWeight: 650,
							}}
						>
							Full screen
						</button>
					)}
					<button
						onClick={() => void loadBoard()}
						style={{
							background: 'none',
							border: `1px solid ${colors.border}`,
							borderRadius: '6px',
							cursor: 'pointer',
							color: colors.textMain,
							fontSize: '12px',
							padding: '5px 8px',
						}}
						aria-label="Refresh Maestro Board"
					>
						Refresh
					</button>
				</div>
			</div>

			<div
				style={{
					display: 'grid',
					gridTemplateColumns:
						displayMode === 'full'
							? 'repeat(auto-fit, minmax(120px, 1fr))'
							: 'repeat(2, minmax(0, 1fr))',
					gap: '8px',
					marginBottom: '12px',
				}}
			>
				<StatTile label="Active" value={activeItems.length} color={colors.accent} />
				<StatTile
					label="Running"
					value={countStatus(items, ['claimed', 'in_progress'])}
					color={colors.warning}
				/>
				<StatTile label="Blocked" value={countStatus(items, ['blocked'])} color={colors.error} />
				<StatTile label="Review" value={countStatus(items, ['review'])} color="#22d3ee" />
			</div>

			{loading && <p style={{ color: colors.textDim, fontSize: '13px' }}>Loading...</p>}
			{error && (
				<div
					style={{
						border: `1px solid ${colors.error}55`,
						borderRadius: '8px',
						backgroundColor: `${colors.error}12`,
						color: colors.error,
						fontSize: '13px',
						margin: '0 0 12px',
						padding: '10px',
					}}
				>
					<div style={{ fontWeight: 700 }}>Unable to load Work Graph items</div>
					<div style={{ marginTop: '4px', color: colors.textMain }}>{error}</div>
				</div>
			)}
			{!loading && !error && items.length === 0 && (
				<p style={{ color: colors.textDim, fontSize: '13px' }}>
					The board loaded successfully, but Work Graph has no items for this project yet. Open
					Project PM or Delivery Planner to create board items.
				</p>
			)}

			{currentWork.length > 0 && (
				<section style={{ marginBottom: '14px' }}>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
							marginBottom: '8px',
							fontSize: '11px',
							fontWeight: 700,
							textTransform: 'uppercase',
							letterSpacing: '0.06em',
							color: colors.textDim,
						}}
					>
						<span>Now</span>
						<span>{activeItems.length} active</span>
					</div>
					<div
						style={{
							display: 'grid',
							gridTemplateColumns:
								displayMode === 'full' ? 'repeat(auto-fit, minmax(260px, 1fr))' : '1fr',
							gap: '8px',
						}}
					>
						{currentWork.map((item) => (
							<WorkItemCard
								key={item.id}
								item={item}
								accent={statusAccent(item.status, colors)}
								compact={displayMode === 'panel'}
							/>
						))}
					</div>
				</section>
			)}

			<div style={gridStyle}>
				{shownStatuses.map((status) => {
					const bucket = grouped.get(status) ?? [];
					if (bucket.length === 0) return null;
					const accent = statusAccent(status, colors);
					const visibleBucket = displayMode === 'full' ? bucket : bucket.slice(0, 4);
					const hiddenCount = bucket.length - visibleBucket.length;
					return (
						<section
							key={status}
							style={{
								border: displayMode === 'full' ? `1px solid ${colors.border}` : 'none',
								borderRadius: '8px',
								backgroundColor: displayMode === 'full' ? `${colors.bgSidebar}70` : 'transparent',
								padding: displayMode === 'full' ? '10px' : 0,
								minWidth: 0,
							}}
						>
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
									marginBottom: '6px',
									color: accent,
									fontSize: '11px',
									fontWeight: 700,
									textTransform: 'uppercase',
									letterSpacing: '0.06em',
								}}
							>
								<span>{STATUS_LABELS[status]}</span>
								<span>{bucket.length}</span>
							</div>
							<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
								{visibleBucket.map((item) => (
									<WorkItemCard
										key={item.id}
										item={item}
										accent={accent}
										compact={displayMode === 'panel'}
									/>
								))}
							</div>
							{hiddenCount > 0 && (
								<div
									style={{
										marginTop: '8px',
										fontSize: '11px',
										color: colors.textDim,
										textAlign: 'center',
									}}
								>
									+{hiddenCount} more in full board
								</div>
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
}

export default MaestroBoardPanel;
