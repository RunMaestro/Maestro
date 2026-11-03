import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../../types';
import type {
	ContextualMemory,
	MemoryConfig,
	MemoryPacket,
	MemoryRecallIntent,
	MemoryRequest,
	MemorySource,
	MemoryState,
} from '../../../shared/pianola/memory';
import { Pager } from '../ui/Pager';
import { usePagination } from '../../hooks/ui/usePagination';
import { FilterInput } from '../ui/FilterInput';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { MemorySetup } from './MemorySetup';

/** Coordinate configuration, learning progress, recall, and bank mutation workflows. */
export function MemoryView({ theme }: { theme: Theme }) {
	const [state, setState] = useState<MemoryState | null>(null);
	const [draft, setDraft] = useState<MemoryConfig | null>(null);
	const [sources, setSources] = useState<MemorySource[]>([]);
	const [memories, setMemories] = useState<ContextualMemory[]>([]);
	const [selected, setSelected] = useState<ContextualMemory | null>(null);
	const [query, setQuery] = useState('');
	const [project, setProject] = useState('');
	const [text, setText] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirmForget, setConfirmForget] = useState(false);
	const [history, setHistory] = useState(false);
	const [recallMode, setRecallMode] = useState<MemoryRecallIntent['mode'] | 'infer'>('current');
	const [qualify, setQualify] = useState(false);
	const [rerank, setRerank] = useState(false);
	const [assessment, setAssessment] = useState<MemoryPacket['assessment'] | null>(null);
	const [recallAt, setRecallAt] = useState('');
	const [section, setSection] = useState<'setup' | 'knowledge' | 'coverage'>('setup');
	const sourcePager = usePagination(sources, 50);
	const request = useCallback(
		async <T,>(payload: MemoryRequest): Promise<T> =>
			window.maestro.pianola.memory(payload) as Promise<T>,
		[]
	);
	const visibility = useRef('');
	const refresh = useCallback(async () => {
		const [next, inventory] = await Promise.all([
			request<MemoryState>({ action: 'status' }),
			request<MemorySource[]>({ action: 'sources' }),
		]);
		const key = JSON.stringify([
			next.config.enabled,
			next.config.userId,
			next.config.roots,
			next.config.exclusions,
		]);
		if (key !== visibility.current) {
			setMemories([]);
			setSelected(null);
			setText('');
			visibility.current = key;
		}
		setState(next);
		setSources(inventory);
		setDraft((old) => old ?? next.config);
	}, [request]);
	useEffect(() => {
		let live = true;
		const load = () =>
			refresh().catch((e) => {
				if (live) setError(ipcErrorMessage(e));
			});
		void load();
		const timer = setInterval(() => {
			void load();
		}, 3000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [refresh]);
	const run = async (operation: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await operation();
			await refresh();
		} catch (e) {
			setError(ipcErrorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	const search = async () => {
		if (query.trim()) {
			const packet = await request<MemoryPacket>({
				action: 'recall',
				query: {
					query,
					projectPath: project || undefined,
					limit: 30,
					qualify,
					rerank,
					intent:
						recallMode === 'infer'
							? undefined
							: recallMode === 'as-of'
								? { mode: 'as-of', at: recallAt }
								: { mode: recallMode },
				},
			});
			setAssessment(packet.assessment);
			setMemories(packet.memories);
		} else {
			setAssessment(null);
			setMemories(
				await request<ContextualMemory[]>({
					action: 'list',
					projectPath: project || undefined,
					includeHistory: history,
				})
			);
		}
	};
	const style: CSSProperties = {
		color: theme.colors.textMain,
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
	};
	const button = 'px-3 py-1.5 rounded border text-xs font-medium disabled:opacity-50';
	const input = 'w-full rounded border px-2 py-1.5 text-sm';
	if (!draft || !state)
		return (
			<div className="p-5 text-sm" style={{ color: theme.colors.textMain }}>
				{error ?? 'Loading memory configuration…'}
			</div>
		);
	return (
		<div
			className="p-4 space-y-4 text-sm"
			style={{ color: theme.colors.textMain }}
			data-testid="pianola-memory"
		>
			<div className="flex flex-wrap gap-2">
				{(['setup', 'knowledge', 'coverage'] as const).map((s) => (
					<button
						key={s}
						className={button}
						style={{
							...style,
							borderColor: section === s ? theme.colors.accent : theme.colors.border,
						}}
						onClick={() => {
							setSection(s);
							if (s === 'knowledge') void run(search);
						}}
					>
						{s === 'setup' ? 'Setup' : s === 'knowledge' ? 'Memory bank' : 'Activity'}
					</button>
				))}
			</div>
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				Memory provides advisory context, never permission. Forgetting does not delete original
				transcripts or external backups.
			</p>
			{error && (
				<div
					role="alert"
					className="p-3 rounded border"
					style={{ borderColor: theme.colors.error, color: theme.colors.error }}
				>
					{error}
				</div>
			)}
			{section === 'setup' && (
				<MemorySetup
					theme={theme}
					config={draft}
					progress={state.progress}
					cliProviders={state.cliProviders}
					apiCredentials={state.apiCredentials}
					busy={busy}
					onChange={setDraft}
					onSave={() =>
						void run(async () => {
							const next = await request<MemoryState>({ action: 'configure', config: draft });
							setDraft(next.config);
						})
					}
					onStart={() =>
						void run(async () => {
							setMemories([]);
							setSelected(null);
							setText('');
							const next = await request<MemoryState>({ action: 'configure', config: draft });
							setDraft(next.config);
							await request({ action: 'discover' });
							await request({ action: 'start' });
							setSection('coverage');
						})
					}
					onPause={() =>
						void run(async () => {
							await request({ action: 'pause' });
						})
					}
				/>
			)}
			{section === 'coverage' && (
				<div className="space-y-3">
					<p>
						{state.progress.phase}
						{state.progress.paused ? ' (paused)' : ''}
					</p>
					<dl className="grid grid-cols-2 gap-2">
						<dt>Sources</dt>
						<dd>{state.progress.sources}</dd>
						<dt>Complete / pending</dt>
						<dd>
							{state.progress.completed} / {state.progress.pending}
						</dd>
						<dt>Failed / excluded</dt>
						<dd>
							{state.progress.failed} / {state.progress.excluded}
						</dd>
						<dt>Memories</dt>
						<dd>{state.progress.memories}</dd>
						<dt>Input / output tokens</dt>
						<dd>
							{state.progress.inputTokens} / {state.progress.outputTokens}
						</dd>
						<dt>Reserved tokens</dt>
						<dd>{state.progress.reservedTokens}</dd>
						<dt>Settled cost</dt>
						<dd>${state.progress.dollars.toFixed(4)}</dd>
					</dl>
					{(state.progress.error || state.progress.failed > 0) && (
						<div className="space-y-2">
							<p role="alert" style={{ color: theme.colors.error }}>
								{state.progress.error ||
									'Some sources failed processing. Inspect their errors below before retrying.'}
							</p>
							<button
								className={button}
								style={style}
								disabled={busy}
								onClick={() =>
									void run(async () => {
										await request({ action: 'retry' });
									})
								}
							>
								Retry failed or interrupted work (may incur another charge)
							</button>
						</div>
					)}
					<p className="text-xs break-all" style={{ color: theme.colors.textDim }}>
						Embedding space: {state.progress.embeddingSpace}
					</p>
					{sourcePager.isPaginated && (
						<div className="flex items-center justify-between">
							<span>
								{sourcePager.range.from}–{sourcePager.range.to} of {sourcePager.totalItems} sources
							</span>
							<Pager
								theme={theme}
								page={sourcePager.page}
								totalPages={sourcePager.totalPages}
								onPrev={sourcePager.prevPage}
								onNext={sourcePager.nextPage}
								canGoPrev={sourcePager.canGoPrev}
								canGoNext={sourcePager.canGoNext}
								ariaLabel="Historical source pages"
							/>
						</div>
					)}
					{sourcePager.pageItems.map((source) => (
						<div
							key={source.id}
							className="p-2 border rounded text-xs space-y-1"
							style={{ borderColor: theme.colors.border }}
						>
							<p>
								{source.provider} · {source.state} · {source.authorship}
							</p>
							<p className="break-all">{source.projectPath}</p>
							<p className="font-mono break-all">{source.filePath}</p>
							<p>
								Cursor {source.cursor} / {source.size} bytes (OpenCode: normalized message cursor)
							</p>
							{source.error && <p style={{ color: theme.colors.error }}>{source.error}</p>}
						</div>
					))}
				</div>
			)}
			{section === 'knowledge' && (
				<div className="space-y-3">
					<div className="flex flex-wrap gap-2">
						<FilterInput
							value={query}
							onChange={setQuery}
							placeholder="Recall a preference, fact, or decision…"
							theme={theme}
						/>
						<button
							className={button}
							style={style}
							disabled={busy}
							onClick={() => void run(search)}
						>
							Search
						</button>
					</div>
					<label>
						Project scope
						<select
							className={input}
							style={style}
							value={project}
							onChange={(e) => setProject(e.target.value)}
						>
							<option value="">Global preferences (list shows all my projects)</option>
							{[...new Set(sources.map((s) => s.projectPath))].map((p) => (
								<option key={p}>{p}</option>
							))}
						</select>
					</label>
					{query.trim() ? (
						<div className="space-y-2">
							<label className="flex gap-2">
								<input
									type="checkbox"
									checked={qualify}
									onChange={(e) => {
										setQualify(e.target.checked);
										if (!e.target.checked && recallMode === 'infer') setRecallMode('current');
									}}
								/>
								{state.config.qualification?.provider === 'hosted'
									? 'Optional hosted model review (sends question and candidate assertions)'
									: 'Optional model review (slow, unqualified)'}
							</label>
							<label className="flex gap-2">
								<input
									type="checkbox"
									checked={rerank}
									onChange={(e) => setRerank(e.target.checked)}
								/>
								Hosted rerank (sends question and shortlisted assertions)
							</label>
							<label>
								Recall lifecycle
								<select
									aria-label="Recall lifecycle"
									className={input}
									style={style}
									value={recallMode}
									onChange={(e) => setRecallMode(e.target.value as typeof recallMode)}
								>
									<option value="infer" disabled={!qualify}>
										Infer from question (model review only)
									</option>
									<option value="current">Current approved facts</option>
									<option value="as-of">Approved facts as of…</option>
									<option value="previous">Previous approved facts</option>
									<option value="proposed">Active proposals only</option>
									<option value="contested">Active contested facts only</option>
									<option value="history">Past/current history, all statuses</option>
								</select>
							</label>
							{recallMode === 'as-of' && (
								<input
									aria-label="Recall as-of instant"
									className={input}
									style={style}
									value={recallAt}
									onChange={(e) => setRecallAt(e.target.value)}
									placeholder="ISO date or timestamp"
								/>
							)}
						</div>
					) : (
						<label className="flex gap-2">
							<input
								type="checkbox"
								checked={history}
								onChange={(e) => setHistory(e.target.checked)}
							/>
							Browse list history (all statuses/dates)
						</label>
					)}
					<p role="status" className="text-sm">
						{assessment?.mode === 'model-reviewed'
							? `Unqualified model review: ${assessment.answerability}. Fallible selection, not verified answers or permission.`
							: 'Advisory evidence only. Answerability has not been assessed; candidates are not verified answers or permission.'}
					</p>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-2">
							{memories.map((memory) => (
								<button
									key={memory.id}
									className="w-full text-left border rounded p-3 space-y-1"
									style={{
										...style,
										borderColor:
											selected?.id === memory.id ? theme.colors.accent : theme.colors.border,
									}}
									onClick={() => {
										setSelected(memory);
										setText(memory.text);
										setConfirmForget(false);
									}}
								>
									<span className="block text-xs" style={{ color: theme.colors.textDim }}>
										{memory.kind} · {memory.support} · {memory.status}
										{memory.pinned ? ' · pinned' : ''}
									</span>
									<span className="block">{memory.text}</span>
								</button>
							))}
							{!memories.length && (
								<p className="text-xs" style={{ color: theme.colors.textDim }}>
									No memories in this view. Discover and process history, or explicitly remember
									something.
								</p>
							)}
						</div>
						<div className="space-y-3">
							{selected && (
								<>
									<h3 className="font-semibold">Evidence & decision history</h3>
									<p>{selected.rationale}</p>
									{selected.alternatives.length > 0 && (
										<p>Rejected / considered: {selected.alternatives.join('; ')}</p>
									)}
									<p className="text-xs">
										Valid {selected.validFrom ?? 'unknown'} → {selected.validTo ?? 'current'} ·{' '}
										{selected.support} · {selected.status}
									</p>
									{selected.related.length > 0 && <p>Conflicts: {selected.related.join(', ')}</p>}
									{selected.supersedes && <p>Supersedes {selected.supersedes}</p>}
									{selected.evidence.map((e) => {
										const source = sources.find((s) => s.id === e.sourceId);
										return (
											<div
												key={e.id}
												className="border rounded p-2 space-y-1"
												style={{ borderColor: theme.colors.border }}
											>
												<p className="text-xs">
													{e.role} · {e.attribution} · {e.timestamp ?? 'date unknown'}
												</p>
												<pre className="whitespace-pre-wrap break-words text-xs select-text">
													{e.text}
												</pre>
												<p className="text-xs font-mono break-all">
													{e.sourceId} / {e.messageId}
												</p>
												{source && (
													<button
														className={button}
														style={style}
														onClick={() =>
															void window.maestro.shell.showItemInFolder(source.filePath)
														}
													>
														Reveal original transcript
													</button>
												)}
											</div>
										);
									})}
								</>
							)}
							<label className="block">
								{selected
									? 'Correction (preserves earlier decision history)'
									: 'Explicitly remember'}
								<textarea
									className={input}
									style={style}
									rows={5}
									value={text}
									onChange={(e) => setText(e.target.value)}
								/>
							</label>
							<div className="flex flex-wrap gap-2">
								<button
									className={button}
									style={style}
									disabled={busy || !text.trim()}
									onClick={() =>
										void run(async () => {
											const result = await request<ContextualMemory>(
												selected
													? {
															action: 'correct',
															id: selected.id,
															text,
															projectPath: project || undefined,
														}
													: { action: 'remember', text, projectPath: project || undefined }
											);
											setSelected(result);
											await search();
										})
									}
								>
									{selected ? 'Save correction' : 'Remember'}
								</button>
								<button
									className={button}
									style={style}
									onClick={() => {
										setSelected(null);
										setText('');
									}}
								>
									New memory
								</button>
								{selected && (
									<>
										<button
											className={button}
											style={style}
											disabled={busy}
											onClick={() =>
												void run(async () => {
													setSelected(
														await request<ContextualMemory>({
															action: 'pin',
															id: selected.id,
															pinned: !selected.pinned,
														})
													);
													await search();
												})
											}
										>
											{selected.pinned ? 'Unpin' : 'Pin'}
										</button>
										<button
											className={button}
											style={style}
											disabled={busy}
											onClick={() => {
												if (!confirmForget) {
													setConfirmForget(true);
													return;
												}
												void run(async () => {
													await request({ action: 'forget', id: selected.id });
													setSelected(null);
													setText('');
													setConfirmForget(false);
													await search();
												});
											}}
										>
											{confirmForget ? 'Confirm permanent forget' : 'Forget'}
										</button>
									</>
								)}
							</div>
						</div>
					</div>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						List view displays up to 500 records. Search retrieves a bounded relevant packet. Export
						retains the full bank.
					</p>
					<button
						className={button}
						style={style}
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const data = await request({ action: 'export' });
								const url = URL.createObjectURL(
									new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
								);
								const link = document.createElement('a');
								link.href = url;
								link.download = 'pianola-memory.json';
								link.click();
								URL.revokeObjectURL(url);
							})
						}
					>
						Export my memory bank
					</button>
				</div>
			)}
		</div>
	);
}
