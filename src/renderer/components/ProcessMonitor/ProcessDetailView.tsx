import { useEffect, useMemo, useRef, useState } from 'react';
import {
	Activity,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Clock,
	Cpu,
	FolderOpen,
	Hash,
	Play,
	Server,
	Tag,
	Terminal,
	User,
	Variable,
	X,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { ProcessDetailData } from './types';
import { formatRuntime } from './runtime';

export interface ProcessDetailViewProps {
	theme: Theme;
	detail: ProcessDetailData;
	/** Assigned account name for the owning agent (account multiplexing) */
	accountName?: string;
	onBack: () => void;
	onClose: () => void;
}

// Detail panel for a single process. Renders a metadata grid; receives focus on mount
// so Escape (handled by useModalLayer in the shell) routes back to the list view.
const ENV_VAR_COLLAPSED_LIMIT = 5;

export function ProcessDetailView({
	theme,
	detail,
	accountName,
	onBack,
	onClose,
}: ProcessDetailViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [envExpanded, setEnvExpanded] = useState(false);

	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	const envEntries = useMemo(
		() =>
			detail.maestroEnvVars
				? Object.entries(detail.maestroEnvVars).sort(([a], [b]) => a.localeCompare(b))
				: [],
		[detail.maestroEnvVars]
	);
	const envOverflow = Math.max(0, envEntries.length - ENV_VAR_COLLAPSED_LIMIT);
	const visibleEnvEntries =
		envExpanded || envOverflow === 0 ? envEntries : envEntries.slice(0, ENV_VAR_COLLAPSED_LIMIT);

	const commandLine =
		detail.command && detail.args && detail.args.length > 0
			? `${detail.command} ${detail.args.join(' ')}`
			: detail.command || 'N/A';

	return (
		<div
			ref={containerRef}
			tabIndex={-1}
			className="flex flex-col h-full min-h-0 overflow-hidden outline-none"
		>
			{/* Detail Header */}
			<div
				className="px-6 py-4 border-b flex items-center justify-between"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-3">
					<button
						onClick={onBack}
						className="p-1.5 rounded hover:bg-opacity-10 flex items-center gap-1"
						style={{ color: theme.colors.textDim }}
						onMouseEnter={(e) =>
							(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
						}
						onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
						title="Back (Esc)"
					>
						<ChevronLeft className="w-5 h-5" />
					</button>
					<Cpu className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
						Process Details
					</h2>
					{detail.isAutoRun && (
						<span
							className="text-xs font-semibold px-2 py-1 rounded"
							style={{
								backgroundColor: theme.colors.accent + '20',
								color: theme.colors.accent,
							}}
						>
							AUTO RUN
						</span>
					)}
				</div>
				<button
					onClick={onClose}
					className="p-1.5 rounded hover:bg-opacity-10"
					style={{ color: theme.colors.textDim }}
					onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)}
					onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
					title="Close"
				>
					<X className="w-4 h-4" />
				</button>
			</div>

			{/* Detail Content */}
			<div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-6 md:px-12 py-6 space-y-6">
				{/* Process Name & Status */}
				<div className="flex items-center gap-3">
					<div className="w-3 h-3 rounded-full" style={{ backgroundColor: theme.colors.success }} />
					<span className="text-xl font-semibold" style={{ color: theme.colors.textMain }}>
						{detail.sessionName || 'Process'}
					</span>
					<span
						className="text-xs px-2 py-1 rounded"
						style={{
							backgroundColor: `${theme.colors.success}20`,
							color: theme.colors.success,
						}}
					>
						Running
					</span>
				</div>

				{/* Info Grid — 4-column on wide modal widths, 2-column on narrow.
				    Tiles use col-span-{1,2,4} to pack short fields into shared rows
				    and reserve full width for long/wrapping content. */}
				<div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
					{/* Process Session ID — half width; wraps to two lines for the long -ai-<tabId> form,
					    but that's preferable to leaving the row half-empty */}
					<div
						className="col-span-2 p-4 rounded-lg"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-center gap-2 mb-2">
							<Hash className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span
								className="text-xs font-medium uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								Process Session ID
							</span>
						</div>
						<code
							className="text-sm font-mono break-all"
							style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
						>
							{detail.processSessionId}
						</code>
					</div>

					{/* Started At — paired with Process Session ID on the top row */}
					<div
						className="col-span-2 p-4 rounded-lg"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-center gap-2 mb-2">
							<Clock className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span
								className="text-xs font-medium uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								Started At
							</span>
						</div>
						<span className="text-sm" style={{ color: theme.colors.textMain }}>
							{new Date(detail.startTime).toLocaleString()}
						</span>
					</div>

					{/* Account Info (account multiplexing) */}
					{accountName && (
						<div
							className="col-span-2 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<User className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Account
								</span>
							</div>
							<span className="text-sm" style={{ color: theme.colors.textMain }}>
								{accountName}
							</span>
						</div>
					)}

					{/* Agent Session ID — half width (UUID, ~36 chars) */}
					{detail.agentSessionId && (
						<div
							className="col-span-2 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Agent Session ID
								</span>
							</div>
							<code
								className="text-sm font-mono break-all"
								style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
							>
								{detail.agentSessionId}
							</code>
						</div>
					)}

					{/* Tab Name — half width */}
					{detail.tabName && (
						<div
							className="col-span-2 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Tag className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Tab Name
								</span>
							</div>
							<span className="text-sm" style={{ color: theme.colors.textMain }}>
								{detail.tabName}
							</span>
						</div>
					)}

					{/* PID — quarter width on wide, half on narrow */}
					<div
						className="col-span-1 p-4 rounded-lg"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-center gap-2 mb-2">
							<Terminal className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span
								className="text-xs font-medium uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								PID
							</span>
						</div>
						<code
							className="text-lg font-mono"
							style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
						>
							{detail.pid}
						</code>
					</div>

					{/* Runtime — quarter width */}
					<div
						className="col-span-1 p-4 rounded-lg"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-center gap-2 mb-2">
							<Clock className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span
								className="text-xs font-medium uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								Runtime
							</span>
						</div>
						<span className="text-lg font-mono" style={{ color: theme.colors.textMain }}>
							{formatRuntime(detail.startTime)}
						</span>
					</div>

					{/* Tool Type — quarter width */}
					<div
						className="col-span-1 p-4 rounded-lg"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-center gap-2 mb-2">
							<Cpu className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span
								className="text-xs font-medium uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								Tool Type
							</span>
						</div>
						<span className="text-sm" style={{ color: theme.colors.textMain }}>
							{detail.toolType}
						</span>
					</div>

					{/* Process Type — quarter width */}
					{detail.processType && (
						<div
							className="col-span-1 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Process Type
								</span>
							</div>
							<span className="text-sm" style={{ color: theme.colors.textMain }}>
								{detail.processType}
							</span>
						</div>
					)}

					{/* Cue-specific detail fields — half width each */}
					{detail.cueSubscriptionName && (
						<div
							className="col-span-2 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Activity className="w-4 h-4" style={{ color: '#06b6d4' }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Cue Subscription
								</span>
							</div>
							<span className="text-sm" style={{ color: theme.colors.textMain }}>
								{detail.cueSubscriptionName}
							</span>
						</div>
					)}

					{detail.cueEventType && (
						<div
							className="col-span-2 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Activity className="w-4 h-4" style={{ color: '#06b6d4' }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Event Type
								</span>
							</div>
							<span className="text-sm" style={{ color: theme.colors.textMain }}>
								{detail.cueEventType}
							</span>
						</div>
					)}

					{detail.cueSessionName && (
						<div
							className="col-span-2 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Cpu className="w-4 h-4" style={{ color: '#06b6d4' }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Target Session
								</span>
							</div>
							<span className="text-sm" style={{ color: theme.colors.textMain }}>
								{detail.cueSessionName}
							</span>
						</div>
					)}

					{/* Working Directory — full width (paths can be long) */}
					<div
						className="col-span-2 lg:col-span-4 p-4 rounded-lg"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-center gap-2 mb-2">
							<FolderOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span
								className="text-xs font-medium uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								Working Directory
							</span>
						</div>
						<code
							className="text-sm font-mono break-all"
							style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
						>
							{detail.cwd || 'N/A'}
						</code>
					</div>

					{/* Remote Command — full width. Shown only for SSH spawns: the actual agent
					    invocation running on the remote host, displayed above the local SSH
					    command line below so it's clear what is executing remotely. */}
					{detail.sshRemoteCommand && (
						<div
							className="col-span-2 lg:col-span-4 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Server className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Remote Command
								</span>
							</div>
							<code
								className="text-sm font-mono break-all block whitespace-pre-wrap overflow-y-auto"
								style={{
									color: theme.colors.textMain,
									userSelect: 'text',
									cursor: 'text',
									maxHeight: '300px',
								}}
							>
								{detail.sshRemoteCommand}
							</code>
						</div>
					)}

					{/* Command Line — full width (very long). For SSH spawns this is the local
					    `ssh ... /bin/bash` invocation; the remote agent command is shown above. */}
					<div
						className="col-span-2 lg:col-span-4 p-4 rounded-lg"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-center gap-2 mb-2">
							<Play className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span
								className="text-xs font-medium uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								{detail.sshRemoteCommand ? 'SSH Command' : 'Command Line'}
							</span>
						</div>
						<code
							className="text-sm font-mono break-all block whitespace-pre-wrap overflow-y-auto"
							style={{
								color: theme.colors.textMain,
								userSelect: 'text',
								cursor: 'text',
								maxHeight: '300px',
							}}
						>
							{commandLine}
						</code>
					</div>

					{/* Maestro Environment Variables — full width */}
					{envEntries.length > 0 && (
						<div
							className="col-span-2 lg:col-span-4 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center justify-between mb-2">
								<div className="flex items-center gap-2">
									<Variable className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<span
										className="text-xs font-medium uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Maestro Environment Variables
									</span>
									<span className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
										({envEntries.length})
									</span>
								</div>
								{envOverflow > 0 && (
									<button
										onClick={() => setEnvExpanded((v) => !v)}
										className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-opacity-10"
										style={{ color: theme.colors.accent }}
										onMouseEnter={(e) =>
											(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
										}
										onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
										aria-expanded={envExpanded}
										title={envExpanded ? 'Show fewer' : `Show all ${envEntries.length}`}
									>
										{envExpanded ? (
											<>
												<ChevronDown className="w-3 h-3" />
												<span>Show less</span>
											</>
										) : (
											<>
												<ChevronRight className="w-3 h-3" />
												<span>Show {envOverflow} more</span>
											</>
										)}
									</button>
								)}
							</div>
							<div className="flex flex-col gap-1.5">
								{visibleEnvEntries.map(([key, value]) => (
									<div
										key={key}
										className="flex items-baseline gap-2 text-sm font-mono"
										style={{ userSelect: 'text', cursor: 'text' }}
									>
										<code
											className="shrink-0 font-semibold break-all"
											style={{ color: theme.colors.textMain }}
										>
											{key}
										</code>
										<span style={{ color: theme.colors.textDim }}>=</span>
										<code className="break-all" style={{ color: theme.colors.textDim }}>
											{value}
										</code>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Child Processes (terminal only) — full width */}
					{detail.childProcesses && detail.childProcesses.length > 0 && (
						<div
							className="col-span-2 lg:col-span-4 p-4 rounded-lg"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Running in Terminal
								</span>
							</div>
							<div className="flex flex-col gap-1">
								{detail.childProcesses.map((child) => (
									<div key={child.pid} className="flex items-center gap-3 text-sm font-mono">
										<span style={{ color: theme.colors.textDim }}>PID {child.pid}</span>
										<span style={{ color: theme.colors.textMain }}>{child.command}</span>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Detail Footer */}
			<div
				className="px-6 py-3 border-t flex items-center justify-between text-xs"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textDim,
				}}
			>
				<span style={{ opacity: 0.7 }}>Press Esc to go back</span>
				<div className="flex items-center gap-2">
					<div className="w-2 h-2 rounded-full" style={{ backgroundColor: theme.colors.success }} />
					<span>Running</span>
				</div>
			</div>
		</div>
	);
}
