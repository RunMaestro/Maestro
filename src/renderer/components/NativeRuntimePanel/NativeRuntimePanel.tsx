/**
 * NativeRuntimePanel — the "Native" right-panel tab for OMP sessions.
 *
 * Design intent (optimized for the 320–420px right panel):
 * - A concise status header answers "is the runtime alive, on what model?"
 *   at a glance; dormant state is a quiet readiness note, never a fake toolbar.
 * - Runtime stats render as labelled overview tiles plus a context-usage
 *   gauge — never raw `key: value` dumps.
 * - Tasks, subagents, and session activity are structured sections with
 *   real buttons (no underlined text links) and display-only filtering of
 *   protocol payloads (see presentation.ts).
 * - Resume / shell / login live behind an "Advanced" disclosure so the panel
 *   reads as status first, controls second.
 */

import { memo, useCallback, useRef, useState } from 'react';
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleDot,
	Copy,
	GitBranch,
	ListChecks,
	MessageSquare,
	Users,
	X,
	XCircle,
} from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import type {
	AgentRuntimeFeatureState,
	AgentTodoPhase,
} from '../../../shared/agent-runtime-features';
import { controlIdForOmpCommand } from '../../../shared/omp-command-registry';
import type { Theme } from '../../types';
import { safeClipboardWrite } from '../../utils/clipboard';
import {
	currentModelLabel,
	presentSessionActivity,
	presentStats,
	summarizeTodos,
	truncateMiddle,
} from './presentation';

interface NativeRuntimePanelProps {
	features: AgentRuntimeFeatureState;
	theme: Theme;
	sessionId: string;
	/** Test seams; default to the preload bridge. */
	onSetControl?: (
		sessionId: string,
		controlId: string,
		value: string | boolean
	) => Promise<boolean>;
	onBranch?: (sessionId: string, entryId: string) => Promise<boolean>;
	onLoadDetail?: (
		sessionId: string,
		kind: 'subagent' | 'branch',
		entryId: string
	) => Promise<string[]>;
}

interface DetailState {
	title: string;
	lines: string[];
	error: boolean;
}

const TODO_STATE_ICONS: Record<AgentTodoPhase['items'][number]['state'], typeof Circle> = {
	open: Circle,
	in_progress: CircleDot,
	done: CheckCircle2,
	dropped: XCircle,
};

const SUBAGENT_STATUS_LABELS: Record<string, string> = {
	running: 'Running',
	idle: 'Idle',
	complete: 'Complete',
	error: 'Error',
};

function SectionHeading({
	icon: Icon,
	title,
	badge,
	theme,
}: {
	icon: typeof Circle;
	title: string;
	badge?: string;
	theme: Theme;
}) {
	return (
		<h3
			className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider"
			style={{ color: theme.colors.textDim }}
		>
			<Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
			<span>{title}</span>
			{badge && (
				<span
					className="ml-auto rounded-full border px-1.5 py-px text-[9px] font-medium normal-case tracking-normal"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					{badge}
				</span>
			)}
		</h3>
	);
}

/** Compact bordered action button; the panel never uses underlined text links. */
function PanelButton({
	label,
	ariaLabel,
	onClick,
	theme,
	disabled,
	tone = 'default',
	icon: Icon,
}: {
	label: string;
	ariaLabel?: string;
	onClick: () => void;
	theme: Theme;
	disabled?: boolean;
	tone?: 'default' | 'accent';
	icon?: typeof Circle;
}) {
	const color = tone === 'accent' ? theme.colors.accent : theme.colors.textDim;
	return (
		<button
			type="button"
			aria-label={ariaLabel ?? label}
			disabled={disabled}
			onClick={onClick}
			className="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
			style={{
				borderColor: tone === 'accent' ? `${theme.colors.accent}50` : theme.colors.border,
				color,
			}}
		>
			{Icon && <Icon className="h-2.5 w-2.5" aria-hidden="true" />}
			<span>{label}</span>
		</button>
	);
}

export const NativeRuntimePanel = memo(function NativeRuntimePanel({
	features,
	theme,
	sessionId,
	onSetControl = (activeSessionId, controlId, value) =>
		window.maestro.process.setAgentControl(activeSessionId, controlId, value),
	onBranch = (activeSessionId, entryId) =>
		window.maestro.process.branchSession(activeSessionId, entryId),
	onLoadDetail = (activeSessionId, kind, entryId) =>
		window.maestro.process.nativeRuntimeDetail(activeSessionId, kind, entryId),
}: NativeRuntimePanelProps) {
	const [detail, setDetail] = useState<DetailState | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [sessionPath, setSessionPath] = useState('');
	const [shellCommand, setShellCommand] = useState('');
	const [loginProvider, setLoginProvider] = useState('');
	const [copiedLine, setCopiedLine] = useState<string | null>(null);

	const isDormant = features.readiness?.state === 'dormant';
	const model = currentModelLabel(features);
	const stats = presentStats(features.stats);
	const activity = presentSessionActivity(features.tree);
	const todoSummary = summarizeTodos(features.todos);
	const subagents = features.subagents ?? [];

	// Each detail load gets a request id; only the latest request may write
	// state, so an older response can never overwrite a newer one or clear its
	// loading indicator. Closing the card invalidates any in-flight request.
	const detailRequestRef = useRef(0);
	const loadDetail = useCallback(
		async (kind: 'subagent' | 'branch', entryId: string, title: string) => {
			const requestId = ++detailRequestRef.current;
			setDetailLoading(true);
			setDetail({ title, lines: [], error: false });
			try {
				const lines = await onLoadDetail(sessionId, kind, entryId);
				if (detailRequestRef.current !== requestId) return;
				setDetail({ title, lines, error: false });
			} catch {
				if (detailRequestRef.current !== requestId) return;
				setDetail({ title, lines: [], error: true });
			} finally {
				if (detailRequestRef.current === requestId) setDetailLoading(false);
			}
		},
		[onLoadDetail, sessionId]
	);
	const closeDetail = useCallback(() => {
		detailRequestRef.current += 1;
		setDetail(null);
		setDetailLoading(false);
	}, []);

	const copyLine = useCallback(async (line: string) => {
		const copied = await safeClipboardWrite(line);
		if (copied) {
			setCopiedLine(line);
			window.setTimeout(
				() => setCopiedLine((current) => (current === line ? null : current)),
				1500
			);
		}
	}, []);

	const switchSessionControlId = controlIdForOmpCommand('switch_session');
	const bashControlId = controlIdForOmpCommand('bash');
	const loginControlId = controlIdForOmpCommand('login');

	const hasRuntimeData =
		stats.cards.length > 0 ||
		stats.context !== null ||
		stats.rows.length > 0 ||
		todoSummary.total > 0 ||
		subagents.length > 0 ||
		activity.length > 0;

	const inputStyle = {
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	return (
		<div data-testid="native-runtime-panel" className="min-w-0 space-y-4 pt-3">
			{/* Status header */}
			<div data-testid="native-runtime-header" className="min-w-0">
				<div className="flex min-w-0 items-center gap-2">
					<span
						aria-hidden="true"
						className="h-2 w-2 shrink-0 rounded-full"
						style={{
							backgroundColor: isDormant ? theme.colors.textDim : theme.colors.success,
							boxShadow: isDormant ? undefined : `0 0 6px ${theme.colors.success}80`,
						}}
					/>
					<span className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
						OMP Native
					</span>
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						{isDormant ? 'Ready' : 'Live'}
					</span>
					{model && (
						<span
							className="ml-auto min-w-0 truncate rounded-full border px-2 py-0.5 font-mono text-[10px]"
							style={{
								borderColor: `${theme.colors.accent}40`,
								color: theme.colors.accent,
							}}
							title={model}
						>
							{truncateMiddle(model, 28)}
						</span>
					)}
				</div>
				{isDormant && (
					<p
						data-testid="native-runtime-dormant"
						className="mt-1.5 text-[11px] leading-snug"
						style={{ color: theme.colors.textDim }}
					>
						{features.readiness?.message}
					</p>
				)}
			</div>

			{/* Dormant sessions show the readiness note only — no dead controls. */}
			{!isDormant && (
				<>
					{!hasRuntimeData && (
						<p className="text-[11px] leading-snug" style={{ color: theme.colors.textDim }}>
							No runtime details yet — stats, tasks, and session activity appear here as the agent
							works.
						</p>
					)}

					{/* Stats overview */}
					{(stats.cards.length > 0 || stats.context) && (
						<section data-testid="native-runtime-stats" aria-label="Session stats">
							<div className="grid grid-cols-2 gap-1.5">
								{stats.cards.map((card) => (
									<div
										key={card.id}
										className="min-w-0 rounded border px-2 py-1.5"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgActivity,
										}}
									>
										<div
											className="text-[9px] font-medium uppercase tracking-wider"
											style={{ color: theme.colors.textDim }}
										>
											{card.label}
										</div>
										<div
											className="truncate font-mono text-xs font-semibold"
											style={{ color: theme.colors.textMain }}
										>
											{card.value}
										</div>
									</div>
								))}
							</div>
							{stats.context && (
								<div className="mt-1.5">
									<div className="flex items-baseline justify-between text-[10px]">
										<span style={{ color: theme.colors.textDim }}>Context</span>
										<span className="font-mono" style={{ color: theme.colors.textDim }}>
											{stats.context.usedLabel} / {stats.context.windowLabel}
										</span>
									</div>
									<div
										role="progressbar"
										aria-label="Context window usage"
										aria-valuenow={stats.context.percent}
										aria-valuemin={0}
										aria-valuemax={100}
										className="mt-1 h-1 w-full overflow-hidden rounded-full"
										style={{ backgroundColor: `${theme.colors.accent}20` }}
									>
										<div
											className="h-full rounded-full"
											style={{
												width: `${stats.context.percent}%`,
												backgroundColor:
													stats.context.percent >= 85 ? theme.colors.warning : theme.colors.accent,
											}}
										/>
									</div>
								</div>
							)}
							{stats.rows.length > 0 && (
								<dl className="mt-1.5 space-y-0.5">
									{stats.rows.map((row) => (
										<div
											key={row.label}
											className="flex items-baseline justify-between gap-2 text-[10px]"
										>
											<dt style={{ color: theme.colors.textDim }}>{row.label}</dt>
											<dd
												className="min-w-0 truncate text-right font-mono"
												style={{ color: theme.colors.textMain }}
												title={row.value}
											>
												{row.value}
											</dd>
										</div>
									))}
								</dl>
							)}
						</section>
					)}

					{/* Tasks */}
					{todoSummary.total > 0 && (
						<section data-testid="native-runtime-todos" aria-label="Tasks">
							<SectionHeading
								icon={ListChecks}
								title="Tasks"
								badge={`${todoSummary.done}/${todoSummary.total}`}
								theme={theme}
							/>
							<div className="space-y-2">
								{features.todos?.map((phase) => (
									<div key={phase.name} className="min-w-0">
										{(features.todos?.length ?? 0) > 1 && (
											<div
												className="mb-0.5 truncate text-[10px] font-medium"
												style={{ color: theme.colors.textDim }}
												title={phase.name}
											>
												{phase.name}
											</div>
										)}
										<ul className="space-y-1">
											{phase.items.map((item, index) => {
												const Icon = TODO_STATE_ICONS[item.state];
												const isDone = item.state === 'done';
												const isDropped = item.state === 'dropped';
												return (
													<li
														key={`${phase.name}-${index}`}
														className="flex min-w-0 items-start gap-1.5 text-[11px] leading-snug"
													>
														<Icon
															aria-hidden="true"
															className="mt-0.5 h-3 w-3 shrink-0"
															style={{
																color:
																	item.state === 'in_progress'
																		? theme.colors.accent
																		: isDone
																			? theme.colors.success
																			: isDropped
																				? theme.colors.error
																				: theme.colors.textDim,
															}}
														/>
														<span
															className={`min-w-0 break-words ${isDone || isDropped ? 'line-through opacity-60' : ''}`}
															style={{ color: theme.colors.textMain }}
														>
															{item.content}
														</span>
													</li>
												);
											})}
										</ul>
									</div>
								))}
							</div>
						</section>
					)}

					{/* Subagents */}
					{subagents.length > 0 && (
						<section data-testid="native-runtime-subagents" aria-label="Subagents">
							<SectionHeading
								icon={Users}
								title="Subagents"
								badge={String(subagents.length)}
								theme={theme}
							/>
							<ul className="space-y-1">
								{subagents.map((agent) => (
									<li key={agent.id} className="flex min-w-0 items-center gap-1.5">
										{agent.status === 'running' ? (
											<Spinner size={10} color={theme.colors.accent} />
										) : (
											<span
												aria-hidden="true"
												className="h-1.5 w-1.5 shrink-0 rounded-full"
												style={{
													backgroundColor:
														agent.status === 'complete'
															? theme.colors.success
															: agent.status === 'error'
																? theme.colors.error
																: theme.colors.textDim,
												}}
											/>
										)}
										<span
											className="min-w-0 flex-1 truncate text-[11px]"
											style={{ color: theme.colors.textMain }}
											title={agent.label}
										>
											{agent.label}
										</span>
										<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
											{SUBAGENT_STATUS_LABELS[agent.status] ?? agent.status}
										</span>
										<PanelButton
											label="Messages"
											ariaLabel={`View messages for ${agent.label}`}
											icon={MessageSquare}
											theme={theme}
											onClick={() =>
												void loadDetail('subagent', agent.id, `${agent.label} messages`)
											}
										/>
									</li>
								))}
							</ul>
						</section>
					)}

					{/* Session activity + branches */}
					{activity.length > 0 && (
						<section data-testid="native-runtime-activity" aria-label="Session activity">
							<SectionHeading
								icon={GitBranch}
								title="Session activity"
								badge={String(activity.length)}
								theme={theme}
							/>
							<ul className="space-y-1.5">
								{activity.map((entry) => (
									<li
										key={entry.id}
										className="min-w-0 rounded border px-2 py-1.5"
										style={{ borderColor: theme.colors.border }}
									>
										<p
											className="line-clamp-2 break-words text-[11px] leading-snug"
											style={{ color: theme.colors.textMain }}
											title={entry.label}
										>
											{entry.label}
										</p>
										<div className="mt-1 flex items-center gap-1.5">
											<PanelButton
												label="Branch"
												ariaLabel={`Branch from ${entry.label}`}
												icon={GitBranch}
												tone="accent"
												theme={theme}
												onClick={() => void onBranch(sessionId, entry.id)}
											/>
											<PanelButton
												label="Messages"
												ariaLabel={`View branch messages for ${entry.label}`}
												icon={MessageSquare}
												theme={theme}
												onClick={() =>
													void loadDetail('branch', entry.id, `${entry.label} messages`)
												}
											/>
										</div>
									</li>
								))}
							</ul>
						</section>
					)}

					{/* Message detail card */}
					{detail && (
						<section
							data-testid="native-runtime-detail"
							aria-label="Native runtime detail"
							className="rounded border"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgActivity,
							}}
						>
							<div
								className="flex items-center gap-2 border-b px-2 py-1.5"
								style={{ borderColor: theme.colors.border }}
							>
								<h3
									className="min-w-0 flex-1 truncate text-[11px] font-semibold"
									style={{ color: theme.colors.textMain }}
									title={detail.title}
								>
									{detail.title}
								</h3>
								<button
									type="button"
									aria-label="Close detail"
									onClick={closeDetail}
									className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:bg-white/10 hover:opacity-100"
									style={{ color: theme.colors.textDim }}
								>
									<X className="h-3 w-3" />
								</button>
							</div>
							<div className="max-h-48 overflow-y-auto px-2 py-1.5 scrollbar-thin">
								{detailLoading ? (
									<div className="flex items-center gap-2 py-1">
										<Spinner size={12} color={theme.colors.accent} />
										<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
											Loading messages…
										</span>
									</div>
								) : detail.error ? (
									<p className="text-[11px]" style={{ color: theme.colors.error }}>
										Unable to load native runtime detail.
									</p>
								) : detail.lines.length === 0 ? (
									<p className="text-[11px]" style={{ color: theme.colors.textDim }}>
										No messages are available.
									</p>
								) : (
									<ul className="space-y-1">
										{detail.lines.map((line, index) => (
											<li key={index} className="group flex min-w-0 items-start gap-1">
												<span
													className="min-w-0 flex-1 break-words font-mono text-[10px] leading-snug"
													style={{ color: theme.colors.textMain }}
													title={line.length > 64 ? line : undefined}
												>
													{truncateMiddle(line, 160)}
												</span>
												<button
													type="button"
													aria-label={`Copy message ${index + 1}`}
													onClick={() => void copyLine(line)}
													className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-white/10 focus-visible:opacity-100 group-hover:opacity-60"
													style={{
														color:
															copiedLine === line ? theme.colors.success : theme.colors.textDim,
													}}
												>
													<Copy className="h-2.5 w-2.5" />
												</button>
											</li>
										))}
									</ul>
								)}
							</div>
						</section>
					)}

					{/* Advanced: resume / shell / login */}
					<section data-testid="native-runtime-advanced">
						<button
							type="button"
							aria-expanded={advancedOpen}
							onClick={() => setAdvancedOpen((open) => !open)}
							className="flex w-full items-center gap-1.5 rounded py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:bg-white/5"
							style={{ color: theme.colors.textDim }}
						>
							{advancedOpen ? (
								<ChevronDown className="h-3 w-3" aria-hidden="true" />
							) : (
								<ChevronRight className="h-3 w-3" aria-hidden="true" />
							)}
							<span>Advanced</span>
						</button>
						{advancedOpen && (
							<div className="mt-2 space-y-3">
								<div>
									<label
										htmlFor="omp-resume-path"
										className="mb-1 block text-[10px]"
										style={{ color: theme.colors.textDim }}
									>
										Resume from session file
									</label>
									<div className="flex min-w-0 gap-1.5">
										<input
											id="omp-resume-path"
											value={sessionPath}
											onChange={(event) => setSessionPath(event.target.value)}
											placeholder="OMP session file path"
											className="min-w-0 flex-1 rounded border px-2 py-1 text-[11px] outline-none"
											style={inputStyle}
										/>
										<PanelButton
											label="Resume"
											theme={theme}
											tone="accent"
											disabled={!switchSessionControlId || !sessionPath.trim()}
											onClick={() => {
												if (!switchSessionControlId) return;
												void onSetControl(sessionId, switchSessionControlId, sessionPath.trim());
											}}
										/>
									</div>
								</div>
								<div>
									<label
										htmlFor="omp-shell-command"
										className="mb-1 block text-[10px]"
										style={{ color: theme.colors.textDim }}
									>
										Run a shell command through OMP
									</label>
									<div className="flex min-w-0 gap-1.5">
										<input
											id="omp-shell-command"
											value={shellCommand}
											onChange={(event) => setShellCommand(event.target.value)}
											placeholder="Run OMP shell command"
											className="min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11px] outline-none"
											style={inputStyle}
										/>
										<PanelButton
											label="Run"
											theme={theme}
											tone="accent"
											disabled={!bashControlId || !shellCommand.trim()}
											onClick={() => {
												if (!bashControlId) return;
												void onSetControl(sessionId, bashControlId, shellCommand.trim());
											}}
										/>
									</div>
								</div>
								<div>
									<label
										htmlFor="omp-login-provider"
										className="mb-1 block text-[10px]"
										style={{ color: theme.colors.textDim }}
									>
										Login provider
									</label>
									<div className="flex min-w-0 gap-1.5">
										{features.loginProviders?.length ? (
											<select
												id="omp-login-provider"
												aria-label="OMP login provider"
												value={loginProvider}
												onChange={(event) => setLoginProvider(event.target.value)}
												className="min-w-0 flex-1 rounded border px-2 py-1 text-[11px] outline-none"
												style={inputStyle}
											>
												<option value="">Select login provider</option>
												{features.loginProviders.map((provider) => (
													<option key={provider.id} value={provider.id}>
														{provider.label}
													</option>
												))}
											</select>
										) : (
											<input
												id="omp-login-provider"
												aria-label="OMP login provider"
												value={loginProvider}
												onChange={(event) => setLoginProvider(event.target.value)}
												placeholder="OMP login provider"
												className="min-w-0 flex-1 rounded border px-2 py-1 text-[11px] outline-none"
												style={inputStyle}
											/>
										)}
										<PanelButton
											label="Login"
											theme={theme}
											tone="accent"
											disabled={!loginControlId || !loginProvider.trim()}
											onClick={() => {
												if (!loginControlId) return;
												void onSetControl(sessionId, loginControlId, loginProvider.trim());
											}}
										/>
									</div>
								</div>
							</div>
						)}
					</section>
				</>
			)}
		</div>
	);
});
