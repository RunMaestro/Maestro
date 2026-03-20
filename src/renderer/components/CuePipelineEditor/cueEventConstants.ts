/**
 * Shared event-type constants for the Cue pipeline editor.
 *
 * Single source of truth for event icons, labels, and colors used across
 * TriggerNode, TriggerDrawer, NodeConfigPanel, and PipelineCanvas.
 */

import { Clock, FileText, Zap, GitPullRequest, GitBranch, CheckSquare } from 'lucide-react';
import type { CueEventType } from '../../../shared/cue-pipeline-types';

/** Icon component for each event type */
export const EVENT_ICONS: Record<CueEventType, typeof Clock> = {
	'time.heartbeat': Clock,
	'time.scheduled': Clock,
	'file.changed': FileText,
	'agent.completed': Zap,
	'github.pull_request': GitPullRequest,
	'github.issue': GitBranch,
	'task.pending': CheckSquare,
};

/** Display label for each event type */
export const EVENT_LABELS: Record<CueEventType, string> = {
	'time.heartbeat': 'Heartbeat Timer',
	'time.scheduled': 'Scheduled',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Completed',
	'github.pull_request': 'Pull Request',
	'github.issue': 'GitHub Issue',
	'task.pending': 'Pending Task',
};

/** Brand color for each event type (used in nodes, drawers, minimap) */
export const EVENT_COLORS: Record<CueEventType, string> = {
	'time.heartbeat': '#f59e0b',
	'time.scheduled': '#8b5cf6',
	'file.changed': '#3b82f6',
	'agent.completed': '#22c55e',
	'github.pull_request': '#a855f7',
	'github.issue': '#f97316',
	'task.pending': '#06b6d4',
};
