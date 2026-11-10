import { generateProseStyles } from '../utils/markdownConfig';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardCard, BoardWorkspaceCollection } from '../../shared/board/types';
import type { BoardCardRunView } from '../../shared/board/commands';
import type { Theme } from '../types';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import { openUrl } from '../utils/openUrl';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { Markdown } from './Markdown';
import { ThemedSelect } from './shared/ThemedSelect';

/** Inline read view inside the existing Board modal/layer. No timers or mutation actions. */
export function BoardCardDetails({
	card,
	collection,
	theme,
	projectRoot,
	onBack,
}: {
	card: BoardCard;
	collection: BoardWorkspaceCollection;
	theme: Theme;
	projectRoot?: string;
	onBack: () => void;
}) {
	const proseStyles = useMemo(
		() => generateProseStyles({ theme, scopeSelector: '.board-card-details' }),
		[theme]
	);
	const back = useRef<HTMLButtonElement>(null);
	useFocusOnMount(back, 0);
	const runs = card.runs ?? [];
	const [chosenRun, setChosenRun] = useState<string | null>(null);
	const run =
		(chosenRun
			? runs.find((entry) => (entry.runId ?? `legacy-${entry.attempt}`) === chosenRun)
			: undefined) ?? runs.at(-1);
	const runId = run?.runId;
	const key = JSON.stringify([
		collection.sourceKey,
		collection.collectionKey,
		collection.revision,
		card.id,
		card.storageRevision,
		runId,
	]);
	const [read, setRead] = useState<{
		key: string;
		value?: BoardCardRunView;
		error?: string;
	} | null>(null);
	useEffect(() => {
		if (!runId || card.storageRevision === undefined || !projectRoot) return;
		let cancelled = false;
		void window.maestro.board
			.readCardRun({
				action: 'read-card-run',
				target: {
					projectRoot: projectRoot,
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					expectedRevision: collection.revision,
				},
				cardId: card.id,
				cardRevision: card.storageRevision,
				runId,
			})
			.then((response) => {
				if (cancelled) return;
				if (!response.ok) setRead({ key, error: response.error.message });
				else setRead({ key, value: response.value as BoardCardRunView });
			})
			.catch((error) => {
				if (!cancelled) setRead({ key, error: ipcErrorMessage(error) });
			});
		return () => {
			cancelled = true;
		};
	}, [
		key,
		runId,
		card.id,
		card.storageRevision,
		collection.sourceKey,
		collection.collectionKey,
		collection.revision,
		projectRoot,
	]);
	// Fence the display during a new selection, before the new effect resolves.
	const current = read?.key === key ? read : null;
	return (
		<section
			aria-label="Card details"
			className="board-card-details flex-1 min-h-0 overflow-auto p-4 select-text space-y-4"
			style={{ color: theme.colors.textMain }}
		>
			<style>{proseStyles}</style>
			<button
				ref={back}
				type="button"
				onClick={onBack}
				className="rounded border px-3 py-1"
				style={{ borderColor: theme.colors.border }}
			>
				Back to board
			</button>
			<h2 className="text-lg font-semibold break-words">{card.title}</h2>
			<p>
				{card.status}
				{run ? ` · Attempt ${run.attempt} · ${run.outcome ?? 'in progress'}` : ''}
			</p>
			<section>
				<h3 className="font-semibold">Current instructions</h3>
				{card.body ? (
					<div className="board-card-prose prose prose-sm max-w-none">
						<Markdown preset="document" frontmatter={false} theme={theme} content={card.body} />
					</div>
				) : (
					<p>No instructions saved.</p>
				)}
			</section>
			{!run ? (
				<p>No attempts recorded.</p>
			) : (
				<>
					<ThemedSelect
						theme={theme}
						aria-label="Attempt"
						value={runId ?? ''}
						options={runs.map((entry) => ({
							value: entry.runId ?? `legacy-${entry.attempt}`,
							label: `Attempt ${entry.attempt} · ${entry.startedAt} · ${entry.outcome ?? 'in progress'}`,
						}))}
						onChange={setChosenRun}
					/>
					{!runId || card.storageRevision === undefined || !projectRoot ? (
						<p>Full attempt data is unavailable for this legacy record.</p>
					) : !current ? (
						<p role="status">Loading saved attempt…</p>
					) : current.error ? (
						<p role="alert">{current.error}</p>
					) : (
						current.value && (
							<>
								<section>
									<h3 className="font-semibold">Stored attempt instructions</h3>
									<p className="text-xs" style={{ color: theme.colors.textDim }}>
										Instructions captured for this attempt; the complete provider launch envelope is
										not retained here.
									</p>
									{current.value.instructions === null ? (
										<p>No attempt instructions retained.</p>
									) : (
										<>
											{current.value.instructions !== card.body && (
												<p style={{ color: theme.colors.warning }}>
													These differ from the current instructions.
												</p>
											)}
											<div className="board-card-prose prose prose-sm max-w-none">
												<Markdown
													preset="document"
													theme={theme}
													content={current.value.instructions}
												/>
											</div>
										</>
									)}
								</section>
								<section>
									<h3 className="font-semibold">Saved response</h3>
									<p>
										{current.value.phase ?? run.outcome ?? 'Status not retained'}
										{current.value.exitCode === null ? '' : ` · Exit ${current.value.exitCode}`}
									</p>
									{current.value.phase === 'uncertain' && (
										<p style={{ color: theme.colors.warning }}>
											Retained output is not an accepted final result.
										</p>
									)}
									{current.value.output ? (
										<div className="board-card-prose prose prose-sm max-w-none">
											<Markdown
												preset="document"
												frontmatter={false}
												theme={theme}
												content={current.value.output}
											/>
										</div>
									) : (
										<p>
											{run.endedAt
												? 'No response was saved for this attempt.'
												: 'This attempt has no saved response yet.'}
										</p>
									)}
								</section>
							</>
						)
					)}
				</>
			)}
			<details>
				<summary className="cursor-pointer">Technical details</summary>
				<p>
					Source: {collection.sourceKey} · Collection: {collection.collectionKey} · Revision:{' '}
					{collection.revision}
				</p>
				<p>
					Project: {card.workingDirectory || card.repositoryId || 'not set'} · Reviewer:{' '}
					{card.reviewerAgentId ?? 'not assigned'}
				</p>
				<p>
					{card.executionScope?.kind === 'group'
						? `Group: ${card.executionScope.groupId}`
						: card.executionScope?.kind === 'agent'
							? `Agent: ${card.executionScope.agentId}`
							: 'Unassigned scope'}
				</p>
				{run && (
					<p>
						Attempt {run.attempt} · Started {run.startedAt}
						{run.endedAt ? ` · Ended ${run.endedAt}` : ''}
					</p>
				)}
				{run?.summary && <p>{run.summary}</p>}
				{run?.worktreeBranch && (
					<p>
						Worktree branch {run.worktreeBranch}
						{run.worktreePath ? ` at ${run.worktreePath}` : ''}
					</p>
				)}
				{run?.prUrl ? (
					<button
						type="button"
						title={run.prUrl}
						onClick={(event) => openUrl(run.prUrl!, { ctrlKey: event.ctrlKey || event.metaKey })}
					>
						🔗 PR
					</button>
				) : (
					run?.prError && <p>{run.prError}</p>
				)}
				<pre className="whitespace-pre-wrap break-words text-xs">
					{JSON.stringify(card, null, 2)}
				</pre>
			</details>
		</section>
	);
}
