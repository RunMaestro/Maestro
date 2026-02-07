/**
 * GranolaPanel - Right Bar panel for browsing Granola meetings and injecting transcripts.
 *
 * Shows a list of recent meetings. Clicking one fetches the transcript and calls
 * onInjectTranscript so the parent can feed it into the active AI session.
 */

import React, { useEffect, useState, useCallback, memo } from 'react';
import { RefreshCw, Loader2, FileText, AlertCircle, Users, ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../types';
import type { GranolaDocument, GranolaErrorType } from '../../shared/granola-types';
import { useGranola } from '../hooks/useGranola';

interface GranolaPanelProps {
	theme: Theme;
	onInjectTranscript: (title: string, plainText: string) => void;
}

function formatDate(epochMs: number): string {
	const d = new Date(epochMs);
	const now = new Date();
	const diffMs = now.getTime() - d.getTime();
	const diffHours = diffMs / (1000 * 60 * 60);

	if (diffHours < 1) {
		const mins = Math.floor(diffMs / (1000 * 60));
		return `${mins}m ago`;
	}
	if (diffHours < 24) {
		return `${Math.floor(diffHours)}h ago`;
	}
	if (diffHours < 48) {
		return 'Yesterday';
	}
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function errorMessage(error: GranolaErrorType): string {
	switch (error) {
		case 'not_installed':
			return 'Granola is not installed. Install it from granola.ai to use this feature.';
		case 'auth_expired':
			return 'Granola auth token expired. Open Granola and sign in again.';
		case 'network_error':
			return 'Could not reach Granola API. Check your network connection.';
		case 'api_error':
			return 'Granola API returned an error. Try again later.';
	}
}

const MeetingRow = memo(function MeetingRow({
	doc,
	theme,
	onSelect,
	isLoading,
}: {
	doc: GranolaDocument;
	theme: Theme;
	onSelect: (doc: GranolaDocument) => void;
	isLoading: boolean;
}) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div
			className="border rounded px-3 py-2 cursor-pointer transition-colors hover:brightness-110"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
			}}
			onClick={() => {
				if (!isLoading) onSelect(doc);
			}}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="flex-1 min-w-0">
					<div
						className="text-sm font-medium truncate"
						style={{ color: theme.colors.textMain }}
						title={doc.title}
					>
						{doc.title}
					</div>
					<div className="flex items-center gap-2 mt-1">
						<span
							className="text-xs"
							style={{ color: theme.colors.textDim }}
						>
							{formatDate(doc.createdAt)}
						</span>
						{doc.participants.length > 0 && (
							<button
								className="flex items-center gap-1 text-xs hover:underline"
								style={{ color: theme.colors.textDim }}
								onClick={(e) => {
									e.stopPropagation();
									setExpanded(!expanded);
								}}
								title="Show participants"
							>
								<Users className="w-3 h-3" />
								{doc.participants.length}
								{expanded ? (
									<ChevronDown className="w-3 h-3" />
								) : (
									<ChevronRight className="w-3 h-3" />
								)}
							</button>
						)}
					</div>
				</div>
				<div className="flex items-center shrink-0 mt-0.5">
					{isLoading ? (
						<Loader2
							className="w-4 h-4 animate-spin"
							style={{ color: theme.colors.accent }}
						/>
					) : (
						<FileText
							className="w-4 h-4"
							style={{ color: theme.colors.textDim }}
						/>
					)}
				</div>
			</div>
			{expanded && doc.participants.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1">
					{doc.participants.map((p, i) => (
						<span
							key={i}
							className="text-xs px-1.5 py-0.5 rounded"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								color: theme.colors.textDim,
							}}
						>
							{p}
						</span>
					))}
				</div>
			)}
		</div>
	);
});

export const GranolaPanel = memo(function GranolaPanel({
	theme,
	onInjectTranscript,
}: GranolaPanelProps) {
	const { documents, loading, error, fetchDocuments, fetchTranscript } = useGranola();
	const [loadingDocId, setLoadingDocId] = useState<string | null>(null);

	// Fetch documents on mount
	useEffect(() => {
		fetchDocuments();
	}, [fetchDocuments]);

	const handleSelect = useCallback(
		async (doc: GranolaDocument) => {
			setLoadingDocId(doc.id);
			const transcript = await fetchTranscript(doc.id);
			setLoadingDocId(null);
			if (transcript) {
				onInjectTranscript(transcript.title, transcript.plainText);
			}
		},
		[fetchTranscript, onInjectTranscript]
	);

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between py-3">
				<span
					className="text-xs font-bold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					Meetings
				</span>
				<button
					onClick={fetchDocuments}
					disabled={loading}
					className="p-1 rounded hover:bg-white/5 transition-colors"
					title="Refresh meetings"
				>
					<RefreshCw
						className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
						style={{ color: theme.colors.textDim }}
					/>
				</button>
			</div>

			{/* Error state */}
			{error && (
				<div
					className="flex items-start gap-2 p-3 rounded text-xs mb-3"
					style={{
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.textMain,
					}}
				>
					<AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: theme.colors.accent }} />
					<span>{errorMessage(error)}</span>
				</div>
			)}

			{/* Loading state */}
			{loading && documents.length === 0 && !error && (
				<div className="flex items-center justify-center py-8">
					<Loader2
						className="w-5 h-5 animate-spin"
						style={{ color: theme.colors.textDim }}
					/>
				</div>
			)}

			{/* Empty state */}
			{!loading && !error && documents.length === 0 && (
				<div
					className="text-center py-8 text-xs"
					style={{ color: theme.colors.textDim }}
				>
					No recent meetings found.
				</div>
			)}

			{/* Meeting list */}
			{documents.length > 0 && (
				<div className="flex flex-col gap-2 overflow-y-auto">
					{documents.map((doc) => (
						<MeetingRow
							key={doc.id}
							doc={doc}
							theme={theme}
							onSelect={handleSelect}
							isLoading={loadingDocId === doc.id}
						/>
					))}
				</div>
			)}
		</div>
	);
});
