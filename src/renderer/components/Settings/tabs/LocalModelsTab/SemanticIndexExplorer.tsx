import { memo, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import {
	EMBEDDING_SOURCE_TYPES,
	type EmbeddingSourceType,
	type SemanticIndexPage,
	type SemanticIndexStorage,
} from '../../../../../shared/local-models/embedding-index';
import { getLocalModel } from '../../../../../shared/local-models/model-catalog';
import { WORK_SEARCH_SOURCE_LABELS } from '../../../../../shared/local-models/work-search';
import { formatCount, formatRelativeTime } from '../../../../../shared/formatters';
import type { Theme } from '../../../../types';
import { CardButton } from './CardButton';

export const SemanticIndexExplorer = memo(function SemanticIndexExplorer({
	theme,
	storage,
	activeModelId,
}: {
	theme: Theme;
	storage: SemanticIndexStorage;
	activeModelId?: string;
}) {
	const [selected, setSelected] = useState('');
	const modelId = storage.models.some((model) => model.modelId === selected)
		? selected
		: (storage.models.find((model) => model.modelId === activeModelId)?.modelId ??
			storage.models[0]?.modelId ??
			'');
	const [sourceType, setSourceType] = useState<EmbeddingSourceType | ''>('');
	const [offset, setOffset] = useState(0);
	const [revision, setRevision] = useState(0);
	const [page, setPage] = useState<SemanticIndexPage | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setPage(null);
		setError(null);
		if (!modelId) {
			setLoading(false);
			return;
		}
		setLoading(true);
		window.maestro.localModels.semanticIndex
			.browse({
				modelId,
				offset,
				limit: 20,
				...(sourceType ? { sourceType } : {}),
			})
			.then((next) => {
				if (!cancelled) setPage(next);
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [modelId, sourceType, offset, revision]);

	const model = storage.models.find((entry) => entry.modelId === modelId);
	const selectStyle = {
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.bgMain,
		color: theme.colors.textMain,
	};
	return (
		<div
			className="space-y-3 border-t pt-3"
			style={{ borderColor: theme.colors.border }}
			data-testid="semantic-index-explorer"
		>
			<div className="text-xs opacity-70">
				Browse indexed sources without running a model. Previews come from the original History,
				notes, or transcript.
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
				<label className="text-xs space-y-1">
					<span>Indexed model</span>
					<select
						aria-label="Indexed model"
						value={modelId}
						onChange={(event) => {
							setSelected(event.target.value);
							setOffset(0);
						}}
						className="w-full rounded border p-2 text-xs"
						style={selectStyle}
					>
						{storage.models.map((entry) => (
							<option key={entry.modelId} value={entry.modelId}>
								{getLocalModel(entry.modelId.replace(/^local:/, ''))?.displayName ?? entry.modelId}
								{entry.modelId === activeModelId ? ' (active)' : ''}
							</option>
						))}
					</select>
				</label>
				<label className="text-xs space-y-1">
					<span>Source type</span>
					<select
						aria-label="Index source type"
						value={sourceType}
						onChange={(event) => {
							setSourceType(event.target.value as EmbeddingSourceType | '');
							setOffset(0);
						}}
						className="w-full rounded border p-2 text-xs"
						style={selectStyle}
					>
						<option value="">All sources</option>
						{EMBEDDING_SOURCE_TYPES.map((type) => (
							<option key={type} value={type}>
								{WORK_SEARCH_SOURCE_LABELS[type]}
							</option>
						))}
					</select>
				</label>
			</div>
			{model && (
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-70">
					{EMBEDDING_SOURCE_TYPES.map((type) => (
						<span key={type}>
							{WORK_SEARCH_SOURCE_LABELS[type]}: {formatCount(model.bySourceType[type])} chunks
						</span>
					))}
				</div>
			)}
			<div className="flex items-center justify-between gap-2 text-xs">
				<span>{page ? `${formatCount(page.total)} indexed sources` : 'Indexed sources'}</span>
				<CardButton
					theme={theme}
					icon={RefreshCw}
					label="Refresh entries"
					onClick={() => setRevision((value) => value + 1)}
					disabled={loading}
					testId="semantic-index-refresh-entries"
				/>
			</div>
			{loading && (
				<div className="text-xs opacity-70" role="status">
					Loading indexed sources...
				</div>
			)}
			{error && (
				<div className="text-xs select-text" role="alert" style={{ color: theme.colors.error }}>
					{error}
				</div>
			)}
			{page && (
				<>
					<div className="max-h-80 overflow-y-auto space-y-2" aria-label="Indexed sources">
						{page.entries.map((entry) => (
							<div
								key={`${entry.sourceType}:${entry.sourceId}`}
								className="rounded border p-2 space-y-1 select-text"
								style={{ borderColor: theme.colors.border }}
							>
								<div className="text-sm font-medium break-words">
									{entry.title ?? entry.sourceId}
								</div>
								<div className="text-xs opacity-70">
									{WORK_SEARCH_SOURCE_LABELS[entry.sourceType]}
									{entry.agentName ? ` · ${entry.agentName}` : ''} · {formatCount(entry.chunks)}{' '}
									chunks · Indexed {formatRelativeTime(entry.indexedAt)}
								</div>
								<div className="text-xs opacity-70 break-words">
									{entry.snippet ?? 'Original source is unavailable.'}
								</div>
							</div>
						))}
						{page.entries.length === 0 && (
							<div className="text-xs opacity-70">No indexed sources on this page.</div>
						)}
					</div>
					<div className="flex items-center justify-between gap-2">
						<CardButton
							theme={theme}
							icon={ChevronLeft}
							label="Previous"
							onClick={() => setOffset(Math.max(0, page.offset - page.limit))}
							disabled={loading || page.offset === 0}
							testId="semantic-index-previous"
						/>
						<span className="text-xs opacity-70">
							{page.total === 0
								? '0'
								: `${formatCount(page.offset + (page.entries.length ? 1 : 0))} to ${formatCount(page.offset + page.entries.length)}`}{' '}
							of {formatCount(page.total)}
						</span>
						<CardButton
							theme={theme}
							icon={ChevronRight}
							label="Next"
							onClick={() => setOffset(page.offset + page.limit)}
							disabled={loading || page.offset + page.limit >= page.total}
							testId="semantic-index-next"
						/>
					</div>
				</>
			)}
		</div>
	);
});
