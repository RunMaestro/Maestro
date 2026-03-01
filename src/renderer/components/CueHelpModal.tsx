import { Zap, FileText, Radio, Code, GitBranch, Clock, Sparkles, Layers } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

interface CueHelpModalProps {
	theme: Theme;
	onClose: () => void;
}

export function CueHelpModal({ theme, onClose }: CueHelpModalProps) {
	return (
		<Modal
			theme={theme}
			title="Maestro Cue Guide"
			priority={MODAL_PRIORITIES.CUE_HELP}
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
				{/* Section 1: What is Maestro Cue? */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Zap className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">What is Maestro Cue?</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Maestro Cue is an event-driven automation system. Define triggers in a YAML file, and
							Maestro automatically executes prompts against your AI agents when events occur. The
							conductor gives the cue — the agents respond.
						</p>
					</div>
				</section>

				{/* Section 2: Getting Started */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<FileText className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Getting Started</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Create a{' '}
							<code className="px-1 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>
								maestro-cue.yaml
							</code>{' '}
							file in your project root. Maestro auto-discovers it when the session loads.
						</p>
						<div
							className="flex items-center gap-2 px-3 py-2 rounded"
							style={{ backgroundColor: theme.colors.accent + '15' }}
						>
							<Sparkles className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
							<span>
								<strong style={{ color: theme.colors.textMain }}>Note:</strong> Maestro Cue is an
								Encore Feature. Enable it in Settings → Encore tab, then use the master toggle in
								the Cue dashboard to start/stop the engine.
							</span>
						</div>
						<div
							className="font-mono text-xs p-3 rounded border"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							subscriptions:
							<br />
							{'  '}- name: "My First Cue"
							<br />
							{'    '}event: time.interval
							<br />
							{'    '}interval_minutes: 30
							<br />
							{'    '}prompt: prompts/my-task.md
							<br />
							{'    '}enabled: true
						</div>
					</div>
				</section>

				{/* Section 3: Event Types */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Radio className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Event Types</h3>
					</div>
					<div className="text-sm space-y-3 pl-7" style={{ color: theme.colors.textDim }}>
						<div>
							<p>
								<strong style={{ color: theme.colors.textMain }}>Interval</strong>{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									time.interval
								</code>
							</p>
							<p className="mt-1">
								Runs your prompt on a timer. Set{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									interval_minutes
								</code>{' '}
								to control frequency.
							</p>
						</div>
						<div>
							<p>
								<strong style={{ color: theme.colors.textMain }}>File Watch</strong>{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									file.changed
								</code>
							</p>
							<p className="mt-1">
								Watches for file system changes matching a glob pattern. Set{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									watch
								</code>{' '}
								to a glob like{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									src/**/*.ts
								</code>
								.
							</p>
						</div>
						<div>
							<p>
								<strong style={{ color: theme.colors.textMain }}>Agent Completed</strong>{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									agent.completed
								</code>
							</p>
							<p className="mt-1">
								Triggers when another session finishes a task. Set{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									source_session
								</code>{' '}
								to the session name.
							</p>
						</div>
						<div
							className="font-mono text-xs p-3 rounded border space-y-3"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							<div>
								# Interval
								<br />
								- name: "Periodic Check"
								<br />
								{'  '}event: time.interval
								<br />
								{'  '}interval_minutes: 15
							</div>
							<div>
								# File Watch
								<br />
								- name: "On File Change"
								<br />
								{'  '}event: file.changed
								<br />
								{'  '}watch: "src/**/*.ts"
							</div>
							<div>
								# Agent Completed
								<br />
								- name: "Chain Reaction"
								<br />
								{'  '}event: agent.completed
								<br />
								{'  '}source_session: "my-agent"
							</div>
						</div>
					</div>
				</section>

				{/* Section 4: Template Variables */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Code className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Template Variables</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<div
							className="font-mono text-xs p-3 rounded border space-y-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_EVENT_TYPE}}'}</code> — Event
								type (time.interval, file.changed, agent.completed)
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_EVENT_TIMESTAMP}}'}</code> —
								Event timestamp
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_TRIGGER_NAME}}'}</code> —
								Trigger/subscription name
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_RUN_ID}}'}</code> — Run UUID
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_PATH}}'}</code> — Changed
								file path (file.changed)
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_NAME}}'}</code> — Changed
								file name
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_DIR}}'}</code> — Changed
								file directory
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_EXT}}'}</code> — Changed
								file extension
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_SESSION}}'}</code> —
								Source session name (agent.completed)
							</div>
							<div>
								<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_OUTPUT}}'}</code> —
								Source session output (agent.completed)
							</div>
						</div>
						<div
							className="flex items-center gap-2 px-3 py-2 rounded"
							style={{ backgroundColor: theme.colors.accent + '15' }}
						>
							<Code className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
							<span>
								All standard Maestro template variables (
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									{'{{AGENT_NAME}}'}
								</code>
								,{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									{'{{DATE}}'}
								</code>
								, etc.) are also available in Cue prompts.
							</span>
						</div>
					</div>
				</section>

				{/* Section 5: Multi-Agent Orchestration */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<GitBranch className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Multi-Agent Orchestration</h3>
					</div>
					<div className="text-sm space-y-3 pl-7" style={{ color: theme.colors.textDim }}>
						<div>
							<p>
								<strong style={{ color: theme.colors.textMain }}>Fan-Out:</strong> Trigger multiple
								sessions from a single event. Add{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									fan_out: ["session-1", "session-2"]
								</code>{' '}
								to your subscription.
							</p>
						</div>
						<div>
							<p>
								<strong style={{ color: theme.colors.textMain }}>Fan-In:</strong> Wait for multiple
								sessions to complete before triggering. Set{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									source_session
								</code>{' '}
								to an array:{' '}
								<code
									className="px-1 rounded text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									["session-1", "session-2"]
								</code>
								.
							</p>
						</div>
						<div
							className="font-mono text-xs p-3 rounded border"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							{'  '}Event ──┬── Agent A (fan-out)
							<br />
							{'          '}├── Agent B
							<br />
							{'          '}└── Agent C
							<br />
							<br />
							{'  '}Agent A ──┐
							<br />
							{'  '}Agent B ──┼── Event (fan-in)
							<br />
							{'  '}Agent C ──┘
						</div>
					</div>
				</section>

				{/* Section 6: Timeouts & Failure Handling */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Clock className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Timeouts & Failure Handling</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Default timeout is 30 minutes. If a run times out, the chain breaks and the failure is
							logged.
						</p>
						<p>
							Set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								timeout_on_fail: continue
							</code>{' '}
							in settings to skip failed sources and proceed anyway.
						</p>
						<div
							className="font-mono text-xs p-3 rounded border"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							settings:
							<br />
							{'  '}timeout_minutes: 60
							<br />
							{'  '}timeout_on_fail: continue
						</div>
					</div>
				</section>

				{/* Section 7: Concurrency Control */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Layers className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Concurrency Control</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							By default, each session runs one Cue task at a time. Additional events are queued (up
							to 10) and processed as slots free.
						</p>
						<p>Stale queued events (older than the timeout) are automatically dropped.</p>
						<div
							className="font-mono text-xs p-3 rounded border"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							settings:
							<br />
							{'  '}max_concurrent: 3{'    '}# Up to 3 parallel runs
							<br />
							{'  '}queue_size: 20{'       '}# Queue up to 20 events
							<br />
							{'  '}timeout_minutes: 30
						</div>
					</div>
				</section>

				{/* Section 8: AI YAML Editor */}
				<section>
					<div className="flex items-center gap-2 mb-3">
						<Sparkles className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">AI YAML Editor</h3>
					</div>
					<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
						<p>
							Use the YAML editor to create your configuration. Describe what you want in plain
							text, and AI will generate the YAML for you.
						</p>
						<div
							className="flex items-center gap-2 px-3 py-2 rounded"
							style={{ backgroundColor: theme.colors.accent + '15' }}
						>
							<Sparkles className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
							<span>
								<strong style={{ color: theme.colors.textMain }}>Tip:</strong> Press{' '}
								<kbd
									className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									{formatShortcutKeys(['Meta', 'Shift', 'u'])}
								</kbd>{' '}
								to open the Cue dashboard.
							</span>
						</div>
					</div>
				</section>
			</div>
		</Modal>
	);
}
