/**
 * DebugApplicationStatsModal - what Maestro costs this computer right now.
 *
 * Top to bottom: the overview (memory, CPU, processes, Local Models disk), the
 * Electron processes, Local Models (the model server's process tree, the
 * models resident inside the main process, and every model on disk), then the
 * per-agent breakdown used to verify that session data loads opportunistically
 * (cold on launch, warm as the user switches between agents).
 *
 * The snapshot is `collectAppStats()` in main; `maestro-cli app-stats` reads the
 * same one. The per-agent data footprint is computed here from renderer state,
 * which is the only place it exists.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	Activity,
	Boxes,
	Brain,
	Cpu,
	Flame,
	HardDrive,
	Layers,
	MemoryStick,
	RefreshCw,
	Server,
	Snowflake,
	Users,
	Zap,
} from 'lucide-react';
import type { Theme, Session } from '../types';
import { Modal } from './ui/Modal';
import { MiniBadge } from './ui/MiniBadge';
import { Spinner } from './ui/Spinner';
import { MetricCard } from './UsageDashboard/SummaryCards';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { formatCountNoun, formatNumber, formatSize } from '../../shared/formatters';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import {
	formatCpuPercent,
	inProcessModels,
	memoryShareOfSystem,
	type AppStatsManagedProcess,
	type AppStatsSnapshot,
	type ProcessTreeUsage,
} from '../../shared/appStats';
import { useSessionStore } from '../stores/sessionStore';
import { logger } from '../utils/logger';

interface DebugApplicationStatsModalProps {
	theme: Theme;
	onClose: () => void;
}

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
	/** Every process tree this agent runs (AI tabs, terminals, Auto Run, Cue), summed. */
	processUsage?: ProcessTreeUsage;
	/** How many processes the app spawned for it (each the root of a tree). */
	spawnedCount: number;
}

type SortKey = 'name' | 'state' | 'tabs' | 'logs' | 'fileTree' | 'data' | 'rss';

// Cheap estimator - summing `.length` of strings roughly approximates the
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

/**
 * Whether a spawned process belongs to an agent. Every process key starts with
 * the agent's id: `{id}-ai-{tab}`, `{id}-terminal-{tab}`, `{id}-batch-{ts}`,
 * `{id}-synopsis-{ts}`, `{id}-cue-...`. Agent ids are UUIDs, so a prefix never
 * names the wrong agent. Matching on `aiPid` instead missed every per-tab turn,
 * which leaves `aiPid` at 0.
 */
function processBelongsTo(process: AppStatsManagedProcess, agentId: string): boolean {
	return process.sessionId === agentId || process.sessionId.startsWith(`${agentId}-`);
}

function sumUsage(processes: readonly AppStatsManagedProcess[]): ProcessTreeUsage | undefined {
	const measured = processes.filter((p) => p.processCount !== undefined);
	if (measured.length === 0) return undefined;
	return measured.reduce<ProcessTreeUsage>(
		(sum, p) => ({
			processCount: sum.processCount + (p.processCount ?? 0),
			rssBytes: sum.rssBytes + (p.rssBytes ?? 0),
			cpuPercent: sum.cpuPercent + (p.cpuPercent ?? 0),
		}),
		{ processCount: 0, rssBytes: 0, cpuPercent: 0 }
	);
}

function computeFootprint(
	session: Session,
	managed: readonly AppStatsManagedProcess[]
): SessionFootprint {
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

	const owned = managed.filter((p) => processBelongsTo(p, session.id));

	// Load state reflects *lazy-loaded* state only. Fields like `aiTabs[].logs`,
	// `filePreviewTabs`, and `browserTabs` are persisted to disk and rehydrated
	// at app launch, so they can't tell us if the agent has been touched this
	// session. `fileTree` and live processes are reset on restore and only
	// populated after the user focuses / interacts with the agent, so they're
	// the reliable signals.
	const liveTerminalPid = (session.terminalTabs ?? []).some((t) => t.pid && t.pid > 0);
	const hasLiveProcess =
		owned.length > 0 || (session.aiPid !== undefined && session.aiPid > 0) || liveTerminalPid;
	let loadState: LoadState;
	if (hasLiveProcess) {
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
		processUsage: sumUsage(owned),
		spawnedCount: owned.length,
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
			className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs uppercase tracking-wide"
			style={{ color, border: `1px solid ${color}`, opacity: state === 'cold' ? 0.7 : 1 }}
		>
			<Icon className="w-2.5 h-2.5" />
			{LOAD_STATE_LABEL[state]}
		</span>
	);
}

const ICON = 'w-4 h-4';

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
			const response = await window.maestro.debug.getAppStats();
			if (response.success) setSnapshot(response);
			else setError(response.error);
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

	const footprints = useMemo(
		() => sessions.map((s) => computeFootprint(s, snapshot?.managedProcesses ?? [])),
		[sessions, snapshot]
	);

	const totals = useMemo(() => {
		let dataBytes = 0;
		let active = 0;
		let warm = 0;
		let logCount = 0;
		for (const f of footprints) {
			dataBytes += f.dataBytes;
			logCount += f.logCount;
			if (f.loadState === 'active') active++;
			else if (f.loadState === 'warm') warm++;
		}
		return {
			dataBytes,
			logCount,
			active,
			warm,
			cold: footprints.length - active - warm,
		};
	}, [footprints]);

	/** Every agent and terminal tree, including ones no listed agent owns (a group chat moderator). */
	const agentUsage = useMemo(
		() => (snapshot ? sumUsage(snapshot.managedProcesses) : undefined),
		[snapshot]
	);

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
					return ((a.processUsage?.rssBytes ?? -1) - (b.processUsage?.rssBytes ?? -1)) * dir;
				case 'data':
				default:
					return (a.dataBytes - b.dataBytes) * dir;
			}
		});
		return arr;
	}, [footprints, sortKey, sortAsc]);

	const electron = useMemo(() => {
		if (!snapshot) return { memoryBytes: 0, cpuPercent: 0 };
		return snapshot.electronProcesses.reduce(
			(sum, p) => ({
				memoryBytes: sum.memoryBytes + (p.workingSetBytes ?? 0),
				cpuPercent: sum.cpuPercent + (p.cpuPercent ?? 0),
			}),
			{ memoryBytes: 0, cpuPercent: 0 }
		);
	}, [snapshot]);

	const setSort = (key: SortKey) => {
		if (key === sortKey) setSortAsc((v) => !v);
		else {
			setSortKey(key);
			setSortAsc(key === 'name');
		}
	};

	const sortIndicator = (key: SortKey) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');
	const pending = 'loading…';

	return (
		<Modal
			theme={theme}
			title="Application Stats"
			headerIcon={<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.DEBUG_APPLICATION_STATS}
			onClose={onClose}
			width={880}
			maxHeight="85vh"
			closeOnBackdropClick
			footer={
				<div className="flex items-center justify-between w-full gap-4">
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Process memory and CPU cover each process with everything it started (MCP servers,
						shells, model workers). Models loaded in-process count toward the Browser (main)
						process. Agent state reflects lazy-loaded runtime only; data bytes are rough UTF-16
						estimates for relative comparison.
					</p>
					<button
						type="button"
						onClick={refresh}
						disabled={loading}
						className="px-3 py-1.5 rounded border text-sm flex items-center gap-2 transition-colors hover:bg-white/5 disabled:opacity-50 flex-shrink-0"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						{loading ? <Spinner size={14} /> : <RefreshCw className="w-3.5 h-3.5" />}
						Refresh
					</button>
				</div>
			}
		>
			{error && (
				<div
					className="mb-3 p-2 rounded text-xs select-text"
					style={{
						backgroundColor: `${theme.colors.error}15`,
						color: theme.colors.error,
					}}
				>
					Failed to load stats: {error}
				</div>
			)}

			{/* Overview: what Maestro as a whole costs this computer */}
			<SectionHeading theme={theme}>Overview</SectionHeading>
			<div className="grid grid-cols-4 gap-3 mb-2">
				<MetricCard
					theme={theme}
					icon={<MemoryStick className={ICON} />}
					label="Memory"
					value={snapshot ? formatSize(snapshot.totals.memoryBytes) : '-'}
					subValue={
						snapshot
							? `${memoryShareOfSystem(snapshot).toFixed(1)}% of ${formatSize(snapshot.system.totalMemoryBytes)} · ${formatSize(snapshot.system.freeMemoryBytes)} free`
							: pending
					}
				/>
				<MetricCard
					theme={theme}
					icon={<Cpu className={ICON} />}
					label="CPU"
					value={snapshot ? formatCpuPercent(snapshot.totals.cpuPercent) : '-'}
					subValue={
						snapshot
							? `${formatCountNoun(snapshot.system.cpuCount, 'core')}${
									snapshot.system.loadAverage
										? ` · load ${snapshot.system.loadAverage.map((n) => n.toFixed(2)).join(' ')}`
										: ''
								}`
							: pending
					}
				/>
				<MetricCard
					theme={theme}
					icon={<Layers className={ICON} />}
					label="Processes"
					value={snapshot ? formatNumber(snapshot.totals.processCount) : '-'}
					subValue={
						snapshot
							? `${snapshot.electronProcesses.length} Electron · ${agentUsage?.processCount ?? 0} agent · ${snapshot.localModels.modelServer.usage?.processCount ?? 0} model server`
							: pending
					}
				/>
				<MetricCard
					theme={theme}
					icon={<HardDrive className={ICON} />}
					label="Model Disk"
					value={snapshot ? formatSize(snapshot.localModels.disk.totalBytes) : '-'}
					subValue={
						snapshot
							? `${formatCountNoun(snapshot.localModels.disk.models.length, 'model')} · runtimes ${formatSize(snapshot.localModels.disk.runtimesBytes)}`
							: pending
					}
				/>
			</div>
			{snapshot && !snapshot.totals.processTreesMeasured && (
				<p className="text-2xs mb-2" style={{ color: theme.colors.warning }}>
					This platform's process table could not be read, so agent and model server trees are
					missing from these totals.
				</p>
			)}

			{/* Electron processes */}
			{snapshot && snapshot.electronProcesses.length > 0 && (
				<details className="mb-4 mt-2">
					<summary className="cursor-pointer text-xs py-1" style={{ color: theme.colors.textDim }}>
						Electron processes ({snapshot.electronProcesses.length}) ·{' '}
						{formatSize(electron.memoryBytes)} · {formatCpuPercent(electron.cpuPercent)} CPU · main
						heap {formatSize(snapshot.main.heapUsed)} / {formatSize(snapshot.main.heapTotal)}
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
											{p.name || p.serviceName || '-'}
										</td>
										<td className="px-2 py-1 text-right font-mono">
											{p.workingSetBytes !== undefined ? formatSize(p.workingSetBytes) : '-'}
										</td>
										<td className="px-2 py-1 text-right font-mono">
											{p.cpuPercent !== undefined ? formatCpuPercent(p.cpuPercent) : '-'}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</details>
			)}

			{snapshot && <LocalModelsSection theme={theme} snapshot={snapshot} />}

			{/* Agents */}
			<SectionHeading theme={theme}>Agents</SectionHeading>
			<div className="grid grid-cols-3 gap-3 mb-4">
				<MetricCard
					theme={theme}
					icon={<Users className={ICON} />}
					label="Agents"
					value={`${sessions.length}`}
					subValue={`${totals.active} active · ${totals.warm} warm · ${totals.cold} cold`}
				/>
				<MetricCard
					theme={theme}
					icon={<Boxes className={ICON} />}
					label="Data Footprint"
					value={formatSize(totals.dataBytes)}
					subValue={`${formatNumber(totals.logCount)} log entries`}
				/>
				<MetricCard
					theme={theme}
					icon={<Activity className={ICON} />}
					label="Agent Processes"
					value={agentUsage ? formatSize(agentUsage.rssBytes) : '-'}
					subValue={
						snapshot
							? `${formatCountNoun(snapshot.managedProcesses.length, 'spawned tree')} · ${formatCountNoun(agentUsage?.processCount ?? 0, 'process', 'processes')} · ${formatCpuPercent(agentUsage?.cpuPercent ?? 0)} CPU`
							: pending
					}
				/>
			</div>

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
								Processes
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
									<div className="text-2xs" style={{ color: theme.colors.textDim }}>
										{getAgentDisplayName(f.session.toolType)}
									</div>
								</td>
								<td className="px-2 py-1.5">
									<LoadBadge state={f.loadState} theme={theme} />
								</td>
								<td className="px-2 py-1.5">
									<div>{f.aiTabCount} ai</div>
									<div className="text-2xs" style={{ color: theme.colors.textDim }}>
										{[
											f.terminalTabCount > 0 && `${f.terminalTabCount} term`,
											f.filePreviewTabCount > 0 && `${f.filePreviewTabCount} file`,
											f.browserTabCount > 0 && `${f.browserTabCount} web`,
										]
											.filter(Boolean)
											.join(' · ') || '-'}
									</div>
								</td>
								<td className="px-2 py-1.5">
									<div>{formatNumber(f.logCount)}</div>
									<div className="text-2xs" style={{ color: theme.colors.textDim }}>
										{formatSize(f.logBytes)}
									</div>
								</td>
								<td className="px-2 py-1.5">
									<div>{formatNumber(f.fileTreeNodes)}</div>
									<div className="text-2xs" style={{ color: theme.colors.textDim }}>
										{formatSize(f.fileTreeBytes)}
									</div>
								</td>
								<td className="px-2 py-1.5 font-mono" style={{ color: theme.colors.accent }}>
									{formatSize(f.dataBytes)}
								</td>
								<td className="px-2 py-1.5 font-mono">
									{f.processUsage ? (
										<>
											<div>{formatSize(f.processUsage.rssBytes)}</div>
											<div className="text-2xs" style={{ color: theme.colors.textDim }}>
												{f.processUsage.processCount} proc ·{' '}
												{formatCpuPercent(f.processUsage.cpuPercent)}
											</div>
										</>
									) : (
										<span style={{ color: theme.colors.textDim }}>
											{f.spawnedCount > 0 ? `${f.spawnedCount} spawned` : '-'}
										</span>
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
		</Modal>
	);
}

/**
 * Local Models: the model server's process tree, the models resident inside
 * the main process, and every model directory on disk with where it is loaded.
 */
function LocalModelsSection({ theme, snapshot }: { theme: Theme; snapshot: AppStatsSnapshot }) {
	const { disk, modelServer } = snapshot.localModels;
	const resident = useMemo(() => inProcessModels(snapshot.localModels), [snapshot]);
	const nameOf = (id: string) => disk.models.find((m) => m.id === id)?.name ?? id;
	const residentRole = new Map(resident.map((m) => [m.id, m.role]));
	const serverLoaded = new Set(modelServer.loadedModels);
	const serverServes = new Set(modelServer.models);

	return (
		<>
			<SectionHeading theme={theme}>Local Models</SectionHeading>
			<div className="grid grid-cols-3 gap-3 mb-3">
				<MetricCard
					theme={theme}
					icon={<Server className={ICON} />}
					label="Model Server"
					value={modelServer.usage ? formatSize(modelServer.usage.rssBytes) : modelServer.state}
					subValue={
						modelServer.usage
							? `${formatCountNoun(modelServer.usage.processCount, 'process', 'processes')} · ${formatCpuPercent(modelServer.usage.cpuPercent)} CPU · ${modelServer.loadedModels.length} of ${modelServer.models.length} loaded`
							: modelServer.state === 'stopped'
								? 'not running'
								: `pid ${modelServer.pid ?? '-'}`
					}
				/>
				<MetricCard
					theme={theme}
					icon={<Brain className={ICON} />}
					label="In-Process"
					value={`${resident.length} loaded`}
					subValue={
						resident.length > 0
							? resident.map((m) => nameOf(m.id)).join(', ')
							: 'no models in the main process'
					}
				/>
				<MetricCard
					theme={theme}
					icon={<HardDrive className={ICON} />}
					label="On Disk"
					value={formatSize(disk.totalBytes)}
					subValue={`models ${formatSize(disk.modelsBytes)} · runtimes ${formatSize(disk.runtimesBytes)} (server engine ${formatSize(disk.serverEngineBytes)}) · server data ${formatSize(disk.serverDataBytes)} · search index ${formatSize(disk.semanticIndexBytes)}`}
				/>
			</div>

			{disk.models.length > 0 && (
				<div
					className="border rounded-md overflow-hidden mb-4"
					style={{ borderColor: theme.colors.border }}
				>
					<table className="w-full text-xs" style={{ color: theme.colors.textMain }}>
						<thead style={{ backgroundColor: theme.colors.bgMain }}>
							<tr className="text-left" style={{ color: theme.colors.textDim }}>
								<HeaderCell>Model</HeaderCell>
								<HeaderCell>Kind</HeaderCell>
								<HeaderCell>Loaded</HeaderCell>
								<th className="px-2 py-1 font-normal text-2xs uppercase tracking-wide text-right">
									On Disk
								</th>
							</tr>
						</thead>
						<tbody>
							{disk.models.map((model) => {
								const role = residentRole.get(model.id);
								return (
									<tr
										key={model.id}
										className="border-t"
										style={{ borderColor: theme.colors.border }}
									>
										<td className="px-2 py-1.5">
											<div className="font-medium truncate select-text" title={model.id}>
												{model.name}
											</div>
											{model.name !== model.id && (
												<div
													className="text-2xs font-mono truncate select-text"
													style={{ color: theme.colors.textDim }}
												>
													{model.id}
												</div>
											)}
										</td>
										<td className="px-2 py-1.5" style={{ color: theme.colors.textDim }}>
											{model.kind ?? 'unknown'}
											{model.userAdded && ' · added'}
										</td>
										<td className="px-2 py-1.5">
											<div className="flex flex-wrap gap-1">
												{role && (
													<MiniBadge
														theme={theme}
														label={`In-process ${role}`}
														title="Resident in the main (Browser) process"
													/>
												)}
												{serverLoaded.has(model.id) ? (
													<MiniBadge
														theme={theme}
														label="Server"
														color={theme.colors.success}
														title="Loaded by the model server"
													/>
												) : (
													serverServes.has(model.id) && (
														<MiniBadge
															theme={theme}
															label="Served"
															color={theme.colors.textDim}
															title="The model server offers it; not loaded right now"
														/>
													)
												)}
												{!role && !serverServes.has(model.id) && (
													<span style={{ color: theme.colors.textDim }}>-</span>
												)}
											</div>
										</td>
										<td className="px-2 py-1.5 text-right font-mono">{formatSize(model.bytes)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</>
	);
}

function SectionHeading({ theme, children }: { theme: Theme; children: React.ReactNode }) {
	return (
		<h3
			className="text-2xs uppercase tracking-wide font-semibold mb-2 mt-1"
			style={{ color: theme.colors.textDim }}
		>
			{children}
		</h3>
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
			className={`px-2 py-1 font-normal text-2xs uppercase tracking-wide ${clickable ? 'cursor-pointer select-none' : ''}`}
			onClick={onClick}
		>
			{children}
			{indicator}
		</th>
	);
}

export default DebugApplicationStatsModal;
