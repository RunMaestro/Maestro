/**
 * FleetView — compact list of all registered agents visible to Agent Dispatch.
 *
 * Shows host, provider, readiness, current load, active claims, and
 * pickup-enabled state. Provides pause/resume auto-pickup controls and
 * launches the AgentDispatchProfileEditor for capability editing.
 */

import { useState } from 'react';
import {
	Pause,
	Play,
	Server,
	Monitor,
	ServerCrash,
	Users,
	Wifi,
	WifiOff,
	RefreshCw,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import type { AgentDispatchReadiness } from '../../../shared/agent-dispatch-types';
import { useAgentDispatchFleet } from '../../hooks/useAgentDispatchFleet';
import { EmptyState, InlineHelp } from '../ui';
import { AgentDispatchProfileEditor } from './AgentDispatchProfileEditor';
import { AgentClaimList } from './AgentClaimList';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readinessColor(readiness: AgentDispatchReadiness, theme: Theme): string {
	switch (readiness) {
		case 'ready':
		case 'idle':
			return theme.colors.success;
		case 'busy':
			return theme.colors.accent;
		case 'paused':
			return theme.colors.warning;
		case 'connecting':
			return theme.colors.warning;
		case 'error':
			return theme.colors.error;
		case 'unavailable':
		default:
			return theme.colors.textDim;
	}
}

function readinessLabel(readiness: AgentDispatchReadiness): string {
	switch (readiness) {
		case 'ready':
			return 'Ready';
		case 'idle':
			return 'Idle';
		case 'busy':
			return 'Busy';
		case 'paused':
			return 'Paused';
		case 'connecting':
			return 'Connecting';
		case 'error':
			return 'Error';
		case 'unavailable':
		default:
			return 'Unavailable';
	}
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ReadinessDot({ readiness, theme }: { readiness: AgentDispatchReadiness; theme: Theme }) {
	const isPulsing = readiness === 'connecting';
	return (
		<span
			className={`inline-block w-2 h-2 rounded-full flex-shrink-0${isPulsing ? ' animate-pulse' : ''}`}
			style={{ backgroundColor: readinessColor(readiness, theme) }}
			title={readinessLabel(readiness)}
		/>
	);
}

function LocalityBadge({ entry, theme }: { entry: AgentDispatchFleetEntry; theme: Theme }) {
	const isConnected =
		entry.readiness !== 'unavailable' &&
		entry.readiness !== 'error' &&
		entry.readiness !== 'connecting';

	if (entry.locality === 'ssh') {
		const remoteName = entry.sshRemote?.name ?? entry.sshRemote?.id ?? entry.host;
		return (
			<span
				className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
				style={{
					backgroundColor: (isConnected ? theme.colors.accent : theme.colors.error) + '20',
					color: isConnected ? theme.colors.accent : theme.colors.error,
					border: `1px solid ${isConnected ? theme.colors.accent : theme.colors.error}40`,
				}}
				title={`SSH: ${entry.host}`}
			>
				{isConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
				<span className="font-mono truncate max-w-[120px]">{remoteName}</span>
			</span>
		);
	}

	return (
		<span
			className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
			style={{
				backgroundColor: theme.colors.border + '60',
				color: theme.colors.textDim,
			}}
		>
			<Monitor className="w-3 h-3" />
			<span>local</span>
		</span>
	);
}

function CapabilityTags({ tags, theme }: { tags: string[]; theme: Theme }) {
	if (tags.length === 0) {
		return (
			<span style={{ color: theme.colors.textDim }} className="text-xs italic">
				none
			</span>
		);
	}
	return (
		<div className="flex flex-wrap gap-1">
			{tags.map((tag) => (
				<span
					key={tag}
					className="text-xs px-1.5 py-0.5 rounded"
					style={{
						backgroundColor: theme.colors.accentDim,
						color: theme.colors.accentText,
					}}
				>
					{tag}
				</span>
			))}
		</div>
	);
}

// ─── Fleet Entry Row ──────────────────────────────────────────────────────────

interface FleetEntryRowProps {
	entry: AgentDispatchFleetEntry;
	theme: Theme;
	onPause: (agentId: string) => Promise<void>;
	onResume: (agentId: string) => Promise<void>;
}

function FleetEntryRow({ entry, theme, onPause, onResume }: FleetEntryRowProps) {
	const [showEditor, setShowEditor] = useState(false);
	const [showClaims, setShowClaims] = useState(false);
	const [actionPending, setActionPending] = useState(false);

	const isPaused = entry.readiness === 'paused' || !entry.pickupEnabled;
	const activeClaims = entry.currentClaims.filter((c) => c.status === 'active');

	const handleTogglePause = async () => {
		setActionPending(true);
		try {
			if (isPaused) {
				await onResume(entry.agentId);
			} else {
				await onPause(entry.agentId);
			}
		} finally {
			setActionPending(false);
		}
	};

	return (
		<>
			<tr className="border-b text-sm" style={{ borderColor: theme.colors.border }}>
				{/* Agent name + locality */}
				<td className="py-2 pr-3">
					<div className="flex items-center gap-2 min-w-0">
						<ReadinessDot readiness={entry.readiness} theme={theme} />
						<span
							className="font-medium truncate"
							style={{ color: theme.colors.textMain }}
							title={entry.displayName}
						>
							{entry.displayName}
						</span>
					</div>
					<div className="mt-1 ml-4">
						<LocalityBadge entry={entry} theme={theme} />
					</div>
				</td>

				{/* Provider */}
				<td className="py-2 pr-3 text-xs font-mono" style={{ color: theme.colors.textDim }}>
					{entry.providerType}
				</td>

				{/* Readiness */}
				<td className="py-2 pr-3">
					<span
						className="text-xs font-medium"
						style={{ color: readinessColor(entry.readiness, theme) }}
					>
						{readinessLabel(entry.readiness)}
					</span>
				</td>

				{/* Load */}
				<td className="py-2 pr-3 text-xs tabular-nums" style={{ color: theme.colors.textDim }}>
					{entry.currentLoad}/{entry.dispatchProfile.maxConcurrentClaims}
				</td>

				{/* Active claims (clickable) */}
				<td className="py-2 pr-3">
					{activeClaims.length > 0 ? (
						<button
							className="text-xs underline underline-offset-2 hover:opacity-70"
							style={{ color: theme.colors.accent }}
							onClick={() => setShowClaims((v) => !v)}
							title="View active claims"
						>
							{activeClaims.length} claim{activeClaims.length !== 1 ? 's' : ''}
						</button>
					) : (
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							—
						</span>
					)}
				</td>

				{/* Capabilities (clickable to edit) */}
				<td className="py-2 pr-3">
					<button
						className="text-left hover:opacity-70 transition-opacity"
						onClick={() => setShowEditor((v) => !v)}
						title="Edit dispatch profile"
					>
						<CapabilityTags tags={entry.dispatchCapabilities} theme={theme} />
					</button>
				</td>

				{/* Pause / resume */}
				<td className="py-2 text-right">
					<button
						className="p-1.5 rounded transition-colors hover:opacity-70 disabled:opacity-40"
						style={{
							backgroundColor: isPaused ? theme.colors.success + '20' : theme.colors.warning + '20',
							color: isPaused ? theme.colors.success : theme.colors.warning,
						}}
						onClick={handleTogglePause}
						disabled={actionPending}
						title={isPaused ? 'Resume auto-pickup' : 'Pause auto-pickup'}
					>
						{isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
					</button>
				</td>
			</tr>

			{/* Expandable claim list */}
			{showClaims && (
				<tr style={{ borderColor: theme.colors.border }}>
					<td colSpan={7} className="pb-3 pt-1 px-4">
						<AgentClaimList entry={entry} theme={theme} onDone={() => setShowClaims(false)} />
					</td>
				</tr>
			)}

			{/* Expandable profile editor */}
			{showEditor && (
				<tr style={{ borderColor: theme.colors.border }}>
					<td colSpan={7} className="pb-3 pt-1 px-4">
						<AgentDispatchProfileEditor
							entry={entry}
							theme={theme}
							onClose={() => setShowEditor(false)}
						/>
					</td>
				</tr>
			)}
		</>
	);
}

// ─── Main Component ───────────────────────────────────────────────────────────

export interface FleetViewProps {
	theme: Theme;
}

export function FleetView({ theme }: FleetViewProps) {
	const { fleet, loading, error, refresh, pauseAgent, resumeAgent } = useAgentDispatchFleet();

	if (loading && fleet.length === 0) {
		return (
			<div
				className="flex items-center justify-center p-8 text-sm"
				style={{ color: theme.colors.textDim }}
			>
				<Server className="w-4 h-4 mr-2 animate-pulse" />
				Loading fleet…
			</div>
		);
	}

	if (error) {
		return (
			<EmptyState
				theme={theme}
				icon={<ServerCrash className="w-10 h-10" />}
				title="Fleet unavailable"
				description={error}
				primaryAction={{ label: 'Retry', onClick: () => void refresh() }}
				helpHref="https://docs.runmaestro.ai/agent-dispatch"
				helpLabel="Agent Dispatch docs"
			/>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{/* Header row */}
			<div className="flex items-center justify-between">
				<span
					className="text-xs font-semibold uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Agent Fleet
				</span>
				<button
					className="p-1 rounded hover:opacity-70 transition-opacity disabled:opacity-40"
					style={{ color: theme.colors.textDim }}
					onClick={() => void refresh()}
					disabled={loading}
					title="Refresh fleet"
				>
					<RefreshCw className={`w-3.5 h-3.5${loading ? ' animate-spin' : ''}`} />
				</button>
			</div>

			{fleet.length === 0 ? (
				<div className="flex flex-col items-center">
					<EmptyState
						theme={theme}
						icon={<Users className="w-10 h-10" />}
						title="No agents registered"
						description="Start a Maestro agent to see it appear here."
						helpHref="https://docs.runmaestro.ai/agent-dispatch#fleet"
						helpLabel="Fleet setup guide"
					/>
					<div className="mt-1">
						<InlineHelp label="How does the fleet work?">
							Each agent you start in Maestro registers itself with the dispatch runtime and appears
							in this table. You can pause/resume auto-pickup per agent and edit its dispatch
							profile (capabilities, max concurrent claims).
						</InlineHelp>
					</div>
				</div>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr
								className="text-left text-xs border-b"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								<th className="pb-2 pr-3 font-medium">Agent</th>
								<th className="pb-2 pr-3 font-medium">Provider</th>
								<th className="pb-2 pr-3 font-medium">Status</th>
								<th className="pb-2 pr-3 font-medium">Load</th>
								<th className="pb-2 pr-3 font-medium">Claims</th>
								<th className="pb-2 pr-3 font-medium">Capabilities</th>
								<th className="pb-2 text-right font-medium">Pickup</th>
							</tr>
						</thead>
						<tbody>
							{fleet.map((entry) => (
								<FleetEntryRow
									key={entry.id}
									entry={entry}
									theme={theme}
									onPause={pauseAgent}
									onResume={resumeAgent}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
