/**
 * FeedbackChatView - Chat-based feedback collection interface
 *
 * Replaces the form-based FeedbackView with a conversational interface.
 * Users describe their issue in plain English, the AI asks follow-up questions,
 * and when understanding reaches 80%, submits a well-structured GitHub issue.
 *
 * Features:
 * - Provider selection (reuses agent configuration pattern)
 * - Chat interface with progress bar
 * - Screenshot drag-and-drop
 * - Support package opt-in
 * - GH CLI availability check
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ImagePlus,
	Loader2,
	MessageSquareHeart,
	Send,
	X,
	Package,
	AlertCircle,
	ExternalLink,
	ThumbsUp,
	PlusCircle,
	Check,
	Copy,
} from 'lucide-react';
import { safeClipboardWrite } from '../utils/clipboard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import type { Theme, Session, ToolType } from '../types';
import {
	FeedbackConversationManager,
	getConfidenceColor,
	type FeedbackMessage,
	type FeedbackParsedResponse,
} from '../services/feedbackConversation';
import { isBetaAgent } from '../../shared/agentMetadata';
import { ThemedSelect } from './shared/ThemedSelect';

// ============================================================================
// Constants
// ============================================================================

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface FeedbackAttachment {
	id: string;
	name: string;
	dataUrl: string;
	sizeBytes: number;
}

// ============================================================================
// Helpers
// ============================================================================

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result);
				return;
			}
			reject(new Error(`Unable to read ${file.name}.`));
		};
		reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
		reader.readAsDataURL(file);
	});
}

// ============================================================================
// Agent Tile Data
// ============================================================================

interface AgentTile {
	id: ToolType;
	name: string;
	supported: boolean;
}

const AGENT_TILES: AgentTile[] = [
	{ id: 'claude-code', name: 'Claude Code', supported: true },
	{ id: 'codex', name: 'OpenAI Codex', supported: true },
	{ id: 'opencode', name: 'OpenCode', supported: true },
];

// ============================================================================
// Component Props
// ============================================================================

interface FeedbackChatViewProps {
	theme: Theme;
	sessions: Session[];
	onCancel: () => void;
	onSubmitSuccess: (sessionId: string) => void;
	/** Called when the view's desired modal width changes */
	onWidthChange?: (width: number) => void;
}

// ============================================================================
// Component
// ============================================================================

interface ExistingIssue {
	number: number;
	title: string;
	url: string;
	state: string;
	labels: string[];
	createdAt: string;
	author: string;
	commentCount: number;
}

export function FeedbackChatView({ theme, onCancel, onWidthChange }: FeedbackChatViewProps) {
	// --- State ---
	const [step, setStep] = useState<
		'gh-check' | 'provider-select' | 'chat' | 'matching' | 'submitting' | 'done'
	>('gh-check');
	const [ghAuth, setGhAuth] = useState<{ checking: boolean; ok: boolean; message?: string }>({
		checking: true,
		ok: false,
	});
	const [selectedAgent, setSelectedAgent] = useState<ToolType>('claude-code');
	const [detectedAgents, setDetectedAgents] = useState<Set<string>>(new Set());
	const [messages, setMessages] = useState<FeedbackMessage[]>([]);
	const [inputValue, setInputValue] = useState('');
	const [isLoading, setIsLoading] = useState(false);
	const [confidence, setConfidence] = useState(0);
	const [isReady, setIsReady] = useState(false);
	const [lastResponse, setLastResponse] = useState<FeedbackParsedResponse | null>(null);
	const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const [includeDebugPackage, setIncludeDebugPackage] = useState(false);
	const [submitError, setSubmitError] = useState('');
	const [matchingIssues, setMatchingIssues] = useState<ExistingIssue[]>([]);
	const [searchingIssues, setSearchingIssues] = useState(false);
	const [subscribingTo, setSubscribingTo] = useState<number | null>(null);
	const [createdIssueUrl, setCreatedIssueUrl] = useState<string | null>(null);
	const [copiedUrl, setCopiedUrl] = useState(false);
	const lastSearchQueryRef = useRef<string | null>(null);
	const searchAbortRef = useRef(0); // Monotonic counter to discard stale searches

	// --- Refs ---
	const managerRef = useRef<FeedbackConversationManager>(new FeedbackConversationManager());
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// --- Report desired width based on current step ---
	useEffect(() => {
		const isNarrow = step === 'gh-check' || step === 'provider-select';
		onWidthChange?.(isNarrow ? 420 : 780);
	}, [step, onWidthChange]);

	// --- GH Auth Check ---
	useEffect(() => {
		let mounted = true;
		(async () => {
			try {
				const result = await window.maestro.feedback.checkGhAuth();
				if (mounted) {
					setGhAuth({ checking: false, ok: result.authenticated, message: result.message });
					if (result.authenticated) setStep('provider-select');
				}
			} catch {
				if (mounted) {
					setGhAuth({ checking: false, ok: false, message: 'Unable to verify GitHub CLI.' });
				}
			}
		})();
		return () => {
			mounted = false;
		};
	}, []);

	// --- Agent Detection ---
	useEffect(() => {
		let mounted = true;
		(async () => {
			try {
				const agents = await window.maestro.agents.detect();
				if (mounted) {
					const available = new Set<string>(agents.filter((a) => a.available).map((a) => a.id));
					setDetectedAgents(available);
					// Auto-select first available
					const firstAvailable = AGENT_TILES.find((t) => t.supported && available.has(t.id));
					if (firstAvailable) setSelectedAgent(firstAvailable.id);
				}
			} catch {
				// Ignore
			}
		})();
		return () => {
			mounted = false;
		};
	}, []);

	// --- Auto-resize textarea as content changes ---
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.style.height = 'auto';
			inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 176)}px`;
		}
	}, [inputValue]);

	// --- Scroll to bottom on new messages ---
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, isLoading]);

	// --- Cleanup on unmount ---
	useEffect(() => {
		return () => {
			managerRef.current.cleanup();
		};
	}, []);

	// --- Background issue search — fires after every agent response ---
	const runIssueSearch = useCallback(async (query: string) => {
		if (!query || query === lastSearchQueryRef.current) return;
		lastSearchQueryRef.current = query;

		const searchId = ++searchAbortRef.current;
		setSearchingIssues(true);

		try {
			const result = await window.maestro.feedback.searchIssues(query);
			// Only accept results from the latest search (discard stale)
			if (searchId !== searchAbortRef.current) return;
			setMatchingIssues(result.issues);
		} catch {
			if (searchId !== searchAbortRef.current) return;
			setMatchingIssues([]);
		} finally {
			if (searchId === searchAbortRef.current) {
				setSearchingIssues(false);
			}
		}
	}, []);

	// Trigger search after every agent response that has a summary
	useEffect(() => {
		if (!lastResponse) return;
		const query = lastResponse.summary || lastResponse.structured.expectedBehavior;
		if (query) {
			void runIssueSearch(query);
		}
	}, [lastResponse, runIssueSearch]);

	// Available agent tiles
	const availableTiles = useMemo(
		() => AGENT_TILES.filter((t) => t.supported && detectedAgents.has(t.id)),
		[detectedAgents]
	);

	// Prose styles for markdown rendering in assistant messages
	const proseStyles = useMemo(() => generateTerminalProseStyles(theme, '.feedback-chat'), [theme]);

	const copyToClipboard = useCallback((text: string) => {
		void safeClipboardWrite(text);
	}, []);

	// --- Start conversation ---
	const startConversation = useCallback(async () => {
		try {
			const { prompt } = await window.maestro.feedback.getConversationPrompt();
			managerRef.current.start({
				agentType: selectedAgent,
				systemPrompt: prompt,
			});
			setStep('chat');
			// Focus input immediately — no auto-greeting, user speaks first
			requestAnimationFrame(() => inputRef.current?.focus());
		} catch (error) {
			setSubmitError(error instanceof Error ? error.message : 'Failed to start conversation');
		}
	}, [selectedAgent]);

	// --- Send message ---
	const sendMessage = useCallback(async () => {
		const text = inputValue.trim();
		if (!text || isLoading) return;

		const userMessage: FeedbackMessage = { role: 'user', content: text, timestamp: Date.now() };
		const updatedMessages = [...messages, userMessage];
		setMessages(updatedMessages);
		setInputValue('');
		setIsLoading(true);

		try {
			const response = await managerRef.current.sendMessage(text, updatedMessages, {
				onComplete: (r) => {
					setConfidence(r.confidence);
					setIsReady(r.ready);
					setLastResponse(r);
				},
			});

			setMessages((prev) => [
				...prev,
				{
					role: 'assistant',
					content: response.message,
					timestamp: Date.now(),
					confidence: response.confidence,
					category: response.category,
					summary: response.summary,
				},
			]);
		} catch {
			setMessages((prev) => [
				...prev,
				{
					role: 'assistant',
					content: 'Something went wrong. Please try again.',
					timestamp: Date.now(),
				},
			]);
		} finally {
			setIsLoading(false);
			inputRef.current?.focus();
		}
	}, [inputValue, isLoading, messages]);

	// --- Create new issue (skipping or after matching) ---
	const createNewIssue = useCallback(async () => {
		if (!lastResponse) return;
		setStep('submitting');
		setSubmitError('');

		try {
			const result = await window.maestro.feedback.submitConversation({
				category: lastResponse.category,
				summary: lastResponse.summary,
				expectedBehavior: lastResponse.structured.expectedBehavior,
				actualBehavior: lastResponse.structured.actualBehavior,
				reproductionSteps: lastResponse.structured.reproductionSteps || undefined,
				additionalContext: lastResponse.structured.additionalContext || undefined,
				attachments: attachments.map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
				includeDebugPackage,
			});

			if (result.success) {
				setCreatedIssueUrl(result.issueUrl ?? null);
				setStep('done');
			} else {
				setSubmitError(result.error || 'Failed to submit feedback.');
				setStep('chat');
			}
		} catch (error) {
			setSubmitError(error instanceof Error ? error.message : 'Submission failed.');
			setStep('chat');
		}
	}, [lastResponse, attachments, includeDebugPackage]);

	// --- Submit: always search first, then show matches or create ---
	const searchAndSubmit = useCallback(async () => {
		if (!lastResponse || !isReady) return;
		setSubmitError('');
		setStep('matching');

		// If search already completed with results, just show them
		if (!searchingIssues && matchingIssues.length > 0) {
			return;
		}

		// If search is already running, the matching UI will show spinner
		// and auto-proceed via the useEffect when it completes
		if (searchingIssues) {
			return;
		}

		// Search hasn't run yet (race condition) — run it now
		const query = lastResponse.summary || lastResponse.structured.expectedBehavior;
		if (query) {
			await runIssueSearch(query);
			// After search: if matches were found, the matching UI is already showing them.
			// If no matches, the auto-proceed useEffect will call createNewIssue.
		} else {
			// No query available — create directly
			await createNewIssue();
		}
	}, [lastResponse, isReady, matchingIssues, searchingIssues, runIssueSearch, createNewIssue]);

	// --- Auto-proceed from matching step when search completes with no results ---
	useEffect(() => {
		if (step !== 'matching' || searchingIssues) return;
		if (matchingIssues.length === 0) {
			// Search finished with no matches — create issue directly
			void createNewIssue();
		}
	}, [step, searchingIssues, matchingIssues, createNewIssue]);

	// --- Subscribe to an existing issue ---
	const subscribeToIssue = useCallback(
		async (issue: ExistingIssue) => {
			if (!lastResponse) return;
			setSubscribingTo(issue.number);
			setSubmitError('');

			try {
				// Build a comment from the conversation context
				const comment = [
					`**Related feedback from Maestro in-app:**`,
					'',
					lastResponse.structured.expectedBehavior
						? `**${lastResponse.category === 'bug_report' ? 'Expected' : 'Desired outcome'}:** ${lastResponse.structured.expectedBehavior}`
						: null,
					lastResponse.structured.actualBehavior
						? `**${lastResponse.category === 'bug_report' ? 'Actual behavior' : 'Details'}:** ${lastResponse.structured.actualBehavior}`
						: null,
					lastResponse.structured.additionalContext
						? `**Context:** ${lastResponse.structured.additionalContext}`
						: null,
				]
					.filter(Boolean)
					.join('\n');

				const result = await window.maestro.feedback.subscribeIssue(issue.number, comment);
				if (result.success) {
					setStep('done');
				} else {
					setSubmitError(result.error || 'Failed to subscribe to issue.');
				}
			} catch (error) {
				setSubmitError(error instanceof Error ? error.message : 'Failed to subscribe.');
			} finally {
				setSubscribingTo(null);
			}
		},
		[lastResponse]
	);

	// --- Attachment handling ---
	const addFiles = useCallback(
		async (files: File[]) => {
			const remaining = MAX_ATTACHMENTS - attachments.length;
			const toAdd = files
				.filter((f) => f.type.startsWith('image/') && f.size <= MAX_ATTACHMENT_BYTES)
				.slice(0, remaining);

			const newAttachments: FeedbackAttachment[] = [];
			for (const file of toAdd) {
				try {
					const dataUrl = await readFileAsDataUrl(file);
					newAttachments.push({
						id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
						name: file.name,
						dataUrl,
						sizeBytes: file.size,
					});
				} catch {
					// Skip failed reads
				}
			}
			if (newAttachments.length > 0) {
				setAttachments((prev) => [...prev, ...newAttachments]);
			}
		},
		[attachments.length]
	);

	const removeAttachment = useCallback((id: string) => {
		setAttachments((prev) => prev.filter((a) => a.id !== id));
	}, []);

	// --- Key handler ---
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
		},
		[sendMessage]
	);

	// ========================================================================
	// Render
	// ========================================================================

	// --- GH Check Failed ---
	if (!ghAuth.checking && !ghAuth.ok) {
		return (
			<div className="flex flex-col items-center gap-4 py-8 px-6 text-center">
				<AlertCircle className="w-10 h-10" style={{ color: theme.colors.warning }} />
				<div>
					<p className="text-sm font-semibold mb-1" style={{ color: theme.colors.textMain }}>
						GitHub CLI Required
					</p>
					<p className="text-xs leading-relaxed max-w-sm" style={{ color: theme.colors.textDim }}>
						{ghAuth.message ||
							'Inline feedback requires the GitHub CLI (gh) to be installed and authenticated locally.'}
					</p>
				</div>
				<button
					type="button"
					onClick={onCancel}
					className="px-4 py-2 rounded text-xs font-bold transition-colors hover:opacity-90"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					Close
				</button>
			</div>
		);
	}

	// --- Loading GH Check ---
	if (ghAuth.checking) {
		return (
			<div className="flex flex-col items-center gap-3 py-8 px-6">
				<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.accent }} />
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Checking GitHub CLI...
				</p>
			</div>
		);
	}

	// --- Provider Selection ---
	if (step === 'provider-select') {
		return (
			<div className="flex flex-col gap-5 p-6">
				<div className="flex items-center gap-4">
					<div
						className="w-20 h-20 rounded-xl flex items-center justify-center shrink-0"
						style={{ backgroundColor: `${theme.colors.accent}20` }}
					>
						<MessageSquareHeart className="w-10 h-10" style={{ color: theme.colors.accent }} />
					</div>
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						Thank you for taking the time to give us feedback! Whether you're reporting an issue or
						recommending a feature, you'll work with an AI agent that will understand what you need
						and create a GitHub issue for us to act on.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					<label className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Agent
					</label>
					<ThemedSelect
						value={selectedAgent}
						options={availableTiles.map((tile) => ({
							value: tile.id,
							label: `${tile.name}${isBetaAgent(tile.id) ? ' (Beta)' : ''}`,
						}))}
						onChange={(v) => setSelectedAgent(v as ToolType)}
						theme={theme}
					/>
					{availableTiles.length === 0 && (
						<p className="text-xs" style={{ color: theme.colors.warning }}>
							No supported agents detected. Install Claude Code, Codex, or OpenCode.
						</p>
					)}
				</div>

				{submitError && (
					<p className="text-xs" style={{ color: theme.colors.warning }}>
						{submitError}
					</p>
				)}

				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-2 rounded text-xs transition-colors hover:bg-white/5"
						style={{ color: theme.colors.textDim }}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={startConversation}
						disabled={availableTiles.length === 0}
						className="px-4 py-2 rounded text-xs font-bold transition-colors hover:opacity-90 disabled:opacity-40"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					>
						Start
					</button>
				</div>
			</div>
		);
	}

	// --- Done ---
	if (step === 'done') {
		const issueNumber = createdIssueUrl?.match(/\/issues\/(\d+)/)?.[1];

		return (
			<div className="flex flex-col items-center gap-4 py-8 px-6 text-center">
				<div
					className="w-12 h-12 rounded-full flex items-center justify-center"
					style={{ backgroundColor: `${theme.colors.success}20` }}
				>
					<Check className="w-6 h-6" style={{ color: theme.colors.success }} />
				</div>
				<div>
					<p className="text-sm font-semibold mb-1" style={{ color: theme.colors.textMain }}>
						Feedback Submitted
					</p>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						{createdIssueUrl
							? `Issue #${issueNumber ?? ''} has been created. Thank you!`
							: 'Your feedback has been recorded. Thank you!'}
					</p>
				</div>

				{/* Issue link + copy */}
				{createdIssueUrl && (
					<div
						className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textDim,
							maxWidth: '100%',
						}}
					>
						<span className="truncate flex-1 text-left" title={createdIssueUrl}>
							{createdIssueUrl}
						</span>
						<button
							type="button"
							onClick={async () => {
								const ok = await safeClipboardWrite(createdIssueUrl);
								if (ok) {
									setCopiedUrl(true);
									setTimeout(() => setCopiedUrl(false), 2000);
								}
							}}
							className="p-1 rounded transition-colors hover:bg-white/10 shrink-0"
							style={{ color: copiedUrl ? theme.colors.success : theme.colors.textDim }}
							title="Copy issue URL"
						>
							{copiedUrl ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
						</button>
						<button
							type="button"
							onClick={() => window.maestro.shell.openExternal(createdIssueUrl)}
							className="p-1 rounded transition-colors hover:bg-white/10 shrink-0"
							style={{ color: theme.colors.textDim }}
							title="Open in browser"
						>
							<ExternalLink className="w-3.5 h-3.5" />
						</button>
					</div>
				)}

				<button
					type="button"
					onClick={onCancel}
					className="px-4 py-2 rounded text-xs font-bold transition-colors hover:opacity-90"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					Close
				</button>
			</div>
		);
	}

	// --- Matching existing issues ---
	if (step === 'matching') {
		return (
			<div className="flex flex-col gap-4 p-6">
				{searchingIssues ? (
					<div className="flex flex-col items-center gap-3 py-8">
						<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.accent }} />
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Searching for similar existing issues...
						</p>
					</div>
				) : (
					<>
						<div>
							<p className="text-sm font-semibold mb-1" style={{ color: theme.colors.textMain }}>
								We found similar issues
							</p>
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								Does any of these match what you&apos;re reporting? Subscribing adds your context as
								a comment and a +1 reaction, helping us prioritize.
							</p>
						</div>

						<div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
							{matchingIssues.map((issue) => (
								<div
									key={issue.number}
									className="flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgMain,
									}}
								>
									<div className="flex-1 min-w-0">
										<p
											className="text-xs font-semibold truncate"
											style={{ color: theme.colors.textMain }}
											title={issue.title}
										>
											#{issue.number} {issue.title}
										</p>
										<div className="flex items-center gap-2 mt-0.5">
											<span
												className="text-[10px] px-1.5 py-0.5 rounded-full"
												style={{
													backgroundColor:
														issue.state === 'OPEN'
															? `${theme.colors.success}20`
															: `${theme.colors.textDim}20`,
													color:
														issue.state === 'OPEN' ? theme.colors.success : theme.colors.textDim,
												}}
											>
												{issue.state === 'OPEN' ? 'Open' : 'Closed'}
											</span>
											<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
												by {issue.author}
											</span>
										</div>
									</div>
									<div className="flex items-center gap-1.5 shrink-0">
										<button
											type="button"
											className="p-1.5 rounded transition-colors hover:bg-white/5"
											style={{ color: theme.colors.textDim }}
											title="View on GitHub"
											onClick={() => window.maestro.shell.openExternal(issue.url)}
										>
											<ExternalLink className="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											onClick={() => subscribeToIssue(issue)}
											disabled={subscribingTo !== null}
											className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold transition-colors hover:opacity-90 disabled:opacity-40"
											style={{
												backgroundColor: theme.colors.accent,
												color: theme.colors.accentForeground,
											}}
											title="Subscribe and add your feedback as a comment"
										>
											{subscribingTo === issue.number ? (
												<Loader2 className="w-3 h-3 animate-spin" />
											) : (
												<ThumbsUp className="w-3 h-3" />
											)}
											+1
										</button>
									</div>
								</div>
							))}
						</div>

						{submitError && (
							<p className="text-xs" style={{ color: theme.colors.error }}>
								{submitError}
							</p>
						)}

						<div
							className="flex items-center gap-2 pt-1"
							style={{ borderTop: `1px solid ${theme.colors.border}` }}
						>
							<button
								type="button"
								onClick={() => {
									setStep('chat');
									setMatchingIssues([]);
								}}
								className="px-3 py-2 rounded text-xs transition-colors hover:bg-white/5"
								style={{ color: theme.colors.textDim }}
							>
								Back to chat
							</button>
							<div className="flex-1" />
							<button
								type="button"
								onClick={createNewIssue}
								disabled={subscribingTo !== null}
								className="flex items-center gap-1.5 px-3 py-2 rounded text-xs font-bold transition-colors hover:opacity-90 disabled:opacity-40"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								<PlusCircle className="w-3.5 h-3.5" />
								Create new issue anyway
							</button>
						</div>
					</>
				)}
			</div>
		);
	}

	// --- Chat + Submitting ---
	return (
		<div className="flex flex-col h-full min-h-0 relative feedback-chat">
			{/* Prose styles for markdown rendering */}
			<style>{proseStyles}</style>

			{/* ── TOP: Fixed confidence bar ── */}
			<div
				className="shrink-0 px-4 pb-2 pt-3"
				style={{ borderBottom: `1px solid ${theme.colors.border}` }}
			>
				<div className="flex items-center gap-2 mb-1.5">
					<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
						Understanding:{' '}
						<strong style={{ color: getConfidenceColor(confidence) }}>{confidence}%</strong>
					</span>
					{/* Search status indicator */}
					{searchingIssues && (
						<span
							className="flex items-center gap-1 text-[10px]"
							style={{ color: theme.colors.textDim }}
						>
							<Loader2 className="w-3 h-3 animate-spin" />
							Checking for similar issues...
						</span>
					)}
					{!searchingIssues && matchingIssues.length > 0 && (
						<span className="text-[10px]" style={{ color: theme.colors.warning }}>
							{matchingIssues.length} similar issue{matchingIssues.length !== 1 ? 's' : ''} found
						</span>
					)}
					<div className="flex-1" />
					{isReady && (
						<button
							type="button"
							onClick={searchAndSubmit}
							disabled={isLoading || step === 'submitting'}
							className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold transition-colors hover:opacity-90 disabled:opacity-40 shrink-0"
							style={{ backgroundColor: theme.colors.success, color: '#000' }}
						>
							{step === 'submitting' ? (
								<Loader2 className="w-3 h-3 animate-spin" />
							) : (
								<Check className="w-3 h-3" />
							)}
							Submit Feedback
						</button>
					)}
				</div>
				<div
					className="h-1.5 rounded-full overflow-hidden"
					style={{ backgroundColor: theme.colors.border }}
				>
					<div
						className="h-full rounded-full transition-all duration-500"
						style={{
							width: `${confidence}%`,
							backgroundColor: getConfidenceColor(confidence),
						}}
					/>
				</div>
			</div>

			{/* ── MIDDLE: Scrollable messages ── */}
			<div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-3">
				{messages.map((msg, i) => (
					<div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
						{msg.role === 'user' ? (
							<div
								className="max-w-[85%] px-3 py-2 rounded-lg text-sm leading-relaxed"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								{msg.content}
							</div>
						) : (
							<div
								className="max-w-[85%] px-3 py-2 rounded-lg text-sm overflow-hidden"
								style={{
									backgroundColor: theme.colors.bgMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<MarkdownRenderer content={msg.content} theme={theme} onCopy={copyToClipboard} />
							</div>
						)}
					</div>
				))}
				{isLoading && (
					<div className="flex justify-start">
						<div
							className="px-3 py-2 rounded-lg"
							style={{
								backgroundColor: theme.colors.bgMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.accent }} />
						</div>
					</div>
				)}

				{/* Inline similar issues card — appears during chat when matches are found */}
				{step === 'chat' && !searchingIssues && matchingIssues.length > 0 && (
					<div
						className="rounded-lg border px-3 py-3"
						style={{
							backgroundColor: `${theme.colors.warning}08`,
							borderColor: `${theme.colors.warning}40`,
						}}
					>
						<p className="text-xs font-semibold mb-2" style={{ color: theme.colors.textMain }}>
							Similar existing issues found — does any of these match?
						</p>
						<div className="flex flex-col gap-1.5">
							{matchingIssues.slice(0, 5).map((issue) => (
								<div
									key={issue.number}
									className="flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors hover:bg-white/5"
									style={{ border: `1px solid ${theme.colors.border}` }}
								>
									<span
										className="text-[10px] px-1 py-0.5 rounded-full shrink-0"
										style={{
											backgroundColor:
												issue.state === 'OPEN'
													? `${theme.colors.success}20`
													: `${theme.colors.textDim}20`,
											color: issue.state === 'OPEN' ? theme.colors.success : theme.colors.textDim,
										}}
									>
										{issue.state === 'OPEN' ? 'Open' : 'Closed'}
									</span>
									<span
										className="text-xs flex-1 truncate"
										style={{ color: theme.colors.textMain }}
										title={issue.title}
									>
										#{issue.number} {issue.title}
									</span>
									<button
										type="button"
										onClick={() => window.maestro.shell.openExternal(issue.url)}
										className="p-1 rounded transition-colors hover:bg-white/10 shrink-0"
										style={{ color: theme.colors.textDim }}
										title="View on GitHub"
									>
										<ExternalLink className="w-3 h-3" />
									</button>
									<button
										type="button"
										onClick={() => subscribeToIssue(issue)}
										disabled={subscribingTo !== null}
										className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold transition-colors hover:opacity-90 disabled:opacity-40 shrink-0"
										style={{
											backgroundColor: theme.colors.accent,
											color: theme.colors.accentForeground,
										}}
										title="Subscribe and add your feedback as a comment"
									>
										{subscribingTo === issue.number ? (
											<Loader2 className="w-3 h-3 animate-spin" />
										) : (
											<ThumbsUp className="w-3 h-3" />
										)}
										+1
									</button>
								</div>
							))}
						</div>
						<button
							type="button"
							onClick={() => setMatchingIssues([])}
							className="mt-2 text-[10px] transition-colors hover:underline"
							style={{ color: theme.colors.textDim }}
						>
							None of these match — I have a new issue
						</button>
					</div>
				)}

				<div ref={messagesEndRef} />
			</div>

			{/* ── BOTTOM: Fixed controls ── */}
			<div
				className="shrink-0 pt-2 pb-3 px-4 border-t"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Screenshots row */}
				<div className="pb-2">
					{/* Attachment thumbnails */}
					{attachments.length > 0 && (
						<div className="flex gap-2 flex-wrap mb-2">
							{attachments.map((a) => (
								<div
									key={a.id}
									className="relative group rounded-lg overflow-hidden"
									style={{ border: `1px solid ${theme.colors.border}` }}
								>
									<img src={a.dataUrl} alt={a.name} className="h-12 w-16 object-cover" />
									<button
										type="button"
										onClick={() => removeAttachment(a.id)}
										className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
									>
										<X className="w-3 h-3 text-white" />
									</button>
								</div>
							))}
						</div>
					)}

					{/* Drop zone */}
					{attachments.length < MAX_ATTACHMENTS && (
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							disabled={step === 'submitting'}
							className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
							style={{
								borderColor: isDragging ? theme.colors.accent : theme.colors.border,
								backgroundColor: isDragging ? `${theme.colors.accent}10` : 'transparent',
							}}
							onDragOver={(e) => {
								e.preventDefault();
								e.stopPropagation();
								setIsDragging(true);
							}}
							onDragLeave={(e) => {
								e.stopPropagation();
								setIsDragging(false);
							}}
							onDrop={(e) => {
								e.preventDefault();
								e.stopPropagation();
								setIsDragging(false);
								const files = Array.from(e.dataTransfer.files);
								if (files.length > 0) void addFiles(files);
							}}
						>
							<ImagePlus className="w-4 h-4" style={{ color: theme.colors.textDim }} />
							<div className="text-left">
								<p className="text-xs font-semibold" style={{ color: theme.colors.textDim }}>
									Drag screenshots here or click to browse
								</p>
								<p className="text-[10px]" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
									PNG, JPG, GIF, or WebP. Up to {MAX_ATTACHMENTS} images, 10 MB each.
								</p>
							</div>
						</button>
					)}
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						multiple
						className="hidden"
						onChange={(e) => {
							const files = Array.from(e.target.files || []);
							if (files.length > 0) void addFiles(files);
							e.target.value = '';
						}}
					/>
				</div>

				{/* Support package + error */}
				<div className="pb-2 flex items-center gap-3">
					<label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0">
						<input
							type="checkbox"
							checked={includeDebugPackage}
							onChange={(e) => setIncludeDebugPackage(e.target.checked)}
							className="rounded"
							style={{ accentColor: theme.colors.accent }}
						/>
						<Package className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							Include support package
						</span>
					</label>
					{submitError && (
						<p
							className="text-[10px] truncate"
							style={{ color: theme.colors.error }}
							title={submitError}
						>
							{submitError}
						</p>
					)}
				</div>

				{/* Text input + send + submit */}
				<div>
					<div
						className="flex items-end gap-2 rounded-lg border px-3 py-2"
						style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
					>
						<textarea
							ref={inputRef}
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={
								isReady ? 'Add more details, or click Submit...' : 'Describe your issue or idea...'
							}
							disabled={step === 'submitting'}
							rows={1}
							className="flex-1 bg-transparent outline-none resize-none text-sm leading-relaxed overflow-y-auto"
							style={{ color: theme.colors.textMain }}
						/>
						{/* Send message button — always available */}
						<button
							type="button"
							onClick={sendMessage}
							disabled={!inputValue.trim() || isLoading || step === 'submitting'}
							className="p-1.5 rounded transition-colors hover:opacity-80 disabled:opacity-30 shrink-0"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
							title="Send message"
						>
							{isLoading ? (
								<Loader2 className="w-4 h-4 animate-spin" />
							) : (
								<Send className="w-4 h-4" />
							)}
						</button>
						{/* Submit button — appears when ready */}
						{isReady && (
							<button
								type="button"
								onClick={searchAndSubmit}
								disabled={isLoading || step === 'submitting'}
								className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-bold transition-colors hover:opacity-90 disabled:opacity-40 shrink-0"
								style={{ backgroundColor: theme.colors.success, color: '#000' }}
								title="Submit feedback as GitHub issue"
							>
								{step === 'submitting' ? (
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
								) : (
									<Check className="w-3.5 h-3.5" />
								)}
								Submit
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
