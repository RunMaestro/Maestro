import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, PlusCircle, RotateCw, Square } from 'lucide-react';
import { OmpEventCanvas } from './OmpEventCanvas';
import type {
	OmpComposerMode,
	OmpThinkingLevel,
	OmpTreeNode,
	OmpWorkspaceAdapter,
	OmpWorkspaceSession,
} from './types';
import { useOmpWorkspace } from './useOmpWorkspace';

const INSPECTOR_TABS = ['session', 'tree', 'subagents', 'approvals', 'usage'] as const;
type InspectorTab = (typeof INSPECTOR_TABS)[number];
const THINKING_LEVELS: readonly OmpThinkingLevel[] = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
];
const DEFAULT_INSPECTOR_WIDTH = 288;
const INSPECTOR_WIDTH_STORAGE_KEY = 'omp.workspace.inspector-width';

function readStoredInspectorWidth(): string | null {
	if (typeof window === 'undefined') return null;
	try {
		return window.localStorage?.getItem(INSPECTOR_WIDTH_STORAGE_KEY) ?? null;
	} catch {
		return null;
	}
}

function persistInspectorWidth(width: number): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage?.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(width));
	} catch {
		// Opaque plugin-panel origins cannot access Web Storage.
	}
}

type WorkspaceTheme = {
	colors: {
		accent: string;
		border: string;
		bgMain: string;
		bgSidebar: string;
		bgActivity: string;
		textMain: string;
		textDim: string;
	};
};

export interface OmpWorkspaceProps {
	adapter: OmpWorkspaceAdapter;
	theme: WorkspaceTheme;
	/** Event id parsed from the workspace deep link, if the navigator supplied one. */
	focusEventId?: string;
}

function loadInspectorWidth(): number {
	const stored = Number(readStoredInspectorWidth());
	return Number.isFinite(stored) && stored >= 220 && stored <= 520
		? stored
		: DEFAULT_INSPECTOR_WIDTH;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'OMP could not complete that action.';
}

/**
 * The mountable OMP renderer surface. It consumes only an injected typed adapter;
 * no component reaches Electron or the runtime bridge directly.
 */
export function OmpWorkspace({ adapter, theme, focusEventId }: OmpWorkspaceProps) {
	const { snapshot, phase, loadError, refresh } = useOmpWorkspace(adapter);
	const [draft, setDraft] = useState('');
	const [attachments, setAttachments] = useState<File[]>([]);
	const [inspectorTab, setInspectorTab] = useState<InspectorTab>('session');
	const [inspectorWidth, setInspectorWidth] = useState(loadInspectorWidth);
	const [actionError, setActionError] = useState<string | null>(null);
	const [inspectorOpen, setInspectorOpen] = useState(false);

	useEffect(() => {
		persistInspectorWidth(inspectorWidth);
	}, [inspectorWidth]);

	const activeSession = useMemo(
		() => snapshot?.sessions.find((session) => session.id === snapshot.activeSessionId) ?? null,
		[snapshot]
	);

	const invoke = useCallback((operation: () => Promise<void>) => {
		setActionError(null);
		void operation().catch((error: unknown) => setActionError(toErrorMessage(error)));
	}, []);

	const handleSubmit = useCallback(() => {
		if (!activeSession || draft.trim().length === 0) return;
		const message = draft.trim();
		invoke(async () => {
			await adapter.sendMessage(activeSession.id, message, attachments);
			setDraft('');
			setAttachments([]);
		});
	}, [activeSession, adapter, attachments, draft, invoke]);

	if (phase === 'loading') return <WorkspaceState label="Connecting to OMP…" theme={theme} />;
	if (phase === 'error' || !snapshot) {
		return (
			<WorkspaceState
				label={loadError ?? 'OMP workspace could not load.'}
				theme={theme}
				retry={refresh}
				error
			/>
		);
	}
	if (snapshot.connection === 'offline') {
		return (
			<WorkspaceState
				label={snapshot.error ?? 'Offline — OMP is unavailable.'}
				theme={theme}
				start={() => invoke(adapter.createSession)}
				retry={() => invoke(adapter.retry)}
			/>
		);
	}
	if (snapshot.connection === 'incompatible') {
		return (
			<WorkspaceState
				label={snapshot.incompatibilityReason ?? 'Installed OMP is incompatible.'}
				theme={theme}
				retry={() => invoke(adapter.retry)}
				error
			/>
		);
	}
	if (snapshot.connection === 'error') {
		return (
			<WorkspaceState
				label={snapshot.error ?? 'OMP connection failed.'}
				theme={theme}
				retry={() => invoke(adapter.retry)}
				error
			/>
		);
	}

	return (
		<section
			className="flex h-full min-h-0 w-full overflow-hidden"
			aria-label="Oh My Pi workspace"
			style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
		>
			<nav
				className="hidden w-64 shrink-0 flex-col border-r md:flex"
				aria-label="OMP sessions"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<div
					className="flex items-center justify-between border-b px-3 py-3"
					style={{ borderColor: theme.colors.border }}
				>
					<span
						className="text-xs font-semibold uppercase tracking-[0.18em]"
						style={{ color: theme.colors.textDim }}
					>
						OMP sessions
					</span>
					<button
						type="button"
						aria-label="New OMP session"
						title="New OMP session"
						className="rounded p-1 hover:bg-white/10"
						onClick={() => invoke(adapter.createSession)}
					>
						<PlusCircle size={17} />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-auto p-2">
					{snapshot.sessions.length === 0 ? (
						<p className="p-3 text-sm" style={{ color: theme.colors.textDim }}>
							No OMP sessions yet.
						</p>
					) : (
						snapshot.sessions.map((session) => (
							<SessionButton
								key={session.id}
								session={session}
								active={session.id === activeSession?.id}
								accent={theme.colors.accent}
								text={theme.colors.textMain}
								dim={theme.colors.textDim}
								onSelect={() => invoke(() => adapter.selectSession(session.id))}
								onRename={() => {
									const name = window.prompt('Rename OMP session', session.title)?.trim();
									if (name) invoke(() => adapter.renameSession(session.id, name));
								}}
							/>
						))
					)}
				</div>
			</nav>

			<div className="flex min-w-0 flex-1 flex-col">
				<MobileWorkspaceControls
					sessions={snapshot.sessions}
					activeSessionId={activeSession?.id ?? null}
					theme={theme}
					inspectorOpen={inspectorOpen}
					hasActiveSession={activeSession !== null}
					onCreate={() => invoke(adapter.createSession)}
					onSelect={(sessionId) => invoke(() => adapter.selectSession(sessionId))}
					onInspector={() => setInspectorOpen((open) => !open)}
				/>
				<WorkspaceToolbar
					session={activeSession}
					models={snapshot.models}
					theme={theme}
					onSetModel={(model) =>
						activeSession && invoke(() => adapter.setModel(activeSession.id, model))
					}
					onSetThinkingLevel={(level) =>
						activeSession && invoke(() => adapter.setThinkingLevel(activeSession.id, level))
					}
					onSetMode={(mode) =>
						activeSession && invoke(() => adapter.setMode(activeSession.id, mode))
					}
					onAbort={() => activeSession && invoke(() => adapter.abort(activeSession.id))}
				/>
				{actionError && (
					<div
						role="alert"
						className="mx-4 mt-3 border px-3 py-2 text-sm"
						style={{ borderColor: '#d86464' }}
					>
						{actionError}
					</div>
				)}
				{activeSession ? (
					<OmpEventCanvas
						events={activeSession.events}
						accent={theme.colors.accent}
						border={theme.colors.border}
						background={theme.colors.bgActivity}
						text={theme.colors.textMain}
						textDim={theme.colors.textDim}
						focusEventId={focusEventId}
						onResolveApproval={(requestId, approved) =>
							invoke(() => adapter.resolveApproval(activeSession.id, requestId, approved))
						}
					/>
				) : (
					<WorkspaceState label="Choose or create an OMP session." theme={theme} />
				)}
				<Composer
					draft={draft}
					attachments={attachments}
					disabled={!activeSession}
					theme={theme}
					onDraftChange={setDraft}
					onAttachmentsChange={setAttachments}
					onSubmit={handleSubmit}
				/>
				{activeSession && inspectorOpen && (
					<MobileInspector
						session={activeSession}
						tab={inspectorTab}
						theme={theme}
						onTab={setInspectorTab}
						onBranch={(entryId) => invoke(() => adapter.branchSession(activeSession.id, entryId))}
					/>
				)}
			</div>

			{activeSession && (
				<Inspector
					session={activeSession}
					tab={inspectorTab}
					width={inspectorWidth}
					theme={theme}
					onTab={setInspectorTab}
					onResize={setInspectorWidth}
					onBranch={(entryId) => invoke(() => adapter.branchSession(activeSession.id, entryId))}
				/>
			)}
		</section>
	);
}

function WorkspaceState({
	label,
	theme,
	retry,
	start,
	error = false,
}: {
	label: string;
	theme: WorkspaceTheme;
	retry?: () => void;
	start?: () => void;
	error?: boolean;
}) {
	return (
		<section
			className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
			role={error ? 'alert' : 'status'}
			style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
		>
			<Activity size={28} style={{ color: error ? '#d86464' : theme.colors.accent }} />
			<p className="max-w-md text-sm">{label}</p>
			{retry && (
				<button
					type="button"
					aria-label="Retry OMP connection"
					onClick={retry}
					className="rounded border px-3 py-2 text-xs font-semibold"
					style={{ borderColor: theme.colors.border }}
				>
					<RotateCw className="mr-1 inline" size={14} /> Retry
				</button>
			)}
			{start && (
				<button
					type="button"
					aria-label="New OMP session"
					onClick={start}
					className="rounded border px-3 py-2 text-xs font-semibold"
					style={{ borderColor: theme.colors.border }}
				>
					New Session
				</button>
			)}
		</section>
	);
}

function SessionButton({
	session,
	active,
	accent,
	text,
	dim,
	onSelect,
	onRename,
}: {
	session: OmpWorkspaceSession;
	active: boolean;
	accent: string;
	text: string;
	dim: string;
	onSelect: () => void;
	onRename: () => void;
}) {
	return (
		<div className="mb-1 flex gap-1">
			<button
				type="button"
				onClick={onSelect}
				aria-current={active ? 'page' : undefined}
				className="min-w-0 flex-1 rounded border-l-2 px-3 py-2 text-left transition-col motion-reduce:transition-none hover:bg-white/5"
				style={{ borderLeftColor: active ? accent : 'transparent', color: text }}
			>
				<span className="block truncate text-sm">{session.title}</span>
				<span
					className="mt-1 flex items-center gap-1 text-[10px] uppercase tracking-wider"
					style={{ color: dim }}
				>
					<span
						className="h-1.5 w-1.5 rounded-full"
						style={{ backgroundColor: session.status === 'streaming' ? accent : dim }}
					/>
					{session.branch ?? session.status}
				</span>
			</button>
			<button
				type="button"
				aria-label={`Rename ${session.title}`}
				onClick={onRename}
				className="rounded px-2 text-xs hover:bg-white/5 focus:outline-none focus:ring-1"
				style={{ color: dim }}
			>
				Rename
			</button>
		</div>
	);
}

function MobileWorkspaceControls({
	sessions,
	activeSessionId,
	theme,
	inspectorOpen,
	hasActiveSession,
	onCreate,
	onSelect,
	onInspector,
}: {
	sessions: OmpWorkspaceSession[];
	activeSessionId: string | null;
	theme: WorkspaceTheme;
	inspectorOpen: boolean;
	hasActiveSession: boolean;
	onCreate: () => void;
	onSelect: (sessionId: string) => void;
	onInspector: () => void;
}) {
	return (
		<div
			className="flex items-center gap-2 border-b px-3 py-2 md:hidden"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			<select
				aria-label="Mobile OMP sessions"
				value={activeSessionId ?? ''}
				onChange={(event) => event.target.value && onSelect(event.target.value)}
				className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs"
				style={{ borderColor: theme.colors.border }}
			>
				<option value="">Choose session</option>
				{sessions.map((session) => (
					<option key={session.id} value={session.id}>
						{session.title}
					</option>
				))}
			</select>
			<button
				type="button"
				aria-label="New OMP session (mobile)"
				onClick={onCreate}
				className="rounded border px-2 py-1 text-xs"
				style={{ borderColor: theme.colors.border }}
			>
				New
			</button>
			{hasActiveSession && (
				<button
					type="button"
					aria-label="Open OMP inspector"
					aria-expanded={inspectorOpen}
					onClick={onInspector}
					className="rounded border px-2 py-1 text-xs"
					style={{ borderColor: theme.colors.border }}
				>
					Inspector
				</button>
			)}
		</div>
	);
}

function WorkspaceToolbar({
	session,
	models,
	theme,
	onSetModel,
	onSetThinkingLevel,
	onSetMode,
	onAbort,
}: {
	session: OmpWorkspaceSession | null;
	models: string[];
	theme: WorkspaceTheme;
	onSetModel: (model: string) => void;
	onSetThinkingLevel: (level: OmpThinkingLevel) => void;
	onSetMode: (mode: OmpComposerMode) => void;
	onAbort: () => void;
}) {
	return (
		<header
			className="flex min-h-14 items-center gap-2 border-b px-3"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			<div className="min-w-0 flex-1">
				<h1 className="truncate text-sm font-semibold">{session?.title ?? 'OMP workspace'}</h1>
				<p
					className="text-[10px] uppercase tracking-widest"
					style={{ color: theme.colors.textDim }}
				>
					{session?.branch ?? 'No active branch'}
				</p>
			</div>
			{session && (
				<>
					<label className="sr-only" htmlFor="omp-model">
						Model
					</label>
					<select
						id="omp-model"
						aria-label="Model"
						value={session.model}
						onChange={(event) => onSetModel(event.target.value)}
						className="max-w-48 rounded border bg-transparent px-2 py-1 text-xs"
						style={{ borderColor: theme.colors.border }}
					>
						{models.map((model) => (
							<option key={model} value={model}>
								{model}
							</option>
						))}
					</select>
					<select
						aria-label="Thinking level"
						value={session.thinkingLevel ?? 'off'}
						onChange={(event) => onSetThinkingLevel(event.target.value as OmpThinkingLevel)}
						className="max-w-24 rounded border bg-transparent px-2 py-1 text-xs"
						style={{ borderColor: theme.colors.border }}
					>
						{THINKING_LEVELS.map((level) => (
							<option key={level} value={level}>
								{level[0].toUpperCase()}
								{level.slice(1)}
							</option>
						))}
					</select>
					<div
						className="hidden rounded border p-0.5 sm:flex"
						style={{ borderColor: theme.colors.border }}
					>
						{(['build', 'plan', 'ask'] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								aria-label={`${mode[0].toUpperCase()}${mode.slice(1)} mode`}
								aria-pressed={session.mode === mode}
								className="rounded px-2 py-1 text-xs capitalize"
								style={
									session.mode === mode
										? { backgroundColor: theme.colors.accent, color: theme.colors.bgMain }
										: undefined
								}
								onClick={() => onSetMode(mode)}
							>
								{mode}
							</button>
						))}
					</div>
					{session.status === 'streaming' && (
						<button
							type="button"
							aria-label="Abort stream"
							className="rounded border px-2 py-1 text-xs"
							style={{ borderColor: theme.colors.border }}
							onClick={onAbort}
						>
							<Square className="mr-1 inline" size={11} /> Abort
						</button>
					)}
				</>
			)}
		</header>
	);
}

function Composer({
	draft,
	attachments,
	disabled,
	theme,
	onDraftChange,
	onAttachmentsChange,
	onSubmit,
}: {
	draft: string;
	attachments: File[];
	disabled: boolean;
	theme: WorkspaceTheme;
	onDraftChange: (value: string) => void;
	onAttachmentsChange: (files: File[]) => void;
	onSubmit: () => void;
}) {
	return (
		<form
			className="border-t p-3"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<div className="flex items-end gap-2">
				<label
					htmlFor="omp-attachments"
					className="cursor-pointer rounded border px-2 py-1.5 text-xs"
					style={{ borderColor: theme.colors.border }}
				>
					Attach images
				</label>
				<input
					id="omp-attachments"
					aria-label="Attach images"
					type="file"
					accept="image/png,image/jpeg,image/webp,image/gif"
					multiple
					className="sr-only"
					onChange={(event) => onAttachmentsChange(Array.from(event.target.files ?? []))}
				/>
				<textarea
					aria-label="OMP message"
					value={draft}
					disabled={disabled}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							onSubmit();
						}
					}}
					rows={2}
					className="min-h-12 flex-1 resize-none rounded border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1"
					style={{ borderColor: theme.colors.border }}
					placeholder={disabled ? 'Select a session to compose.' : 'Describe the next operation…'}
				/>
				<button
					type="submit"
					aria-label="Send message"
					disabled={disabled || draft.trim().length === 0}
					className="rounded px-3 py-2 text-xs font-semibold disabled:opacity-40"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					Send
				</button>
			</div>
			{attachments.length > 0 && (
				<ul className="mt-2 flex flex-wrap gap-2" aria-label="Attached files">
					{attachments.map((file) => (
						<li
							key={`${file.name}-${file.size}`}
							className="rounded border px-2 py-1 text-xs"
							style={{ borderColor: theme.colors.border }}
						>
							{file.name}
							<button
								type="button"
								aria-label={`Remove ${file.name}`}
								className="ml-2"
								onClick={() =>
									onAttachmentsChange(attachments.filter((candidate) => candidate !== file))
								}
							>
								×
							</button>
						</li>
					))}
				</ul>
			)}
		</form>
	);
}

function Inspector({
	session,
	tab,
	width,
	theme,
	onTab,
	onResize,
	onBranch,
}: {
	session: OmpWorkspaceSession;
	tab: InspectorTab;
	width: number;
	theme: WorkspaceTheme;
	onTab: (tab: InspectorTab) => void;
	onResize: (width: number) => void;
	onBranch: (entryId: string) => void;
}) {
	return (
		<aside
			className="relative hidden shrink-0 border-l lg:flex lg:flex-col"
			aria-label="OMP inspector"
			style={{ width, borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize OMP inspector"
				aria-valuemin={220}
				aria-valuemax={520}
				aria-valuenow={width}
				aria-valuetext={`${width} pixels`}
				tabIndex={0}
				className="absolute inset-y-0 left-0 w-1 cursor-col-resize motion-reduce:transition-none hover:bg-white/20 focus:bg-white/20 focus:outline-none"
				onKeyDown={(event) => {
					if (event.key === 'ArrowLeft') onResize(Math.min(520, width + 20));
					else if (event.key === 'ArrowRight') onResize(Math.max(220, width - 20));
					else if (event.key === 'Home') onResize(220);
					else if (event.key === 'End') onResize(520);
					else return;
					event.preventDefault();
				}}
				onPointerDown={(event) => {
					const startX = event.clientX;
					const startWidth = width;
					const resize = (move: PointerEvent) =>
						onResize(Math.max(220, Math.min(520, startWidth + startX - move.clientX)));
					const stop = () => {
						document.removeEventListener('pointermove', resize);
						document.removeEventListener('pointerup', stop);
					};
					document.addEventListener('pointermove', resize);
					document.addEventListener('pointerup', stop, { once: true });
				}}
			/>
			<div className="flex overflow-auto border-b p-1" style={{ borderColor: theme.colors.border }}>
				{INSPECTOR_TABS.map((name) => (
					<button
						key={name}
						type="button"
						aria-pressed={tab === name}
						onClick={() => onTab(name)}
						className="rounded px-2 py-1 text-[10px] uppercase"
						style={
							tab === name
								? { backgroundColor: theme.colors.accent, color: theme.colors.bgMain }
								: { color: theme.colors.textDim }
						}
					>
						{name}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-3">
				<InspectorContent
					session={session}
					tab={tab}
					textDim={theme.colors.textDim}
					onBranch={onBranch}
				/>
			</div>
		</aside>
	);
}

function MobileInspector({
	session,
	tab,
	theme,
	onTab,
	onBranch,
}: {
	session: OmpWorkspaceSession;
	tab: InspectorTab;
	theme: WorkspaceTheme;
	onTab: (tab: InspectorTab) => void;
	onBranch: (entryId: string) => void;
}) {
	return (
		<aside
			aria-label="OMP inspector drawer"
			className="border-t p-3 lg:hidden"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			<div className="flex overflow-auto border-b p-1" style={{ borderColor: theme.colors.border }}>
				{INSPECTOR_TABS.map((name) => (
					<button
						key={name}
						type="button"
						aria-pressed={tab === name}
						onClick={() => onTab(name)}
						className="rounded px-2 py-1 text-[10px] uppercase"
						style={
							tab === name
								? { backgroundColor: theme.colors.accent, color: theme.colors.bgMain }
								: { color: theme.colors.textDim }
						}
					>
						{name}
					</button>
				))}
			</div>
			<div className="pt-3">
				<InspectorContent
					session={session}
					tab={tab}
					textDim={theme.colors.textDim}
					onBranch={onBranch}
				/>
			</div>
		</aside>
	);
}

function InspectorContent({
	session,
	tab,
	textDim,
	onBranch,
}: {
	session: OmpWorkspaceSession;
	tab: InspectorTab;
	textDim: string;
	onBranch: (entryId: string) => void;
}) {
	if (tab === 'session')
		return (
			<dl className="space-y-3 text-sm">
				<div>
					<dt style={{ color: textDim }}>Model</dt>
					<dd>{session.model}</dd>
				</div>
				<div>
					<dt style={{ color: textDim }}>Mode</dt>
					<dd className="capitalize">{session.mode}</dd>
				</div>
				<div>
					<dt style={{ color: textDim }}>Thinking</dt>
					<dd className="capitalize">{session.thinkingLevel ?? 'off'}</dd>
				</div>
				<div>
					<dt style={{ color: textDim }}>Queue</dt>
					<dd>
						{session.queuedMessageCount ?? 0} queued{' '}
						{(session.queuedMessageCount ?? 0) === 1 ? 'message' : 'messages'}
					</dd>
				</div>
				<div>
					<dt style={{ color: textDim }}>Status</dt>
					<dd className="capitalize">{session.status}</dd>
				</div>
				{session.todoPhases && session.todoPhases.length > 0 && (
					<div>
						<dt style={{ color: textDim }}>Todo phases</dt>
						<dd>
							<ul className="mt-1 space-y-1">
								{session.todoPhases.map((phase, index) => (
									<li key={phase.id ?? `${phase.label ?? 'phase'}-${index}`}>
										<span>{phase.label ?? 'Untitled phase'}</span>
										{phase.status && <span style={{ color: textDim }}> · {phase.status}</span>}
									</li>
								))}
							</ul>
						</dd>
					</div>
				)}
			</dl>
		);
	if (tab === 'tree')
		return (
			<ul className="space-y-1 text-sm" aria-label="OMP conversation tree">
				{session.tree.length === 0 ? (
					<li style={{ color: textDim }}>No messages available.</li>
				) : (
					session.tree.map((node) => <TreeItem key={node.id} node={node} onBranch={onBranch} />)
				)}
			</ul>
		);
	if (tab === 'subagents')
		return (
			<ul className="space-y-2 text-sm">
				{session.subagents.length === 0 ? (
					<li style={{ color: textDim }}>No subagents.</li>
				) : (
					session.subagents.map((subagent) => (
						<li key={subagent.id}>
							{subagent.label}
							<span className="ml-2 text-xs" style={{ color: textDim }}>
								{subagent.status}
							</span>
						</li>
					))
				)}
			</ul>
		);
	if (tab === 'approvals')
		return (
			<ul className="space-y-2 text-sm">
				{session.events
					.filter((event) => event.kind === 'approval')
					.map((event) => event.kind === 'approval' && <li key={event.id}>{event.description}</li>)}
			</ul>
		);
	return (
		<dl className="space-y-3 text-sm">
			<div>
				<dt style={{ color: textDim }}>Input</dt>
				<dd>{session.usage.inputTokens.toLocaleString()} tokens</dd>
			</div>
			<div>
				<dt style={{ color: textDim }}>Output</dt>
				<dd>{session.usage.outputTokens.toLocaleString()} tokens</dd>
			</div>
			{session.usage.costUsd !== undefined && (
				<div>
					<dt style={{ color: textDim }}>Cost</dt>
					<dd>${session.usage.costUsd.toFixed(2)}</dd>
				</div>
			)}
		</dl>
	);
}

function TreeItem({ node, onBranch }: { node: OmpTreeNode; onBranch: (entryId: string) => void }) {
	return (
		<li>
			<button
				type="button"
				onClick={() => onBranch(node.id)}
				aria-label={`Branch from ${node.label}`}
				className="rounded px-1 text-left hover:bg-white/5 focus:outline-none focus:ring-1"
			>
				{node.label}
			</button>
			{node.children && node.children.length > 0 && (
				<ul className="ml-3 mt-1 border-l pl-2" style={{ borderColor: 'currentColor' }}>
					{node.children.map((child) => (
						<TreeItem key={child.id} node={child} onBranch={onBranch} />
					))}
				</ul>
			)}
		</li>
	);
}
