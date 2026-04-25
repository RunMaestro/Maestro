/**
 * Shared event-type constants for the Cue pipeline editor.
 *
 * Single source of truth for event icons, labels, and colors used across
 * TriggerNode, TriggerDrawer, NodeConfigPanel, and PipelineCanvas.
 */

import {
	Clock,
	FileText,
	Zap,
	GitPullRequest,
	CircleDot,
	CheckSquare,
	Power,
	Terminal,
} from 'lucide-react';
import type { CueEventType } from '../../../shared/cue-pipeline-types';

/** Icon component for each event type */
export const EVENT_ICONS: Record<CueEventType, typeof Clock> = {
	'app.startup': Power,
	'time.heartbeat': Clock,
	'time.scheduled': Clock,
	'file.changed': FileText,
	'agent.completed': Zap,
	'github.pull_request': GitPullRequest,
	'github.issue': CircleDot,
	'task.pending': CheckSquare,
	'cli.trigger': Terminal,
};

/** Display label for each event type */
export const EVENT_LABELS: Record<CueEventType, string> = {
	'app.startup': 'App Startup',
	'time.heartbeat': 'Heartbeat Timer',
	'time.scheduled': 'Scheduled',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Completed',
	'github.pull_request': 'Pull Request',
	'github.issue': 'GitHub Issue',
	'task.pending': 'Pending Task',
	'cli.trigger': 'CLI Trigger',
};

/**
 * Default prompt templates seeded into new trigger→agent edges. Every event
 * type has an entry so per-edge prompt resolution never falls back to an
 * unrelated agent-level prompt (which used to cause prompt leakage across
 * multiple triggers feeding the same agent).
 *
 * Values may be empty strings when no useful barebones template exists —
 * callers treat "" as "show an empty textarea" rather than a missing entry.
 */
export const DEFAULT_EVENT_PROMPTS: Record<CueEventType, string> = {
	'github.issue': `Issue URL: {{CUE_GH_URL}}
Issue #: {{CUE_GH_NUMBER}}
Issue Title: {{CUE_GH_TITLE}}
Author: {{CUE_GH_AUTHOR}}
Labels: {{CUE_GH_LABELS}}

{{CUE_GH_BODY}}`,
	'github.pull_request': `PR URL: {{CUE_GH_URL}}
PR #: {{CUE_GH_NUMBER}}
PR Title: {{CUE_GH_TITLE}}
Author: {{CUE_GH_AUTHOR}}
Branch: {{CUE_GH_BRANCH}} → {{CUE_GH_BASE_BRANCH}}
Labels: {{CUE_GH_LABELS}}

{{CUE_GH_BODY}}`,
	'file.changed': 'Changed file: {{CUE_FILE_PATH}}\n\n',
	'agent.completed': '{{CUE_SOURCE_OUTPUT}}\n\n',
	'task.pending': 'Pending tasks in {{CUE_TASK_FILE}}:\n{{CUE_TASK_LIST}}\n\n',
	'cli.trigger': '{{CUE_CLI_PROMPT}}\n\n',
	'time.heartbeat': '',
	'time.scheduled': '',
	'app.startup': '',
};

/**
 * Returns the default prompt template for a given trigger event type.
 * Used to seed new trigger→agent edge prompts. Never returns undefined —
 * every event type maps to at least an empty string.
 */
export function defaultPromptFor(eventType: CueEventType): string {
	return DEFAULT_EVENT_PROMPTS[eventType] ?? '';
}

/** Brand color for each event type (used in nodes, drawers, minimap) */
export const EVENT_COLORS: Record<CueEventType, string> = {
	'app.startup': '#10b981',
	'time.heartbeat': '#f59e0b',
	'time.scheduled': '#8b5cf6',
	'file.changed': '#3b82f6',
	'agent.completed': '#22c55e',
	'github.pull_request': '#a855f7',
	'github.issue': '#f97316',
	'task.pending': '#06b6d4',
	'cli.trigger': '#64748b',
};
