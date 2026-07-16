import { memo, useEffect, useState } from 'react';
import type {
	AgentRuntimeFeatureState,
	AgentTreeNode,
} from '../../../shared/agent-runtime-features';
import type { Theme } from '../../types';

export type { AgentRuntimeFeatureState } from '../../../shared/agent-runtime-features';

interface SessionInspectorProps {
	sessionId: string;
	runtimeFeatures: AgentRuntimeFeatureState | null | undefined;
	theme: Theme;
	onBranchSession?: (sessionId: string, entryId: string) => void | Promise<boolean>;
	onClose?: () => void;
}

interface ConversationTreeProps {
	nodes: AgentTreeNode[];
	selectedId: string | null;
	onSelect: (entryId: string) => void;
	onBranch: (entryId: string, label: string) => void;
	depth?: number;
	theme: Theme;
}

function ConversationTree({
	nodes,
	selectedId,
	onSelect,
	onBranch,
	depth = 0,
	theme,
}: ConversationTreeProps) {
	return (
		<ul
			className={depth === 0 ? 'space-y-1' : 'ml-3 mt-1 space-y-1 border-l pl-2'}
			style={{ borderColor: theme.colors.border }}
		>
			{nodes.map((node) => (
				<li key={node.id}>
					<div className="flex min-w-0 items-center gap-1">
						<button
							type="button"
							aria-pressed={selectedId === node.id}
							onClick={() => onSelect(node.id)}
							className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-white/10"
							style={{
								color: selectedId === node.id ? theme.colors.accent : theme.colors.textMain,
							}}
						>
							{node.label}
						</button>
						<button
							type="button"
							onClick={() => onBranch(node.id, node.label)}
							className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-white/10"
							style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							aria-label={`Branch from ${node.label}`}
						>
							Branch
						</button>
					</div>
					{node.children?.length ? (
						<ConversationTree
							nodes={node.children}
							selectedId={selectedId}
							onSelect={onSelect}
							onBranch={onBranch}
							depth={depth + 1}
							theme={theme}
						/>
					) : null}
				</li>
			))}
		</ul>
	);
}

export const SessionInspector = memo(function SessionInspector({
	sessionId,
	runtimeFeatures,
	theme,
	onBranchSession = (activeSessionId, entryId) =>
		window.maestro.process.branchSession(activeSessionId, entryId),
	onClose,
}: SessionInspectorProps) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [sessionName, setSessionName] = useState('');
	const [sessionPath, setSessionPath] = useState('');

	useEffect(() => {
		if (!onClose) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [onClose]);

	if (!runtimeFeatures) {
		return null;
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Session details"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose?.();
			}}
		>
			<aside
				role="region"
				aria-label="Session inspector"
				className="max-h-[min(42rem,calc(100vh-2rem))] w-full max-w-xl overflow-y-auto rounded-lg border p-4 text-xs shadow-lg"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			>
				<div className="mb-4 flex items-center justify-between gap-4">
					<h2 className="text-sm font-semibold">Session details</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close session details"
						className="rounded px-2 py-1"
						style={{ color: theme.colors.textDim }}
					>
						Close
					</button>
				</div>
				<form
					className="mb-4 flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!sessionName.trim()) return;
						void window.maestro.process.setAgentControl(sessionId, 'session-name', sessionName);
					}}
				>
					<label className="sr-only" htmlFor={`omp-session-name-${sessionId}`}>
						Session name
					</label>
					<input
						id={`omp-session-name-${sessionId}`}
						value={sessionName}
						onChange={(event) => setSessionName(event.target.value)}
						placeholder="Rename OMP session"
						className="min-w-0 flex-1 rounded border px-2 py-1"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
					<button
						type="submit"
						className="rounded border px-2 py-1"
						style={{ borderColor: theme.colors.border }}
					>
						Rename
					</button>
				</form>
				<form
					className="mb-4 flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!sessionPath.trim()) return;
						void window.maestro.process.setAgentControl(sessionId, 'switch-session', sessionPath);
					}}
				>
					<label className="sr-only" htmlFor={`omp-session-path-${sessionId}`}>
						OMP session file
					</label>
					<input
						id={`omp-session-path-${sessionId}`}
						value={sessionPath}
						onChange={(event) => setSessionPath(event.target.value)}
						placeholder="Resume OMP session file"
						className="min-w-0 flex-1 rounded border px-2 py-1"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
					<button
						type="submit"
						className="rounded border px-2 py-1"
						style={{ borderColor: theme.colors.border }}
					>
						Resume
					</button>
				</form>
				{runtimeFeatures.tree?.length ? (
					<section className="mb-4">
						<h2 className="mb-1 text-xs font-semibold">Conversation tree</h2>
						<ConversationTree
							nodes={runtimeFeatures.tree}
							selectedId={selectedId}
							onSelect={setSelectedId}
							onBranch={(entryId) => void onBranchSession(sessionId, entryId)}
							theme={theme}
						/>
					</section>
				) : null}
				<section className="mb-4">
					<h2 className="mb-1 text-xs font-semibold">Todos</h2>
					{runtimeFeatures.todos?.length ? (
						runtimeFeatures.todos.map((phase) => (
							<div key={phase.name} className="mb-2">
								<h3 className="text-[11px] font-medium" style={{ color: theme.colors.textDim }}>
									{phase.name}
								</h3>
								<ul className="space-y-1">
									{phase.items.map((item) => (
										<li key={`${phase.name}-${item.content}`} className="flex gap-1.5">
											<span className="min-w-0 flex-1">{item.content}</span>
											<span
												className="whitespace-nowrap text-[10px]"
												style={{ color: theme.colors.textDim }}
											>
												{item.state.replace('_', ' ')}
											</span>
										</li>
									))}
								</ul>
							</div>
						))
					) : (
						<p style={{ color: theme.colors.textDim }}>No todos</p>
					)}
				</section>
				<section className="mb-4">
					<h2 className="mb-1 text-xs font-semibold">Subagents</h2>
					{runtimeFeatures.subagents?.length ? (
						<ul className="space-y-1.5">
							{runtimeFeatures.subagents.map((subagent) => (
								<li
									key={subagent.id}
									className="rounded border p-1.5"
									style={{ borderColor: theme.colors.border }}
								>
									<div className="flex items-center justify-between gap-2">
										<span className="truncate">{subagent.label}</span>
										<span
											className="rounded-full px-1.5 py-0.5 text-[10px]"
											style={{
												backgroundColor: `${theme.colors.accent}18`,
												color: theme.colors.accent,
											}}
										>
											{subagent.status}
										</span>
									</div>
									{subagent.detail ? (
										<p className="mt-1 text-[10px]" style={{ color: theme.colors.textDim }}>
											{subagent.detail}
										</p>
									) : null}
								</li>
							))}
						</ul>
					) : (
						<p style={{ color: theme.colors.textDim }}>No subagents</p>
					)}
				</section>
				{runtimeFeatures.stats && Object.keys(runtimeFeatures.stats).length ? (
					<section>
						<h2 className="mb-1 text-xs font-semibold">Session stats</h2>
						<dl className="grid grid-cols-2 gap-1.5">
							{Object.entries(runtimeFeatures.stats).map(([name, value]) => (
								<div
									key={name}
									className="rounded border p-1.5"
									style={{ borderColor: theme.colors.border }}
								>
									<dt className="truncate text-[10px]" style={{ color: theme.colors.textDim }}>
										{name}
									</dt>
									<dd className="font-medium">
										{typeof value === 'number' ? value.toLocaleString() : value}
									</dd>
								</div>
							))}
						</dl>
					</section>
				) : null}
			</aside>
		</div>
	);
});
