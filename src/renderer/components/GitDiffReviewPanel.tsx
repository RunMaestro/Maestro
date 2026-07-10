import { useMemo, useState } from 'react';
import { Eye, ListTree, MessageSquareText, Send, ShieldAlert, Trash2, X } from 'lucide-react';
import type { Theme } from '../types';
import {
	buildGitReviewPrompt,
	describeGitReviewLocation,
	type GitChangeBrief,
	type GitChangeFileSummary,
	type GitReviewComment,
} from '../utils/gitReview';

interface GitDiffReviewPanelProps {
	brief: GitChangeBrief;
	comments: GitReviewComment[];
	overallFeedback: string;
	activeFileIndex: number;
	theme: Theme;
	onOverallFeedbackChange: (feedback: string) => void;
	onSelectFile: (fileIndex: number) => void;
	onNoteChange: (id: string, note: string) => void;
	onRemove: (id: string) => void;
	onClear: () => void;
	onSendReview?: (prompt: string) => void;
}

function getRiskLevel(file: GitChangeFileSummary): 'high' | 'medium' | null {
	if (file.risks.some((risk) => risk.level === 'high')) return 'high';
	if (file.risks.some((risk) => risk.level === 'medium')) return 'medium';
	return null;
}

export function GitDiffReviewPanel({
	brief,
	comments,
	overallFeedback,
	activeFileIndex,
	theme,
	onOverallFeedbackChange,
	onSelectFile,
	onNoteChange,
	onRemove,
	onClear,
	onSendReview,
}: GitDiffReviewPanelProps) {
	const [activeView, setActiveView] = useState<'brief' | 'comments' | 'prompt'>('brief');
	const prompt = useMemo(
		() => buildGitReviewPrompt(comments, overallFeedback),
		[comments, overallFeedback]
	);
	const hasBlankNote = comments.some((comment) => !comment.note.trim());
	const hasFeedback = Boolean(overallFeedback.trim()) || comments.length > 0;
	const canSend = hasFeedback && !hasBlankNote && Boolean(onSendReview);
	const attentionCount = brief.highRiskFiles + brief.mediumRiskFiles;

	const renderFileButton = (file: GitChangeFileSummary, showRisks: boolean) => {
		const riskLevel = getRiskLevel(file);
		const riskColor = riskLevel === 'high' ? theme.colors.error : theme.colors.warning;
		return (
			<button
				key={file.fileIndex}
				type="button"
				onClick={() => onSelectFile(file.fileIndex)}
				className="w-full rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-white/5"
				style={{
					borderColor:
						activeFileIndex === file.fileIndex ? theme.colors.accent : theme.colors.border,
					backgroundColor:
						activeFileIndex === file.fileIndex ? `${theme.colors.accent}12` : theme.colors.bgMain,
				}}
			>
				<div className="flex items-start justify-between gap-2">
					<span
						className="min-w-0 truncate font-mono text-[11px]"
						style={{ color: theme.colors.textMain }}
						title={file.filePath}
					>
						{file.filePath}
					</span>
					<span className="shrink-0 text-[10px]" style={{ color: theme.colors.textDim }}>
						{file.changedLines.toLocaleString()} lines
					</span>
				</div>
				<div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
					<span style={{ color: theme.colors.textDim }}>{file.areaLabel}</span>
					<span>
						<span style={{ color: theme.colors.success }}>+{file.additions}</span>{' '}
						<span style={{ color: theme.colors.error }}>-{file.deletions}</span>
					</span>
				</div>
				{showRisks && file.risks.length > 0 && (
					<div className="mt-1.5 text-[10px] leading-relaxed">
						<div style={{ color: riskColor }}>
							{file.risks.map((risk) => risk.label).join(', ')}
						</div>
						<div className="mt-0.5" style={{ color: theme.colors.textDim }}>
							{file.risks[0].reason}
						</div>
					</div>
				)}
			</button>
		);
	};

	return (
		<aside
			className="flex w-[360px] min-w-[300px] max-w-[44%] flex-col border-l select-none"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			aria-label="Diff review"
		>
			<div
				className="flex items-center justify-between gap-2 border-b px-3 py-2.5"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2 min-w-0">
					<MessageSquareText className="h-4 w-4 shrink-0" style={{ color: theme.colors.accent }} />
					<div className="min-w-0">
						<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							Rehearsal
						</div>
						<div className="text-[11px]" style={{ color: theme.colors.textDim }}>
							{brief.files.length} files, {comments.length} line{' '}
							{comments.length === 1 ? 'note' : 'notes'}
						</div>
					</div>
				</div>
				<div
					className="flex rounded p-0.5"
					style={{ backgroundColor: theme.colors.bgActivity }}
					role="tablist"
					aria-label="Review panel view"
				>
					<button
						type="button"
						onClick={() => setActiveView('brief')}
						className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
						style={{
							color: activeView === 'brief' ? theme.colors.textMain : theme.colors.textDim,
							backgroundColor: activeView === 'brief' ? theme.colors.bgMain : 'transparent',
						}}
						role="tab"
						aria-selected={activeView === 'brief'}
					>
						<ListTree className="h-3 w-3" />
						Brief
					</button>
					<button
						type="button"
						onClick={() => setActiveView('comments')}
						className="rounded px-2 py-1 text-xs transition-colors"
						style={{
							color: activeView === 'comments' ? theme.colors.textMain : theme.colors.textDim,
							backgroundColor: activeView === 'comments' ? theme.colors.bgMain : 'transparent',
						}}
						role="tab"
						aria-selected={activeView === 'comments'}
					>
						Notes
					</button>
					<button
						type="button"
						onClick={() => setActiveView('prompt')}
						className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
						style={{
							color: activeView === 'prompt' ? theme.colors.textMain : theme.colors.textDim,
							backgroundColor: activeView === 'prompt' ? theme.colors.bgMain : 'transparent',
						}}
						role="tab"
						aria-selected={activeView === 'prompt'}
					>
						<Eye className="h-3 w-3" />
						Prompt
					</button>
				</div>
			</div>

			<div className="flex-1 overflow-auto p-3">
				{activeView === 'brief' ? (
					<div className="space-y-4">
						<div>
							<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
								Change Brief
							</div>
							<p
								className="mt-1 text-[11px] leading-relaxed"
								style={{ color: theme.colors.textDim }}
							>
								Review risk and intent boundaries first. Open the raw diff only where your attention
								is valuable.
							</p>
						</div>

						<div className="grid grid-cols-3 gap-2">
							<div className="rounded border p-2" style={{ borderColor: theme.colors.border }}>
								<div className="text-base font-semibold" style={{ color: theme.colors.textMain }}>
									{brief.files.length.toLocaleString()}
								</div>
								<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Files
								</div>
							</div>
							<div className="rounded border p-2" style={{ borderColor: theme.colors.border }}>
								<div className="truncate text-xs font-semibold">
									<span style={{ color: theme.colors.success }}>
										+{brief.totalAdditions.toLocaleString()}
									</span>{' '}
									<span style={{ color: theme.colors.error }}>
										-{brief.totalDeletions.toLocaleString()}
									</span>
								</div>
								<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Changed lines
								</div>
							</div>
							<div className="rounded border p-2" style={{ borderColor: theme.colors.border }}>
								<div
									className="text-base font-semibold"
									style={{
										color: attentionCount > 0 ? theme.colors.warning : theme.colors.success,
									}}
								>
									{attentionCount}
								</div>
								<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Flagged files
								</div>
							</div>
						</div>

						{brief.observations.length > 0 && (
							<section aria-labelledby="review-observations-heading">
								<div
									id="review-observations-heading"
									className="mb-2 flex items-center gap-1.5 text-xs font-semibold"
									style={{ color: theme.colors.textMain }}
								>
									<ShieldAlert className="h-3.5 w-3.5" style={{ color: theme.colors.warning }} />
									Review observations
								</div>
								<div className="space-y-2">
									{brief.observations.map((observation) => (
										<div
											key={observation.id}
											className="rounded border p-2.5"
											style={{
												borderColor:
													observation.level === 'high' ? theme.colors.error : theme.colors.warning,
												backgroundColor: theme.colors.bgMain,
											}}
										>
											<div
												className="text-[11px] font-semibold"
												style={{ color: theme.colors.textMain }}
											>
												{observation.title}
											</div>
											<div
												className="mt-1 text-[10px] leading-relaxed"
												style={{ color: theme.colors.textDim }}
											>
												{observation.detail}
											</div>
										</div>
									))}
								</div>
							</section>
						)}

						<section aria-labelledby="attention-files-heading">
							<div
								id="attention-files-heading"
								className="mb-2 text-xs font-semibold"
								style={{ color: theme.colors.textMain }}
							>
								Needs attention
							</div>
							{brief.attentionFiles.length === 0 ? (
								<p
									className="rounded border p-2.5 text-[11px]"
									style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
								>
									No deterministic risk signals were found. This is not a guarantee of safety.
								</p>
							) : (
								<div className="space-y-2">
									{brief.attentionFiles.slice(0, 12).map((file) => renderFileButton(file, true))}
									{brief.attentionFiles.length > 12 && (
										<p className="text-center text-[10px]" style={{ color: theme.colors.textDim }}>
											{brief.attentionFiles.length - 12} additional flagged files are grouped below.
										</p>
									)}
								</div>
							)}
						</section>

						<section aria-labelledby="change-areas-heading">
							<div
								id="change-areas-heading"
								className="mb-2 text-xs font-semibold"
								style={{ color: theme.colors.textMain }}
							>
								Change areas
							</div>
							<div className="space-y-1.5">
								{brief.areas.map((area) => (
									<button
										key={area.id}
										type="button"
										onClick={() => onSelectFile(area.fileIndexes[0])}
										className="flex w-full items-center justify-between gap-2 rounded border px-2.5 py-2 text-left transition-colors hover:bg-white/5"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgMain,
										}}
									>
										<div>
											<div
												className="text-[11px] font-medium"
												style={{ color: theme.colors.textMain }}
											>
												{area.label}
											</div>
											<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
												{area.fileCount} {area.fileCount === 1 ? 'file' : 'files'},{' '}
												{area.changedLines.toLocaleString()} lines
											</div>
										</div>
										{area.highRiskFiles + area.mediumRiskFiles > 0 && (
											<span className="text-[10px]" style={{ color: theme.colors.warning }}>
												{area.highRiskFiles + area.mediumRiskFiles} flagged
											</span>
										)}
									</button>
								))}
							</div>
						</section>

						<section aria-labelledby="largest-changes-heading">
							<div
								id="largest-changes-heading"
								className="mb-2 text-xs font-semibold"
								style={{ color: theme.colors.textMain }}
							>
								Largest changes
							</div>
							<div className="space-y-2">
								{brief.largestFiles.map((file) => renderFileButton(file, false))}
							</div>
						</section>

						<label className="block">
							<span className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
								Overall feedback
							</span>
							<span
								className="mt-1 block text-[10px] leading-relaxed"
								style={{ color: theme.colors.textDim }}
							>
								Redirect the change at the intent or architecture level without commenting on every
								line.
							</span>
							<textarea
								value={overallFeedback}
								onChange={(event) => onOverallFeedbackChange(event.target.value)}
								placeholder="What should change overall?"
								className="mt-2 min-h-24 w-full resize-y rounded border px-2.5 py-2 text-xs leading-relaxed outline-none select-text"
								style={{
									color: theme.colors.textMain,
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
								}}
							/>
						</label>
					</div>
				) : activeView === 'comments' ? (
					comments.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
							<MessageSquareText className="h-6 w-6" style={{ color: theme.colors.textDim }} />
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Select a line in the diff
							</p>
							<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
								Click a code line or line number only when you need focused feedback.
							</p>
						</div>
					) : (
						<div className="space-y-3">
							{comments.map((comment, index) => (
								<div
									key={comment.id}
									className="rounded-md border"
									style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
								>
									<div
										className="flex items-start justify-between gap-2 border-b px-2.5 py-2"
										style={{ borderColor: theme.colors.border }}
									>
										<div className="min-w-0">
											<div
												className="truncate font-mono text-[11px]"
												style={{ color: theme.colors.textMain }}
												title={comment.filePath}
											>
												{comment.filePath}
											</div>
											<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
												Comment {index + 1}, {describeGitReviewLocation(comment)}
											</div>
										</div>
										<button
											type="button"
											onClick={() => onRemove(comment.id)}
											className="rounded p-1 transition-colors hover:bg-white/10"
											style={{ color: theme.colors.textDim }}
											aria-label={`Remove comment ${index + 1}`}
										>
											<X className="h-3.5 w-3.5" />
										</button>
									</div>
									<pre
										className="max-h-24 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-[11px] select-text"
										style={{
											color: theme.colors.textDim,
											backgroundColor: theme.colors.bgActivity,
										}}
									>
										{comment.code}
									</pre>
									<label className="block px-2.5 py-2.5">
										<span className="sr-only">Review note for comment {index + 1}</span>
										<textarea
											value={comment.note}
											onChange={(event) => onNoteChange(comment.id, event.target.value)}
											placeholder="What should change?"
											className="min-h-20 w-full resize-y rounded border px-2.5 py-2 text-xs leading-relaxed outline-none select-text"
											style={{
												color: theme.colors.textMain,
												backgroundColor: theme.colors.bgSidebar,
												borderColor: comment.note.trim()
													? theme.colors.border
													: theme.colors.accent,
											}}
										/>
									</label>
								</div>
							))}
						</div>
					)
				) : (
					<pre
						className="min-h-full whitespace-pre-wrap break-words rounded border p-3 font-mono text-[11px] leading-relaxed select-text"
						style={{
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
						}}
					>
						{prompt}
					</pre>
				)}
			</div>

			<div className="border-t p-3" style={{ borderColor: theme.colors.border }}>
				{!onSendReview && (
					<p className="mb-2 text-[11px] leading-relaxed" style={{ color: theme.colors.textDim }}>
						Switch to an AI tab to send this review.
					</p>
				)}
				{!hasFeedback && (
					<p className="mb-2 text-[11px] leading-relaxed" style={{ color: theme.colors.textDim }}>
						Add overall feedback or a focused line note before sending.
					</p>
				)}
				{hasBlankNote && comments.length > 0 && (
					<p className="mb-2 text-[11px] leading-relaxed" style={{ color: theme.colors.textDim }}>
						Add a note to every selected line before sending.
					</p>
				)}
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onClear}
						disabled={!hasFeedback}
						className="flex items-center gap-1.5 rounded border px-2.5 py-2 text-xs transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
						style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
					>
						<Trash2 className="h-3.5 w-3.5" />
						Clear
					</button>
					<button
						type="button"
						onClick={() => onSendReview?.(prompt)}
						disabled={!canSend}
						className="flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-2 text-xs font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
						style={{
							color: theme.colors.accentForeground,
							backgroundColor: theme.colors.accent,
						}}
					>
						<Send className="h-3.5 w-3.5" />
						Send review
					</button>
				</div>
			</div>
		</aside>
	);
}
