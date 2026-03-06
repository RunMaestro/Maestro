import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, Zap, Send, Loader2 } from 'lucide-react';
import { Modal, ModalFooter } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { CUE_PATTERNS } from '../constants/cuePatterns';
import { useSessionStore, selectSessionById } from '../stores/sessionStore';
import { buildSpawnConfigForAgent } from '../utils/sessionHelpers';
import type { Theme } from '../types';

const CUE_TEAL = '#06b6d4';

const YAML_TEMPLATE = `# maestro-cue.yaml
# Define event-driven subscriptions for your agents.
#
# subscriptions:
#   - name: "code review on change"
#     event: file.changed
#     watch: "src/**/*.ts"
#     prompt: prompts/review.md
#     enabled: true
#
#   - name: "hourly security audit"
#     event: time.interval
#     interval_minutes: 60
#     prompt: prompts/security-audit.md
#     enabled: true
#
#   - name: "deploy after tests pass"
#     event: agent.completed
#     source_session: "test-runner"
#     prompt: prompts/deploy.md
#     enabled: true
#
#   - name: "review new PRs"
#     event: github.pull_request
#     poll_minutes: 5
#     prompt: prompts/pr-review.md
#     enabled: true
#
#   - name: "triage issues"
#     event: github.issue
#     poll_minutes: 10
#     prompt: prompts/issue-triage.md
#     enabled: true
#
#   - name: "process task queue"
#     event: task.pending
#     watch: "tasks/**/*.md"
#     poll_minutes: 1
#     prompt: prompts/process-task.md
#     enabled: true
#
# settings:
#   timeout_minutes: 30
#   timeout_on_fail: break
#   max_concurrent: 1
#   queue_size: 10
`;

const AI_SYSTEM_PROMPT = `You are configuring maestro-cue.yaml for the user. Be terse. Plain text only — no markdown, no code fences, no bullet lists, no formatting.

Event types: time.interval (interval_minutes), file.changed (watch glob), agent.completed (source_session, optional fan_out), github.pull_request (poll_minutes, optional repo), github.issue (poll_minutes, optional repo), task.pending (watch glob, poll_minutes).

Optional filter block on any subscription: AND'd conditions on payload fields. Operators: exact string, "!value" negation, ">N"/"<N" numeric, glob patterns, boolean.

YAML structure:
subscriptions:
  - name: "descriptive name"
    event: <type>
    <type-specific fields>
    filter: {field: value}  # optional
    prompt: path/to/prompt.md
    enabled: true
settings:
  timeout_minutes: 30
  timeout_on_fail: break | continue
  max_concurrent: 1
  queue_size: 10

Multi-agent patterns: Scheduled Task (time.interval), File Enrichment (file.changed), Research Swarm (fan_out + fan-in), Sequential Chain (agent.completed chain), Debate (fan_out to opposing + fan-in to moderator), PR Review (github.pull_request), Issue Triage (github.issue), Task Queue (task.pending).

Edit the file directly using your tools. After editing, summarize what you changed in 1-2 short sentences. If you need clarification, ask briefly.`;

const AI_PLACEHOLDER = 'Describe what you want to automate...';

interface ChatMessage {
	role: 'user' | 'assistant';
	text: string;
}

interface CueYamlEditorProps {
	isOpen: boolean;
	onClose: () => void;
	projectRoot: string;
	sessionId: string;
	theme: Theme;
}

export function CueYamlEditor({
	isOpen,
	onClose,
	projectRoot,
	sessionId,
	theme,
}: CueYamlEditorProps) {
	const [yamlContent, setYamlContent] = useState('');
	const [originalContent, setOriginalContent] = useState('');
	const [validationErrors, setValidationErrors] = useState<string[]>([]);
	const [isValid, setIsValid] = useState(true);
	const [loading, setLoading] = useState(true);

	// Chat state
	const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
	const [chatInput, setChatInput] = useState('');
	const [chatBusy, setChatBusy] = useState(false);
	const agentSessionIdRef = useRef<string | null>(null);
	const spawnSessionIdRef = useRef<string>(`${sessionId}-cue-assist-${Date.now()}`);
	const aiCleanupRef = useRef<(() => void)[]>([]);
	const aiResponseRef = useRef('');
	const chatEndRef = useRef<HTMLDivElement>(null);

	const validateTimerRef = useRef<ReturnType<typeof setTimeout>>();
	const yamlTextareaRef = useRef<HTMLTextAreaElement>(null);

	const session = useSessionStore(selectSessionById(sessionId));

	// Load existing YAML on mount
	useEffect(() => {
		if (!isOpen) return;
		let cancelled = false;

		async function loadYaml() {
			setLoading(true);
			try {
				const content = await window.maestro.cue.readYaml(projectRoot);
				if (cancelled) return;
				const initial = content ?? YAML_TEMPLATE;
				setYamlContent(initial);
				setOriginalContent(initial);
				try {
					const validationResult = await window.maestro.cue.validateYaml(initial);
					if (!cancelled) {
						setIsValid(validationResult.valid);
						setValidationErrors(validationResult.errors);
					}
				} catch {
					// Validation failure on load is non-fatal
				}
			} catch {
				if (cancelled) return;
				setYamlContent(YAML_TEMPLATE);
				setOriginalContent(YAML_TEMPLATE);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}

		loadYaml();
		return () => {
			cancelled = true;
		};
	}, [isOpen, projectRoot]);

	// Reset chat state when modal opens
	useEffect(() => {
		if (isOpen) {
			setChatMessages([]);
			setChatInput('');
			setChatBusy(false);
			agentSessionIdRef.current = null;
			spawnSessionIdRef.current = `${sessionId}-cue-assist-${Date.now()}`;
		}
	}, [isOpen, sessionId]);

	// Cleanup AI assist listeners on unmount
	useEffect(() => {
		return () => {
			aiCleanupRef.current.forEach((fn) => fn());
			aiCleanupRef.current = [];
		};
	}, []);

	// Auto-scroll chat to bottom
	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [chatMessages, chatBusy]);

	// Debounced validation
	const validateYaml = useCallback((content: string) => {
		if (validateTimerRef.current) {
			clearTimeout(validateTimerRef.current);
		}
		validateTimerRef.current = setTimeout(async () => {
			try {
				const result = await window.maestro.cue.validateYaml(content);
				setIsValid(result.valid);
				setValidationErrors(result.errors);
			} catch {
				setIsValid(false);
				setValidationErrors(['Failed to validate YAML']);
			}
		}, 500);
	}, []);

	// Cleanup validation timer
	useEffect(() => {
		return () => {
			if (validateTimerRef.current) {
				clearTimeout(validateTimerRef.current);
			}
		};
	}, []);

	const handleYamlChange = useCallback(
		(value: string) => {
			setYamlContent(value);
			validateYaml(value);
		},
		[validateYaml]
	);

	const handleSave = useCallback(async () => {
		if (!isValid) return;
		try {
			await window.maestro.cue.writeYaml(projectRoot, yamlContent);
			await window.maestro.cue.refreshSession(sessionId, projectRoot);
			onClose();
		} catch {
			// Let Sentry capture unexpected errors
		}
	}, [isValid, projectRoot, yamlContent, sessionId, onClose]);

	const handleClose = useCallback(() => {
		const isDirty = yamlContent !== originalContent;
		if (isDirty) {
			const confirmed = window.confirm('You have unsaved changes. Discard them?');
			if (!confirmed) return;
		}
		onClose();
	}, [yamlContent, originalContent, onClose]);

	const handlePatternSelect = useCallback(
		(yaml: string) => {
			const editorDirty = yamlContent !== originalContent;
			if (editorDirty) {
				const confirmed = window.confirm(
					'Replace current YAML with this pattern? Unsaved changes will be lost.'
				);
				if (!confirmed) return;
			}
			setYamlContent(yaml);
			validateYaml(yaml);
		},
		[yamlContent, originalContent, validateYaml]
	);

	const refreshYamlFromDisk = useCallback(async () => {
		try {
			const content = await window.maestro.cue.readYaml(projectRoot);
			if (content) {
				setYamlContent(content);
				setOriginalContent(content);
				try {
					const result = await window.maestro.cue.validateYaml(content);
					setIsValid(result.valid);
					setValidationErrors(result.errors);
				} catch {
					// non-fatal
				}
			}
		} catch {
			// non-fatal
		}
	}, [projectRoot]);

	const handleChatSend = useCallback(async () => {
		const text = chatInput.trim();
		if (!text || !session || chatBusy) return;

		setChatInput('');
		setChatMessages((prev) => [...prev, { role: 'user', text }]);
		setChatBusy(true);
		aiResponseRef.current = '';

		const isFirstMessage = chatMessages.length === 0;
		const yamlPath = `${projectRoot}/maestro-cue.yaml`;

		// First message gets system prompt + file path; follow-ups are just the user text
		const prompt = isFirstMessage
			? `${AI_SYSTEM_PROMPT}\n\nThe config file is at: ${yamlPath}\n\n${text}`
			: text;

		try {
			const spawnConfig = await buildSpawnConfigForAgent({
				sessionId: spawnSessionIdRef.current,
				toolType: session.toolType,
				cwd: projectRoot,
				prompt,
				agentSessionId: agentSessionIdRef.current ?? undefined,
				sessionCustomPath: session.customPath,
				sessionCustomArgs: session.customArgs,
				sessionCustomEnvVars: session.customEnvVars,
				sessionCustomModel: session.customModel,
				sessionCustomContextWindow: session.customContextWindow,
				sessionSshRemoteConfig: session.sessionSshRemoteConfig,
			});

			if (!spawnConfig) {
				setChatMessages((prev) => [
					...prev,
					{ role: 'assistant', text: 'Agent not available. Is the agent installed?' },
				]);
				setChatBusy(false);
				return;
			}

			// Register listeners before spawning
			const cleanupData = window.maestro.process.onData((sid: string, data: string) => {
				if (sid === spawnSessionIdRef.current) {
					aiResponseRef.current += data;
				}
			});
			aiCleanupRef.current.push(cleanupData);

			const cleanupSessionId = window.maestro.process.onSessionId(
				(sid: string, capturedId: string) => {
					if (sid === spawnSessionIdRef.current) {
						agentSessionIdRef.current = capturedId;
					}
				}
			);
			aiCleanupRef.current.push(cleanupSessionId);

			const cleanupExit = window.maestro.process.onExit((sid: string) => {
				if (sid === spawnSessionIdRef.current) {
					aiCleanupRef.current.forEach((fn) => fn());
					aiCleanupRef.current = [];

					const response = aiResponseRef.current.trim() || 'Done.';
					setChatMessages((prev) => [...prev, { role: 'assistant', text: response }]);
					setChatBusy(false);

					// Refresh YAML from disk to pick up agent changes
					refreshYamlFromDisk();
				}
			});
			aiCleanupRef.current.push(cleanupExit);

			const cleanupError = window.maestro.process.onAgentError(
				(sid: string, error: { message: string }) => {
					if (sid === spawnSessionIdRef.current) {
						const msg = error.message || 'Agent encountered an error.';
						setChatMessages((prev) => [...prev, { role: 'assistant', text: msg }]);
						setChatBusy(false);
						aiCleanupRef.current.forEach((fn) => fn());
						aiCleanupRef.current = [];
					}
				}
			);
			aiCleanupRef.current.push(cleanupError);

			await window.maestro.process.spawn(spawnConfig);
		} catch {
			setChatMessages((prev) => [...prev, { role: 'assistant', text: 'Failed to start agent.' }]);
			setChatBusy(false);
			aiCleanupRef.current.forEach((fn) => fn());
			aiCleanupRef.current = [];
		}
	}, [chatInput, session, projectRoot, chatMessages.length, chatBusy, refreshYamlFromDisk]);

	const handleChatKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				handleChatSend();
			}
		},
		[handleChatSend]
	);

	// Handle Tab key in textarea for indentation
	const handleYamlKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Tab') {
				e.preventDefault();
				const textarea = e.currentTarget;
				const start = textarea.selectionStart;
				const end = textarea.selectionEnd;
				const indent = '  ';
				const newValue = yamlContent.substring(0, start) + indent + yamlContent.substring(end);
				setYamlContent(newValue);
				validateYaml(newValue);
				requestAnimationFrame(() => {
					textarea.selectionStart = textarea.selectionEnd = start + indent.length;
				});
			}
		},
		[yamlContent, validateYaml]
	);

	if (!isOpen) return null;

	const isDirty = yamlContent !== originalContent;

	return (
		<Modal
			theme={theme}
			title="Edit maestro-cue.yaml"
			priority={MODAL_PRIORITIES.CUE_YAML_EDITOR}
			onClose={handleClose}
			width={1200}
			maxHeight="85vh"
			closeOnBackdropClick={false}
			headerIcon={<Zap className="w-4 h-4" style={{ color: CUE_TEAL }} />}
			testId="cue-yaml-editor"
			footer={
				<div className="flex items-center justify-between w-full">
					<div className="flex items-center gap-2 text-xs">
						{isValid ? (
							<>
								<CheckCircle className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />
								<span style={{ color: theme.colors.success }}>Valid YAML</span>
							</>
						) : (
							<>
								<XCircle className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />
								<span style={{ color: theme.colors.error }}>
									{validationErrors.length} error{validationErrors.length !== 1 ? 's' : ''}
								</span>
							</>
						)}
					</div>
					<ModalFooter
						theme={theme}
						onCancel={handleClose}
						cancelLabel="Exit"
						onConfirm={handleSave}
						confirmLabel="Save"
						confirmDisabled={!isValid || !isDirty || chatBusy}
					/>
				</div>
			}
		>
			{loading ? (
				<div className="text-center py-12 text-sm" style={{ color: theme.colors.textDim }}>
					Loading YAML...
				</div>
			) : (
				<div className="flex gap-4" style={{ height: 'calc(85vh - 140px)', maxHeight: 600 }}>
					{/* Left side: Patterns + AI Chat (35%) */}
					<div className="flex flex-col gap-3 overflow-hidden" style={{ width: '35%' }}>
						<h3
							className="text-xs font-bold uppercase tracking-wider shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							Start from a pattern
						</h3>
						<div className="grid grid-cols-2 gap-1.5 shrink-0" data-testid="pattern-presets">
							{CUE_PATTERNS.map((pattern) => (
								<button
									key={pattern.id}
									onClick={() => handlePatternSelect(pattern.yaml)}
									disabled={chatBusy}
									className="text-left px-2 py-1.5 rounded border text-xs transition-colors hover:opacity-90 disabled:opacity-50"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										backgroundColor: theme.colors.bgActivity,
									}}
									data-testid={`pattern-${pattern.id}`}
								>
									<div className="font-medium truncate">{pattern.name}</div>
									<div
										className="truncate mt-0.5"
										style={{ color: theme.colors.textDim, fontSize: 10 }}
									>
										{pattern.description}
									</div>
								</button>
							))}
						</div>

						<div
							className="w-full border-t shrink-0"
							style={{ borderColor: theme.colors.border }}
						/>

						<h3
							className="text-xs font-bold uppercase tracking-wider shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							AI Assist
						</h3>

						{/* Chat history */}
						<div className="flex-1 overflow-y-auto min-h-0 space-y-2" data-testid="ai-chat-history">
							{chatMessages.length === 0 && !chatBusy && (
								<p className="text-xs" style={{ color: theme.colors.textDim }}>
									Describe what you want to automate. The agent will edit the config file and can
									answer questions.
								</p>
							)}
							{chatMessages.map((msg, i) => (
								<div
									key={i}
									className="rounded px-2.5 py-1.5 text-xs whitespace-pre-wrap"
									style={{
										backgroundColor:
											msg.role === 'user' ? `${CUE_TEAL}15` : theme.colors.bgActivity,
										color: theme.colors.textMain,
									}}
									data-testid={`chat-message-${msg.role}`}
								>
									{msg.text}
								</div>
							))}
							{chatBusy && (
								<div
									className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
									style={{ color: theme.colors.textDim }}
									data-testid="chat-busy-indicator"
								>
									<Loader2 className="w-3 h-3 animate-spin" />
									Agent is working...
								</div>
							)}
							<div ref={chatEndRef} />
						</div>

						{/* Chat input */}
						<div className="flex gap-1.5 shrink-0">
							<textarea
								value={chatInput}
								onChange={(e) => setChatInput(e.target.value)}
								onKeyDown={handleChatKeyDown}
								placeholder={AI_PLACEHOLDER}
								disabled={chatBusy}
								rows={2}
								className="flex-1 p-2 rounded border bg-transparent outline-none text-xs resize-none disabled:opacity-50"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								data-testid="ai-chat-input"
							/>
							<button
								onClick={handleChatSend}
								disabled={!chatInput.trim() || chatBusy}
								className="self-end p-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
								style={{
									backgroundColor:
										chatInput.trim() && !chatBusy ? CUE_TEAL : theme.colors.bgActivity,
									color: chatInput.trim() && !chatBusy ? '#fff' : theme.colors.textDim,
								}}
								data-testid="ai-chat-send"
							>
								<Send className="w-3.5 h-3.5" />
							</button>
						</div>
					</div>

					{/* Divider */}
					<div
						className="w-px self-stretch shrink-0"
						style={{ backgroundColor: theme.colors.border }}
					/>

					{/* Right side: YAML editor (65%) */}
					<div className="flex flex-col gap-3 overflow-hidden" style={{ width: '65%' }}>
						<h3
							className="text-xs font-bold uppercase tracking-wider shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							YAML Configuration
						</h3>
						<div
							className="flex-1 flex rounded border overflow-hidden min-h-0"
							style={{
								borderColor: theme.colors.border,
								opacity: chatBusy ? 0.5 : 1,
								pointerEvents: chatBusy ? 'none' : 'auto',
							}}
						>
							{/* Line numbers gutter */}
							<div
								className="py-3 px-2 text-right select-none font-mono text-xs leading-[1.35rem] overflow-hidden"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textDim,
									minWidth: 40,
								}}
								data-testid="line-numbers"
								aria-hidden="true"
							>
								{yamlContent.split('\n').map((_, i) => (
									<div key={i}>{i + 1}</div>
								))}
							</div>
							{/* Editor textarea */}
							<textarea
								ref={yamlTextareaRef}
								value={yamlContent}
								onChange={(e) => handleYamlChange(e.target.value)}
								onKeyDown={handleYamlKeyDown}
								readOnly={chatBusy}
								spellCheck={false}
								className="flex-1 py-3 px-3 bg-transparent outline-none text-sm resize-none font-mono leading-[1.35rem]"
								style={{ color: theme.colors.textMain }}
								data-testid="yaml-editor"
							/>
						</div>

						{/* Validation errors */}
						{!isValid && validationErrors.length > 0 && (
							<div
								className="rounded px-3 py-2 text-xs space-y-1 shrink-0"
								style={{ backgroundColor: `${theme.colors.error}15` }}
								data-testid="validation-errors"
							>
								{validationErrors.map((err, i) => (
									<div key={i} style={{ color: theme.colors.error }}>
										{err}
									</div>
								))}
							</div>
						)}
					</div>
				</div>
			)}
		</Modal>
	);
}
