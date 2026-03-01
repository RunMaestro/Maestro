import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, Copy, Zap } from 'lucide-react';
import { Modal, ModalFooter } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
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
# settings:
#   timeout_minutes: 30
#   timeout_on_fail: break
#   max_concurrent: 1
#   queue_size: 10
`;

const AI_SYSTEM_PROMPT = `You are a Maestro Cue configuration generator. Generate valid maestro-cue.yaml content based on the user's description.

Available event types:
- time.interval: Runs on a timer. Requires \`interval_minutes\`.
- file.changed: Runs when files matching a glob pattern change. Requires \`watch\` (glob pattern).
- agent.completed: Runs when another agent session completes. Requires \`source_session\` (name or array for fan-in). Optional \`fan_out\` array to trigger multiple sessions.

YAML format:
subscriptions:
  - name: "descriptive name"
    event: time.interval | file.changed | agent.completed
    interval_minutes: N          # for time.interval
    watch: "glob/pattern/**"     # for file.changed
    source_session: "name"       # for agent.completed (string or string[])
    fan_out: ["name1", "name2"]  # optional, for agent.completed
    prompt: path/to/prompt.md    # relative to project root
    enabled: true

settings:
  timeout_minutes: 30
  timeout_on_fail: break         # or "continue"
  max_concurrent: 1              # max simultaneous runs per session (1-10)
  queue_size: 10                 # max queued events per session (0-50)

Output ONLY the YAML content, no markdown code fences, no explanation.`;

const AI_PLACEHOLDER =
	'Watch for changes in src/ and run a code review every time a TypeScript file is modified. Also run a security audit every 2 hours.';

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
	const [aiDescription, setAiDescription] = useState('');
	const [validationErrors, setValidationErrors] = useState<string[]>([]);
	const [isValid, setIsValid] = useState(true);
	const [loading, setLoading] = useState(true);
	const [copied, setCopied] = useState(false);
	const validateTimerRef = useRef<ReturnType<typeof setTimeout>>();
	const yamlTextareaRef = useRef<HTMLTextAreaElement>(null);

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

	const handleCopyPrompt = useCallback(async () => {
		const fullPrompt = `${AI_SYSTEM_PROMPT}\n\n---\n\nUser request:\n${aiDescription}`;
		try {
			await navigator.clipboard.writeText(fullPrompt);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API may fail in some contexts
		}
	}, [aiDescription]);

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
				// Restore cursor position after React re-renders
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
			width={960}
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
						onConfirm={handleSave}
						confirmLabel="Save"
						confirmDisabled={!isValid || !isDirty}
					/>
				</div>
			}
		>
			{loading ? (
				<div className="text-center py-12 text-sm" style={{ color: theme.colors.textDim }}>
					Loading YAML...
				</div>
			) : (
				<div className="flex gap-4" style={{ minHeight: 400 }}>
					{/* Left side: AI input (40%) */}
					<div className="flex flex-col gap-3" style={{ width: '40%' }}>
						<h3
							className="text-xs font-bold uppercase tracking-wider"
							style={{ color: theme.colors.textDim }}
						>
							AI Assist
						</h3>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Describe what you want your agent to do, then copy the prompt to paste into any agent.
						</p>
						<textarea
							value={aiDescription}
							onChange={(e) => setAiDescription(e.target.value)}
							placeholder={AI_PLACEHOLDER}
							className="flex-1 w-full p-3 rounded border bg-transparent outline-none text-sm resize-none"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								minHeight: 160,
							}}
							data-testid="ai-description-input"
						/>
						<button
							onClick={handleCopyPrompt}
							disabled={!aiDescription.trim()}
							className="flex items-center justify-center gap-2 px-3 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							style={{
								backgroundColor: aiDescription.trim() ? CUE_TEAL : theme.colors.bgActivity,
								color: aiDescription.trim() ? '#fff' : theme.colors.textDim,
							}}
							data-testid="copy-prompt-button"
						>
							<Copy className="w-3.5 h-3.5" />
							{copied ? 'Copied!' : 'Copy Prompt to Clipboard'}
						</button>
					</div>

					{/* Divider */}
					<div className="w-px self-stretch" style={{ backgroundColor: theme.colors.border }} />

					{/* Right side: YAML editor (60%) */}
					<div className="flex flex-col gap-3" style={{ width: '60%' }}>
						<h3
							className="text-xs font-bold uppercase tracking-wider"
							style={{ color: theme.colors.textDim }}
						>
							YAML Configuration
						</h3>
						<div
							className="flex-1 flex rounded border overflow-hidden"
							style={{ borderColor: theme.colors.border }}
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
								spellCheck={false}
								className="flex-1 py-3 px-3 bg-transparent outline-none text-sm resize-none font-mono leading-[1.35rem]"
								style={{ color: theme.colors.textMain }}
								data-testid="yaml-editor"
							/>
						</div>

						{/* Validation errors */}
						{!isValid && validationErrors.length > 0 && (
							<div
								className="rounded px-3 py-2 text-xs space-y-1"
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
