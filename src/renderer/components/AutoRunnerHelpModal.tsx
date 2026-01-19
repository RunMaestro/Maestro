import {
	FolderOpen,
	FileText,
	CheckSquare,
	Play,
	Settings,
	History,
	Eye,
	Square,
	Keyboard,
	Repeat,
	RotateCcw,
	BookMarked,
	Image,
	Variable,
} from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

interface AutoRunnerHelpModalProps {
	theme: Theme;
	onClose: () => void;
}

export function AutoRunnerHelpModal({ theme, onClose }: AutoRunnerHelpModalProps) {
	return (
		<Modal
			theme={theme}
			title="Auto Run Guide"
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			width={672}
			maxHeight="85vh"
			closeOnBackdropClick
			zIndex={50}
			footer={
				<button
					onClick={onClose}
					className="px-4 py-2 rounded text-sm font-medium transition-colors hover:opacity-90"
					style={{
						backgroundColor: theme.colors.accent,
						color: 'white',
					}}
				>
					Got it
				</button>
			}
		>
			<div className="space-y-6" style={{ color: theme.colors.textMain }}>
				{/* Introduction */}
				<section>
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
						Auto Run is a file-system-based document runner that automates AI-driven task execution.
						Create markdown documents with checkbox tasks, and let AI agents work through them one
						by one, each with a fresh context window. Run single documents or chain multiple
						documents together for complex workflows.
					</p>
				</section>

				{/* Setting Up */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<FolderOpen className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Setting Up a Runner Docs Folder</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							When you first open the Auto Run tab, you'll be prompted to select a folder containing
							your task documents. This folder will store all your markdown files with tasks to
							automate.
						</p>
						<p>
							You can change this folder at any time by clicking{' '}
							<strong style={{ color: theme.colors.textMain }}>"Change Folder"</strong> in the
							document dropdown.
						</p>
					</div>
				</section>

				{/* Document Format */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<FileText className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Document Format</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Create markdown files (<code>.md</code>) in your Runner Docs folder. Each file can
							contain multiple tasks defined as markdown checkboxes:
						</p>
						<div
							className="font-mono text-xs p-3 rounded border"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							# Feature Plan
							<br />
							<br />
							- [ ] Implement user authentication
							<br />
							- [ ] Add unit tests for the login flow
							<br />
							- [ ] Update API documentation
							<br />- [ ] Review and optimize database queries
						</div>
						<p>
							Tasks are processed from top to bottom. When an AI agent completes a task, it checks
							off the box (<code>- [x]</code>) and exits. The next agent picks up the next unchecked
							task.
						</p>
					</div>
				</section>

				{/* Creating Tasks */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<CheckSquare className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Creating Tasks</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<div
							className="flex items-center gap-2 px-3 py-2 rounded"
							style={{ backgroundColor: theme.colors.accent + '15' }}
						>
							<Keyboard className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span>
								<strong style={{ color: theme.colors.textMain }}>Quick Insert:</strong> Press{' '}
								<kbd
									className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									{formatShortcutKeys(['Meta', 'l'])}
								</kbd>{' '}
								to insert a new checkbox at your cursor.
							</span>
						</div>
						<p>
							Write clear, specific task descriptions. Each task should be independently
							completable—the AI starts fresh for each one without context from previous tasks.
						</p>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Tip:</strong> Prefix tasks with
							unique identifiers (e.g., <code>FEAT-001:</code>) for easy tracking in history logs.
						</p>
					</div>
				</section>

				{/* Image Attachments */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Image className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Image Attachments</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Paste images directly into your documents or click the camera button to attach files.
							Images are saved to an <code>images/</code> subfolder and linked with relative paths.
						</p>
						<p>
							Use images to provide visual context—screenshots of bugs, UI mockups, diagrams, or
							reference materials that help the AI understand the task.
						</p>
					</div>
				</section>

				{/* Running Single Document */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Play className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Running a Single Document</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Click <strong style={{ color: theme.colors.textMain }}>Run</strong> to configure
							auto-run. By default, the currently selected document is ready to run.
						</p>
						<p>
							The runner spawns a fresh AI session for each unchecked task. When a task completes,
							the agent checks it off and exits. If tasks remain, another agent is spawned for the
							next task.
						</p>
						<p>
							The document is provided to the agent as a file path, giving it direct access to read
							and modify tasks.
						</p>
					</div>
				</section>

				{/* Running Multiple Documents */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Settings className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Running Multiple Documents</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Click <strong style={{ color: theme.colors.textMain }}>"+ Add Docs"</strong> in the
							configuration to select additional documents. Documents are processed sequentially in
							the order shown.
						</p>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Drag to reorder:</strong> Use the
							grip handle to rearrange documents in the queue.
						</p>
						<p>Documents with zero unchecked tasks are automatically skipped.</p>
					</div>
				</section>

				{/* Template Variables */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Variable className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Template Variables</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Use template variables in your documents and agent prompts to inject dynamic values at
							runtime. Variables are replaced with actual values before being sent to the AI.
						</p>
						<div
							className="flex items-center gap-2 px-3 py-2 rounded"
							style={{ backgroundColor: theme.colors.accent + '15' }}
						>
							<Keyboard className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span>
								<strong style={{ color: theme.colors.textMain }}>Quick Insert:</strong> Type{' '}
								<code
									className="px-1.5 py-0.5 rounded text-xs font-mono"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									{'{{'}
								</code>{' '}
								to open an autocomplete dropdown with all available variables.
							</span>
						</div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Available variables:</strong>
						</p>
						<div
							className="font-mono text-xs p-3 rounded border space-y-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{AGENT_NAME}}'}</code> — Agent name
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{AGENT_PATH}}'}</code> — Agent home
								directory path
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{TAB_NAME}}'}</code> — Custom tab
								name
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{GIT_BRANCH}}'}</code> — Current git
								branch
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{DATE}}'}</code> — Current date
								(YYYY-MM-DD)
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{LOOP_NUMBER}}'}</code> — Current
								loop iteration
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{DOCUMENT_NAME}}'}</code> — Current
								document name
							</div>
							<div style={{ color: theme.colors.textDim }}>...and more</div>
						</div>
						<p>
							Variables work in both the{' '}
							<strong style={{ color: theme.colors.textMain }}>agent prompt</strong> (in Playbook
							settings) and within{' '}
							<strong style={{ color: theme.colors.textMain }}>document content</strong>. Use them
							to create reusable templates that adapt to different contexts.
						</p>
					</div>
				</section>

				{/* Reset on Completion */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<RotateCcw className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Reset on Completion</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Enable the reset toggle (<RotateCcw className="w-3 h-3 inline" />) on any document to
							keep it available for repeated runs. When enabled, Auto Run creates a{' '}
							<strong style={{ color: theme.colors.textMain }}>working copy</strong> in the{' '}
							<code>Runs/</code> subfolder and processes that copy—
							<em>the original document is never modified</em>.
						</p>
						<p>
							Working copies are named with timestamps (e.g.,{' '}
							<code>TASK-1735192800000-loop-1.md</code>) and serve as an audit log of each loop's
							work. You can delete them manually when no longer needed.
						</p>
						<p>
							Reset-enabled documents can be duplicated in the queue, allowing the same document to
							run multiple times in a single batch. Since originals are untouched, interruptions
							leave your source documents pristine.
						</p>
					</div>
				</section>

				{/* Loop Mode */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Repeat className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Loop Mode</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							When running multiple documents, enable{' '}
							<strong style={{ color: theme.colors.textMain }}>Loop</strong> to continuously cycle
							through the document queue until all documents have zero tasks remaining.
						</p>
						<p>
							Combined with reset-on-completion, this creates perpetual workflows—perfect for
							monitoring tasks, recurring maintenance, or continuous integration scenarios.
						</p>
					</div>
				</section>

				{/* Playbooks */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<BookMarked className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Playbooks</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Save your batch run configurations as{' '}
							<strong style={{ color: theme.colors.textMain }}>Playbooks</strong> for quick reuse. A
							playbook stores:
						</p>
						<ul className="list-disc ml-4 space-y-1">
							<li>Document selection and order</li>
							<li>Reset-on-completion settings per document</li>
							<li>Loop mode preference</li>
							<li>Custom agent prompt</li>
						</ul>
						<p>
							Load a saved playbook with one click and modify it as needed—changes can be saved back
							or discarded.
						</p>
					</div>
				</section>

				{/* History & Tracking */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<History className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">History & Tracking</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Completed tasks appear in the{' '}
							<strong style={{ color: theme.colors.textMain }}>History</strong> panel with an{' '}
							<span style={{ color: theme.colors.warning }}>AUTO</span> label.
						</p>
						<p>
							Click the session ID pill to jump directly to that AI conversation and review what the
							agent did. Use <code>/history</code> to add manual summaries.
						</p>
					</div>
				</section>

				{/* Read-Only Mode */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Eye className="w-5 h-5" style={{ color: theme.colors.warning }} />
						<h3 className="font-bold">Read-Only Mode</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							While Auto Run is active, the AI interpreter operates in{' '}
							<strong style={{ color: theme.colors.warning }}>read-only mode</strong>. You can send
							messages to analyze code, but file modifications queue until Auto Run completes.
						</p>
						<p>
							The input shows a <span style={{ color: theme.colors.warning }}>READ-ONLY</span>{' '}
							indicator as a reminder. This prevents conflicts between manual and automated work.
						</p>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Tip:</strong> For parallel work
							without read-only restrictions, create a worktree session from the git branch menu in
							the session list. Worktree sessions operate in isolated directories, allowing Auto Run
							and manual work to happen simultaneously.
						</p>
					</div>
				</section>

				{/* Stopping */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Square className="w-5 h-5" style={{ color: theme.colors.error }} />
						<h3 className="font-bold">Stopping Auto Run</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Click <strong style={{ color: theme.colors.error }}>Stop</strong> in the header or
							Auto Run panel to gracefully stop. The current task completes before stopping—no work
							is left incomplete.
						</p>
						<p>Completed tasks remain checked. Resume anytime by clicking Run again.</p>
					</div>
				</section>

				{/* Keyboard Shortcuts */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Keyboard className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Keyboard Shortcuts</h3>
					</div>
					<div className="text-sm pl-7" style={{ color: theme.colors.textDim }}>
						<div className="space-y-2">
							<div className="flex items-center gap-3">
								<kbd
									className="px-2 py-1 rounded text-xs font-mono font-bold min-w-[80px] text-center"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									{formatShortcutKeys(['Meta', 'Shift', '1'])}
								</kbd>
								<span>Open Auto Run tab</span>
							</div>
							<div className="flex items-center gap-3">
								<kbd
									className="px-2 py-1 rounded text-xs font-mono font-bold min-w-[80px] text-center"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									{formatShortcutKeys(['Meta', 'e'])}
								</kbd>
								<span>Toggle Edit/Preview mode</span>
							</div>
							<div className="flex items-center gap-3">
								<kbd
									className="px-2 py-1 rounded text-xs font-mono font-bold min-w-[80px] text-center"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									{formatShortcutKeys(['Meta', 'l'])}
								</kbd>
								<span>Insert checkbox at cursor</span>
							</div>
							<div className="flex items-center gap-3">
								<kbd
									className="px-2 py-1 rounded text-xs font-mono font-bold min-w-[80px] text-center"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									{formatShortcutKeys(['Meta', 'z'])}
								</kbd>
								<span>Undo</span>
							</div>
							<div className="flex items-center gap-3">
								<kbd
									className="px-2 py-1 rounded text-xs font-mono font-bold min-w-[80px] text-center"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									{formatShortcutKeys(['Meta', 'Shift', 'z'])}
								</kbd>
								<span>Redo</span>
							</div>
						</div>
					</div>
				</section>
			</div>
		</Modal>
	);
}
