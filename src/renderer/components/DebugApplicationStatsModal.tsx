/**
 * DebugApplicationStatsModal — runtime memory / footprint breakdown for every
 * loaded agent. Used to verify that session data is loaded opportunistically
 * (cold on launch, warm as the user switches between agents).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Zap, Snowflake, Flame } from 'lucide-react';
import type { Theme, Session } from '../types';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { formatSize, formatNumber } from '../../shared/formatters';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { useSessionStore } from '../stores/sessionStore';
import { logger } from '../utils/logger';

interface DebugApplicationStatsModalProps {
	theme: Theme;
	onClose: () => void;
}

type AppStatsSnapshot = Awaited<ReturnType<typeof window.maestro.debug.getAppStats>>;

type LoadState = 'cold' | 'warm' | 'active';

interface SessionFootprint {
	session: Session;
	loadState: LoadState;
	aiTabCount: number;
	logCount: number;
	logBytes: number;
	fileTreeNodes: number;
	fileTreeBytes: number;
	filePreviewTabCount: number;
	filePreviewBytes: number;
	terminalTabCount: number;
	browserTabCount: number;
	dataBytes: number;
	processRssBytes?: number;
	processPid?: number;
}

type SortKey = 'name' | 'state' | 'tabs' | 'logs' | 'fileTree' | 'data' | 'rss';

// Cheap estimator — summing `.length` of strings roughly approximates the
// JS engine's byte footprint for text-heavy data without the perf cost of
// JSON.stringify across every session. Numbers/booleans are ignored.
function estimateStringBytes(obj: unknown, depth = 0): number {
	if (depth > 8 || obj == null) return 0;
	if (typeof obj === 'string') return obj.length * 2; // UTF-16
	if (typeof obj !== 'object') return 0;
	if (Array.isArray(obj)) {
		let sum = 0;
		for (const item of obj) sum += estimateStringBytes(item, depth + 1);
		return sum;
	}
	let sum = 0;
	for (const key in obj as Record<string, unknown>) {
		sum += estimateStringBytes((obj as Record<string, unknown>)[key], depth + 1);
	}
	return sum;
}

function computeFootprint(session: Session, pidRss: Map<number, number>): SessionFootprint {
	const aiTabs = session.aiTabs ?? [];
	let logCount = 0;
	let logBytes = 0;
	for (const tab of aiTabs) {
		logCount += tab.logs?.length ?? 0;
		logBytes += estimateStringBytes(tab.logs);
	}

	const fileTree = session.fileTree ?? [];
	const fileTreeBytes = estimateStringBytes(fileTree);
	const fileTreeNodes = session.fileTreeStats
		? session.fileTreeStats.fileCount + session.fileTreeStats.folderCount
		: Array.isArray(fileTree)
			? fileTree.length
			: 0;

	const filePreviewTabs = session.filePreviewTabs ?? [];
	const filePreviewBytes = estimateStringBytes(filePreviewTabs);

	const dataBytes = logBytes + fileTreeBytes + filePreviewBytes;

	// Pull any PID for this session out of the managed-process map
	const aiPid = session.aiPid && session.aiPid > 0 ? session.aiPid : undefined;
	let processRssBytes = aiPid ? pidRss.get(aiPid) : undefined;
	let processPid = aiPid;
	// Aggregate terminal tab PIDs as fallback
	const liveTerminalPid = (session.terminalTabs ?? []).some((t) => t.pid && t.pid > 0);
	if (processRssBytes === undefined) {
		for (const term of session.terminalTabs ?? []) {
			if (term.pid && term.pid > 0 && pidRss.has(term.pid)) {
				processRssBytes = (processRssBytes ?? 0) + (pidRss.get(term.pid) ?? 0);
				processPid = processPid ?? term.pid;
			}
		}
	}

	// Load state reflects *lazy-loaded* state only. Fields like `aiTabs[].logs`,
	// `filePreviewTabs`, and `browserTabs` are persisted to disk and rehydrated
	// at app launch, so they can't tell us if the agent has been touched this
	// session. `fileTree`, `aiPid`, and `terminalTabs[].pid` are all reset on
	// restore and only populated after the user focuses / interacts with the
	// agent, so they're the reliable signals.
	let loadState: LoadState;
	if (aiPid || liveTerminalPid) {
		loadState = 'active';
	} else if (fileTree.length > 0 || session.fileTreeLoading) {
		loadState = 'warm';
	} else {
		loadState = 'cold';
	}

	return {
		session,
		loadState,
		aiTabCount: aiTabs.length,
		logCount,
		logBytes,
		fileTreeNodes,
		fileTreeBytes,
		filePreviewTabCount: filePreviewTabs.length,
		filePreviewBytes,
		terminalTabCount: session.terminalTabs?.length ?? 0,
		browserTabCount: session.browserTabs?.length ?? 0,
		dataBytes,
		processRssBytes,
		processPid,
	};
}

const LOAD_STATE_LABEL: Record<LoadState, string> = {
	cold: 'Cold',
	warm: 'Warm',
	active: 'Active',
};

function LoadBadge({ state, theme }: { state: LoadState; theme: Theme }) {
	const color =
		state === 'active'
			? theme.colors.accent
			: state === 'warm'
				? theme.colors.warning
				: theme.colors.textDim;
	const Icon = state === 'active' ? Flame : state === 'warm' ? Zap : Snowflake;
	return (
		<span
			className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide"
			style={{ color, border: `1px solid ${color}`, opacity: state === 'cold' ? 0.7 : 1 }}
		>
			<Icon className="w-2.5 h-2.5" />
			{LOAD_STATE_LABEL[state]}
		</span>
	);
}

export function DebugApplicationStatsModal({ theme, onClose }: DebugApplicationStatsModalProps) {
	const sessions = useSessionStore((s) => s.sessions);
	const [snapshot, setSnapshot] = useState<AppStatsSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sortKey, setSortKey] = useState<SortKey>('data');
	const [sortAsc, setSortAsc] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await window.maestro.debug.getAppStats();
			setSnapshot(data);
		} catch (err) {
			logger.error('[DebugAppStats] Failed to load stats', undefined, err);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const pidRss = useMemo(() => {
		const m = new Map<number, number>();
		if (!snapshot) return m;
		for (const p of snapshot.managedProcesses) {
			if (p.pid && typeof p.rssBytes === 'number') m.set(p.pid, p.rssBytes);
		}
		return m;
	}, [snapshot]);

	const footprints = useMemo(
		() => sessions.map((s) => computeFootprint(s, pidRss)),
		[sessions, pidRss]
	);

	const totals = useMemo(() => {
		let dataBytes = 0;
		let rssBytes = 0;
		let active = 0;
		let warm = 0;
		let logCount = 0;
		for (const f of footprints) {
			dataBytes += f.dataBytes;
			rssBytes += f.processRssBytes ?? 0;
			logCount += f.logCount;
			if (f.loadState === 'active') active++;
			else if (f.loadState === 'warm') warm++;
		}
		return {
			dataBytes,
			rssBytes,
			logCount,
			active,
			warm,
			cold: footprints.length - active - warm,
		};
	}, [footprints]);

	const sortedFootprints = useMemo(() => {
		const arr = [...footprints];
		const dir = sortAsc ? 1 : -1;
		const stateOrder: Record<LoadState, number> = { active: 2, warm: 1, cold: 0 };
		const totalTabs = (f: SessionFootprint) =>
			f.aiTabCount + f.terminalTabCount + f.filePreviewTabCount + f.browserTabCount;
		arr.sort((a, b) => {
			switch (sortKey) {
				case 'name':
					return a.session.name.localeCompare(b.session.name) * dir;
				case 'state':
					return (stateOrder[a.loadState] - stateOrder[b.loadState]) * dir;
				case 'tabs':
					return (totalTabs(a) - totalTabs(b)) * dir;
				case 'logs':
					return (a.logCount - b.logCount) * dir || (a.logBytes - b.logBytes) * dir;
				case 'fileTree':
					return (
						(a.fileTreeNodes - b.fileTreeNodes) * dir || (a.fileTreeBytes - b.fileTreeBytes) * dir
					);
				case 'rss':
					return ((a.processRssBytes ?? -1) - (b.processRssBytes ?? -1)) * dir;
				case 'data':
				default:
					return (a.dataBytes - b.dataBytes) * dir;
			}
		});
		return arr;
	}, [footprints, sortKey, sortAsc]);

	const electronRss = useMemo(() => {
		if (!snapshot) return 0;
		return snapshot.electronProcesses.reduce((sum, p) => sum + (p.workingSetBytes ?? 0), 0);
	}, [snapshot]);

	const setSort = (key: SortKey) => {
		if (key === sortKey) setSortAsc((v) => !v);
		else {
			setSortKey(key);
			setSortAsc(key === 'name');
		}
	};

	const sortIndicator = (key: SortKey) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');

	return (
		<Modal
			theme={theme}
			title="Application Stats"
			headerIcon={<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.DEBUG_APPLICATION_STATS}
			onClose={onClose}
			width={820}
			maxHeight="85vh"
			closeOnBackdropClick
			footer={
				<div className="flex items-center justify-between w-full">
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						State reflects lazy-loaded runtime only — logs and file/browser tabs are restored from
						disk at launch, so agents look "cold" until their file tree or process spawns. Data
						bytes are rough UTF-16 estimates for relative comparison.
					</p>
					<button
						type="button"
						onClick={refresh}
						disabled={loading}
						className="px-3 py-1.5 rounded border text-sm flex items-center gap-2 transition-colors hover:bg-white/5 disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
						Refresh
					</button>
				</div>
			}
		>
			{/* Summary */}
			<div className="grid grid-cols-4 gap-3 mb-4">
				<SummaryCard
					theme={theme}
					label="Agents"
					primary={`${sessions.length}`}
					secondary={`${totals.active} active · ${totals.warm} warm · ${totals.cold} cold`}
				/>
				<SummaryCard
					theme={theme}
					label="Data Footprint"
					primary={formatSize(totals.dataBytes)}
					secondary={`${formatNumber(totals.logCount)} log entries`}
				/>
				<SummaryCard
					theme={theme}
					label="Agent Processes"
					primary={snapshot ? formatSize(totals.rssBytes) : '—'}
					secondary={
						snapshot
							? `${snapshot.managedProcesses.filter((p) => p.pid).length} PIDs tracked`
							: 'loading…'
					}
				/>
				<SummaryCard
					theme={theme}
					label="Electron"
					primary={snapshot ? formatSize(electronRss) : '—'}
					secondary={
						snapshot
							? `main heap ${formatSize(snapshot.main.heapUsed)} / ${formatSize(snapshot.main.heapTotal)}`
							: 'loading…'
					}
				/>
			</div>

			{error && (
				<div
					className="mb-3 p-2 rounded text-xs"
					style={{
						backgroundColor: `${theme.colors.error}15`,
						color: theme.colors.error,
					}}
				>
					Failed to load stats: {error}
				</div>
			)}

			{/* Per-agent table */}
			<div
				className="border rounded-md overflow-hidden"
				style={{ borderColor: theme.colors.border }}
			>
				<table className="w-full text-xs" style={{ color: theme.colors.textMain }}>
					<thead style={{ backgroundColor: theme.colors.bgMain }}>
						<tr className="text-left" style={{ color: theme.colors.textDim }}>
							<HeaderCell onClick={() => setSort('name')} indicator={sortIndicator('name')}>
								Agent
							</HeaderCell>
							<HeaderCell onClick={() => setSort('state')} indicator={sortIndicator('state')}>
								State
							</HeaderCell>
							<HeaderCell onClick={() => setSort('tabs')} indicator={sortIndicator('tabs')}>
								Tabs
							</HeaderCell>
							<HeaderCell onClick={() => setSort('logs')} indicator={sortIndicator('logs')}>
								Logs
							</HeaderCell>
							<HeaderCell onClick={() => setSort('fileTree')} indicator={sortIndicator('fileTree')}>
								File Tree
							</HeaderCell>
							<HeaderCell onClick={() => setSort('data')} indicator={sortIndicator('data')}>
								Data
							</HeaderCell>
							<HeaderCell onClick={() => setSort('rss')} indicator={sortIndicator('rss')}>
								Process RSS
							</HeaderCell>
						</tr>
					</thead>
					<tbody>
						{sortedFootprints.map((f) => (
							<tr
								key={f.session.id}
								className="border-t"
								style={{ borderColor: theme.colors.border }}
							>
								<td className="px-2 py-1.5">
									<div className="font-medium truncate" title={f.session.name}>
										{f.session.name}
									</div>
									<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
										{getAgentDisplayName(f.session.toolType)}
									</div>
								</td>
								<td className="px-2 py-1.5">
									<LoadBadge state={f.loadState} theme={theme} />
								</td>
								<td className="px-2 py-1.5">
									<div>{f.aiTabCount} ai</div>
									<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
										{f.terminalTabCount > 0 && `${f.terminalTabCount} term · `}
										{f.filePreviewTabCount > 0 && `${f.filePreviewTabCount} file · `}
										{f.browserTabCount > 0 && `${f.browserTabCount} web`}
										{f.terminalTabCount + f.filePreviewTabCount + f.browserTabCount === 0 && '—'}
									</div>
								</td>
								<td className="px-2 py-1.5">
									<div>{formatNumber(f.logCount)}</div>
									<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
										{formatSize(f.logBytes)}
									</div>
								</td>
								<td className="px-2 py-1.5">
									<div>{formatNumber(f.fileTreeNodes)}</div>
									<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
										{formatSize(f.fileTreeBytes)}
									</div>
								</td>
								<td className="px-2 py-1.5 font-mono" style={{ color: theme.colors.accent }}>
									{formatSize(f.dataBytes)}
								</td>
								<td className="px-2 py-1.5 font-mono">
									{f.processRssBytes !== undefined ? (
										<>
											<div>{formatSize(f.processRssBytes)}</div>
											<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
												pid {f.processPid}
											</div>
										</>
									) : (
										<span style={{ color: theme.colors.textDim }}>—</span>
									)}
								</td>
							</tr>
						))}
						{sortedFootprints.length === 0 && (
							<tr>
								<td
									colSpan={7}
									className="px-2 py-4 text-center text-xs"
									style={{ color: theme.colors.textDim }}
								>
									No agents.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			{/* Electron processes */}
			{snapshot && snapshot.electronProcesses.length > 0 && (
				<details className="mt-4">
					<summary className="cursor-pointer text-xs py-1" style={{ color: theme.colors.textDim }}>
						Electron processes ({snapshot.electronProcesses.length})
					</summary>
					<div
						className="border rounded-md overflow-hidden mt-2"
						style={{ borderColor: theme.colors.border }}
					>
						<table className="w-full text-xs" style={{ color: theme.colors.textMain }}>
							<thead style={{ backgroundColor: theme.colors.bgMain }}>
								<tr className="text-left" style={{ color: theme.colors.textDim }}>
									<th className="px-2 py-1">PID</th>
									<th className="px-2 py-1">Type</th>
									<th className="px-2 py-1">Name</th>
									<th className="px-2 py-1 text-right">Working Set</th>
									<th className="px-2 py-1 text-right">CPU</th>
								</tr>
							</thead>
							<tbody>
								{snapshot.electronProcesses.map((p) => (
									<tr key={p.pid} className="border-t" style={{ borderColor: theme.colors.border }}>
										<td className="px-2 py-1 font-mono">{p.pid}</td>
										<td className="px-2 py-1">{p.type}</td>
										<td className="px-2 py-1 truncate max-w-[200px]">
											{p.name || p.serviceName || '—'}
										</td>
										<td className="px-2 py-1 text-right font-mono">
											{p.workingSetBytes !== undefined ? formatSize(p.workingSetBytes) : '—'}
										</td>
										<td className="px-2 py-1 text-right font-mono">
											{p.cpuPercent !== undefined ? `${p.cpuPercent.toFixed(1)}%` : '—'}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</details>
			)}
		</Modal>
	);
}

function SummaryCard({
	theme,
	label,
	primary,
	secondary,
}: {
	theme: Theme;
	label: string;
	primary: string;
	secondary: string;
}) {
	return (
		<div
			className="p-3 rounded-md border"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<div
				className="text-[10px] uppercase tracking-wide mb-1"
				style={{ color: theme.colors.textDim }}
			>
				{label}
			</div>
			<div className="text-base font-semibold" style={{ color: theme.colors.textMain }}>
				{primary}
			</div>
			<div className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
				{secondary}
			</div>
		</div>
	);
}

function HeaderCell({
	children,
	onClick,
	indicator,
}: {
	children: React.ReactNode;
	onClick?: () => void;
	indicator?: string;
}) {
	const clickable = !!onClick;
	return (
		<th
			className={`px-2 py-1 font-normal text-[10px] uppercase tracking-wide ${clickable ? 'cursor-pointer select-none' : ''}`}
			onClick={onClick}
		>
			{children}
			{indicator}
		</th>
	);
}

export default DebugApplicationStatsModal;
