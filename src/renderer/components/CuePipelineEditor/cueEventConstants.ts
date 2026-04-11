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

/** Default prompt templates for event types that benefit from pre-populated context */
export const DEFAULT_EVENT_PROMPTS: Partial<Record<CueEventType, string>> = {
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
};

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
