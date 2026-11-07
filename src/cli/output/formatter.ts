// Human-readable output formatter for CLI
// Provides beautiful, colored terminal output

import { formatDurationDecimal, formatRelativeTime, formatSize } from '../../shared/formatters';
import {
	MODEL_SERVER_NAME,
	modelServerBindLabel,
	type ModelServerReport,
} from '../../shared/local-models/model-server';
import {
	MODEL_USAGE_SOURCE_KIND_LABELS,
	describeModelUsageRequestSplit,
	isModelUsageEmpty,
	modelUsageOnDeviceShare,
	modelUsageSourceLatency,
	type ModelUsage,
	type ModelUsageDecisionCounts,
} from '../../shared/local-models/model-usage';
import { serverAcceleratorProblemMessage } from '../../shared/local-models/server-accelerator';
import { JEV_DEFAULT_MODEL } from '../../shared/local-models/system-one';
import {
	SYSTEM_ONE_LEDGER_OUTCOME_LABELS,
	summarizeSystemOneDecision,
	type SystemOneLedgerEntry,
	type SystemOneLedgerPage,
} from '../../shared/local-models/system-one-ledger';
import {
	SYSTEM_ONE_REMOTE_ENGINE_IDS,
	describeSystemOneKey,
	systemOneAgentUseBlocker,
	systemOneEngineChoiceLabel,
	type SystemOneKeyInfo,
	type SystemOneReport,
	type SystemOneTestResult,
} from '../../shared/local-models/system-one-settings';
import { formatSystemOneCost } from '../../shared/local-models/system-one-spend';
import type { LocalModelTaskReadiness } from '../../shared/local-models/task-readiness';
import {
	EMBEDDING_SOURCE_TYPES,
	type EmbeddingSourceType,
	type SemanticIndexProgress,
} from '../../shared/local-models/embedding-index';
import {
	describeWorkSearchIndex,
	formatWorkSearchScore,
	WORK_SEARCH_SOURCE_LABELS,
	type WorkSearchHit,
	type WorkSearchResult,
} from '../../shared/local-models/work-search';
import {
	TOKEN_PROXY_ESTIMATE_NOTE,
	TOKEN_PROXY_HOST,
	type TokenProxyBlockDetail,
	type TokenProxyReport,
} from '../../shared/local-models/token-proxy';
import type { DurationPercentiles } from '../../shared/percentiles';
import { peerAccessLabel, type PeerConfigurationReport } from '../../shared/peerAgents';
import {
	describeDelegationGraphStats,
	type DelegationAdjacencyEntry,
	type DelegationGraphStats,
} from '../../shared/delegationGraph';
import {
	groupDefaultLabel,
	type GroupDefaultKey,
	type GroupDefaultsFieldChange,
} from '../../shared/groupAgentDefaults';
import type { GroupSettingsPublishReport } from '../../shared/groupSettingsUpdate';
import type { GroupAgentDefaults } from '../../shared/types';
import { formatBackgroundRequestsSpec } from '../../shared/local-models/background-requests';
import { formatRunOnSpec } from '../../shared/local-models/run-on';
import type { ProxyRequestTotals } from '../../shared/stats-types';
import {
	TIER_LEVELS,
	TIER_NOT_MAPPED_LABEL,
	TIER_TARGET_SOURCE_LABELS,
	formatTierTargetSpec,
	type TierTarget,
	type TierTargetSource,
} from '../../shared/modelTiers';
import { formatSnoozeTarget } from '../../shared/snooze';
import {
	describeTabCleanupCoverage,
	formatTabCleanupAge,
	tabCleanupApplyCommand,
	type TabCleanupResult,
} from '../../shared/tabCleanup';

// ANSI color codes
const colors = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',

	// Foreground colors
	black: '\x1b[30m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	white: '\x1b[37m',
	gray: '\x1b[90m',

	// Bright foreground colors
	brightRed: '\x1b[91m',
	brightGreen: '\x1b[92m',
	brightYellow: '\x1b[93m',
	brightBlue: '\x1b[94m',
	brightMagenta: '\x1b[95m',
	brightCyan: '\x1b[96m',
	brightWhite: '\x1b[97m',
};

// Check if stdout supports colors
const supportsColor = process.stdout.isTTY;

function c(color: keyof typeof colors, text: string): string {
	if (!supportsColor) return text;
	return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Public color helper for callers that build their own lines (e.g. the doctor
 * checklist) and need a colored glyph without the `formatSuccess`/`formatError`
 * prefix decorations. Respects the same `supportsColor` gate as everything else.
 */
export function colorize(color: keyof typeof colors, text: string): string {
	return c(color, text);
}

function bold(text: string): string {
	return c('bold', text);
}

function dim(text: string): string {
	return c('dim', text);
}

// Format helpers
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 1) + '…';
}

// Group formatting
export interface GroupDisplay {
	id: string;
	name: string;
	emoji?: string;
	collapsed?: boolean;
	/** Parked out of the Left Bar. */
	hidden?: boolean;
}

export function formatGroups(groups: GroupDisplay[]): string {
	if (groups.length === 0) {
		return dim('No groups found.');
	}

	const lines: string[] = [];
	lines.push(bold(c('cyan', 'GROUPS')) + dim(` (${groups.length})`));
	lines.push('');

	for (const group of groups) {
		const emoji = group.emoji || '📁';
		const name = c('white', group.name);
		const id = dim(group.id);
		lines.push(`  ${emoji}  ${name}${group.hidden ? dim(' (hidden)') : ''}`);
		lines.push(`      ${id}`);
	}

	return lines.join('\n');
}

// Agent formatting
export interface AgentDisplay {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	groupId?: string;
	autoRunFolderPath?: string;
	bookmarked?: boolean;
}

export function formatAgents(agents: AgentDisplay[], groupName?: string): string {
	if (agents.length === 0) {
		return dim('No agents found.');
	}

	const lines: string[] = [];
	const title = groupName
		? bold(c('cyan', 'AGENTS')) + dim(` in ${groupName} (${agents.length})`)
		: bold(c('cyan', 'AGENTS')) + dim(` (${agents.length})`);
	lines.push(title);
	lines.push('');

	for (const agent of agents) {
		const name = c('white', agent.name);
		const toolType = c('green', agent.toolType);
		const cwd = dim(truncate(agent.cwd, 60));
		const id = dim(agent.id);
		const autoRun = agent.autoRunFolderPath ? c('yellow', ' [Auto Run]') : '';
		const bookmark = agent.bookmarked ? c('yellow', ' \u2605') : '';

		lines.push(`  ${name}${bookmark} ${toolType}${autoRun}`);
		lines.push(`      ${cwd}`);
		lines.push(`      ${id}`);
	}

	return lines.join('\n');
}

// Playbook formatting
export interface PlaybookDocDisplay {
	filename: string;
	resetOnCompletion: boolean;
}

export interface PlaybookDisplay {
	id: string;
	name: string;
	sessionId: string;
	documents: PlaybookDocDisplay[];
	loopEnabled?: boolean;
	maxLoops?: number | null;
}

export interface PlaybooksByAgent {
	agentId: string;
	agentName: string;
	playbooks: PlaybookDisplay[];
}

export function formatPlaybooks(
	playbooks: PlaybookDisplay[],
	agentName?: string,
	folderPath?: string
): string {
	if (playbooks.length === 0) {
		return dim('No playbooks found.');
	}

	const lines: string[] = [];
	const title = agentName
		? bold(c('cyan', 'PLAYBOOKS')) + dim(` for ${agentName} (${playbooks.length})`)
		: bold(c('cyan', 'PLAYBOOKS')) + dim(` (${playbooks.length})`);
	lines.push(title);

	if (folderPath) {
		lines.push(dim(`  📁 ${folderPath}`));
	}

	lines.push('');

	for (const playbook of playbooks) {
		const name = c('white', playbook.name);
		const docCount = c(
			'green',
			`${playbook.documents.length} doc${playbook.documents.length !== 1 ? 's' : ''}`
		);
		const loop = playbook.loopEnabled
			? c('yellow', ` ↻ loop${playbook.maxLoops ? ` (max ${playbook.maxLoops})` : ''}`)
			: '';
		const id = dim(playbook.id.slice(0, 8));

		lines.push(`  ${name} ${docCount}${loop} ${id}`);

		// Show all documents with details
		for (const doc of playbook.documents) {
			const reset = doc.resetOnCompletion ? c('magenta', ' ↺') : '';
			lines.push(`      ${dim('•')} ${doc.filename}${reset}`);
		}

		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

// Playbook detail formatting
export interface PlaybookDetailDisplay {
	id: string;
	name: string;
	agentId: string;
	agentName: string;
	folderPath?: string;
	loopEnabled?: boolean;
	maxLoops?: number | null;
	prompt: string;
	documents: {
		filename: string;
		resetOnCompletion: boolean;
		taskCount: number;
		tasks: string[];
	}[];
}

export function formatPlaybookDetail(playbook: PlaybookDetailDisplay): string {
	const lines: string[] = [];

	// Header
	lines.push(bold(c('cyan', 'PLAYBOOK')));
	lines.push('');

	// Basic info
	lines.push(`  ${c('white', 'Name:')}       ${playbook.name}`);
	lines.push(`  ${c('white', 'ID:')}         ${playbook.id}`);
	lines.push(
		`  ${c('white', 'Agent:')}      ${playbook.agentName} ${dim(`(${playbook.agentId.slice(0, 8)})`)}`
	);

	if (playbook.folderPath) {
		lines.push(`  ${c('white', 'Folder:')}     ${dim(playbook.folderPath)}`);
	}

	// Loop configuration
	if (playbook.loopEnabled) {
		const loopInfo = playbook.maxLoops ? `max ${playbook.maxLoops}` : '∞';
		lines.push(`  ${c('white', 'Loop:')}       ${c('yellow', `enabled (${loopInfo})`)}`);
	} else {
		lines.push(`  ${c('white', 'Loop:')}       ${dim('disabled')}`);
	}

	lines.push('');

	// Prompt
	lines.push(`  ${c('white', 'Prompt:')}`);
	const promptLines = playbook.prompt.split('\n');
	for (const line of promptLines) {
		lines.push(`    ${dim(line)}`);
	}

	lines.push('');

	// Documents
	const totalTasks = playbook.documents.reduce((sum, d) => sum + d.taskCount, 0);
	lines.push(
		`  ${c('white', 'Documents:')} ${dim(`(${playbook.documents.length} files, ${totalTasks} pending tasks)`)}`
	);
	lines.push('');

	for (const doc of playbook.documents) {
		const reset = doc.resetOnCompletion ? c('magenta', ' ↺ reset') : '';
		const taskInfo =
			doc.taskCount > 0 ? c('green', ` (${doc.taskCount} tasks)`) : dim(' (0 tasks)');
		lines.push(`    ${c('blue', '📄')} ${doc.filename}${taskInfo}${reset}`);

		// Show tasks (up to 5)
		const tasksToShow = doc.tasks.slice(0, 5);
		for (let i = 0; i < tasksToShow.length; i++) {
			const task = truncate(tasksToShow[i], 60);
			lines.push(`        ${dim(`${i + 1}.`)} ${task}`);
		}
		if (doc.tasks.length > 5) {
			lines.push(`        ${dim(`... and ${doc.tasks.length - 5} more`)}`);
		}
	}

	return lines.join('\n');
}

export function formatPlaybooksByAgent(groups: PlaybooksByAgent[]): string {
	// Filter to only agents with playbooks
	const agentsWithPlaybooks = groups.filter((g) => g.playbooks.length > 0);

	if (agentsWithPlaybooks.length === 0) {
		return dim('No playbooks found.');
	}

	const totalPlaybooks = agentsWithPlaybooks.reduce((sum, g) => sum + g.playbooks.length, 0);
	const agentWord = agentsWithPlaybooks.length === 1 ? 'agent' : 'agents';
	const lines: string[] = [];
	lines.push(
		bold(c('cyan', 'PLAYBOOKS')) +
			dim(` (${totalPlaybooks} across ${agentsWithPlaybooks.length} ${agentWord})`)
	);
	lines.push('');

	for (const group of agentsWithPlaybooks) {
		// Agent header
		const agentName = c('white', group.agentName);
		const count = dim(`(${group.playbooks.length})`);
		const agentId = dim(group.agentId.slice(0, 8));
		lines.push(`  ${agentName} ${count} ${agentId}`);

		// Playbooks under this agent
		for (const playbook of group.playbooks) {
			const name = playbook.name;
			const docCount = c(
				'green',
				`${playbook.documents.length} doc${playbook.documents.length !== 1 ? 's' : ''}`
			);
			const loop = playbook.loopEnabled ? c('yellow', ` ↻`) : '';
			const id = dim(playbook.id.slice(0, 8));

			lines.push(`      ${name} ${docCount}${loop} ${id}`);
		}

		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

// Run playbook event formatting
export interface RunEvent {
	type: string;
	timestamp: number;
	[key: string]: unknown;
}

export function formatRunEvent(event: RunEvent, options?: { debug?: boolean }): string {
	const time = new Date(event.timestamp).toLocaleTimeString();
	const timeStr = dim(`[${time}]`);
	const debug = options?.debug ?? false;

	switch (event.type) {
		case 'start':
			return `${timeStr} ${c('cyan', '▶')} ${bold('Starting playbook run')}`;

		case 'document_start': {
			const doc = event.document as string;
			const taskCount = event.taskCount as number;
			return `${timeStr} ${c('blue', '📄')} ${bold(doc)} ${dim(`(${taskCount} tasks)`)}`;
		}

		case 'task_start': {
			const taskIndex = (event.taskIndex as number) + 1;
			const task = truncate((event.task as string) || '', 60);
			// Indent: 3 spaces under document
			return `${timeStr}    ${c('yellow', '⏳')} Task ${taskIndex}: ${task}`;
		}

		case 'task_preview': {
			const taskIndex = (event.taskIndex as number) + 1;
			const task = truncate((event.task as string) || '', 70);
			// Indent: 3 spaces under document (same as task_start)
			return `${timeStr}    ${dim(`${taskIndex}.`)} ${task}`;
		}

		case 'task_complete': {
			const success = event.success as boolean;
			const elapsed = ((event.elapsedMs as number) / 1000).toFixed(1);
			const icon = success ? c('green', '✓') : c('red', '✗');
			const sessionId = event.agentSessionId as string | undefined;
			// Indent: 6 spaces under task (result of task)

			if (debug && event.fullResponse) {
				// In debug mode, show first line of response (Summary) + session ID
				const fullResponse = event.fullResponse as string;
				const firstLine = fullResponse.split('\n')[0] || '';
				const sessionInfo = sessionId ? dim(` [${sessionId.slice(0, 8)}]`) : '';
				return `${timeStr}       ${icon} ${firstLine}\n                   ${dim(`(${elapsed}s)`)}${sessionInfo}`;
			} else {
				// Normal mode: truncated summary
				const summary = truncate((event.summary as string) || '', 60);
				return `${timeStr}       ${icon} ${summary} ${dim(`(${elapsed}s)`)}`;
			}
		}

		case 'history_write': {
			const entryId = event.entryId as string;
			// Indent: 6 spaces under task (same level as task_complete)
			return `${timeStr}       ${c('gray', '🔖')} ${dim(`[history] Wrote history entry: ${entryId.slice(0, 8)}`)}`;
		}

		case 'document_complete': {
			const completed = event.tasksCompleted as number;
			return `${timeStr} ${c('green', '✓')} Document complete ${dim(`(${completed} tasks)`)}`;
		}

		case 'document_stalled': {
			const reason = event.reason as string;
			const remaining = event.remainingTasks as number;
			const next = event.hasNextDocument as boolean;
			return [
				`${timeStr} ${c('yellow', '⚠')} Document stalled ${dim(`(${reason})`)}`,
				`${timeStr}       ${dim(`${remaining} task${remaining === 1 ? '' : 's'} left unchecked. ${next ? 'Moving to the next document.' : 'No more documents.'}`)}`,
			].join('\n');
		}

		case 'document_gated': {
			const reason = event.reason as string;
			const artifact = event.artifact as string | undefined;
			const line = event.line as number;
			return [
				`${timeStr} ${c('yellow', '⏸')} Document needs a human ${dim(`(line ${line})`)}`,
				`${timeStr}       ${reason}`,
				...(artifact ? [`${timeStr}       ${dim(artifact)}`] : []),
			].join('\n');
		}

		case 'halt': {
			const reason = event.reason as string;
			return [
				`${timeStr} ${c('red', '■')} ${bold('Playbook halted by the agent')}`,
				`${timeStr}       ${reason}`,
				`${timeStr}       ${dim('Remove the <!-- maestro:halt --> marker before re-running.')}`,
			].join('\n');
		}

		case 'loop_complete': {
			const loopNum = event.iteration as number;
			return `${timeStr} ${c('magenta', '↻')} Loop ${loopNum} complete`;
		}

		case 'complete': {
			const isDryRun = event.dryRun as boolean;
			if (isDryRun) {
				const wouldProcess = event.wouldProcess as number;
				return `\n${timeStr} ${c('cyan', 'ℹ')} ${bold('Dry run complete')} ${dim(`(${wouldProcess} tasks would be processed)`)}`;
			}
			const total = event.totalTasksCompleted as number;
			const elapsed = ((event.totalElapsedMs as number) / 1000).toFixed(1);
			if (event.stopped) {
				return `\n${timeStr} ${c('yellow', '■')} ${bold('Playbook stopped')} ${dim(`(${total} tasks in ${elapsed}s)`)}`;
			}
			return `\n${timeStr} ${c('green', '✓')} ${bold('Playbook complete')} ${dim(`(${total} tasks in ${elapsed}s)`)}`;
		}

		case 'error': {
			const message = event.message as string;
			return `${timeStr} ${c('red', '✗')} ${c('red', 'Error:')} ${message}`;
		}

		case 'debug': {
			const category = event.category as string;
			const message = event.message as string;
			const categoryColors: Record<string, keyof typeof colors> = {
				config: 'cyan',
				scan: 'blue',
				loop: 'magenta',
				reset: 'yellow',
				stall: 'yellow',
			};
			const categoryColor = categoryColors[category] || 'gray';
			return `${timeStr} ${c('gray', '🔍')} ${c(categoryColor, `[${category}]`)} ${dim(message)}`;
		}

		case 'verbose': {
			const category = event.category as string;
			const doc = event.document as string;
			const taskIndex = (event.taskIndex as number) + 1;
			const prompt = event.prompt as string;
			const separator = c('gray', '─'.repeat(80));
			const header = `${timeStr} ${c('magenta', '📝')} ${c('magenta', `[${category}]`)} ${bold(doc)} Task ${taskIndex}`;
			return `${separator}\n${header}\n${separator}\n${prompt}\n${separator}`;
		}

		case 'goal_start':
			return `${timeStr} ${c('cyan', '🎯')} ${bold('Starting Goal-Driven Auto Run')} ${dim(
				truncate((event.goal as string) || '', 60)
			)}`;

		case 'goal_iteration_start': {
			const iteration = event.iteration as number;
			return `${timeStr} ${c('yellow', '⏳')} Iteration ${iteration}`;
		}

		case 'goal_iteration_complete': {
			const iteration = event.iteration as number;
			const progress = event.progress as number;
			const summary = truncate((event.summary as string) || '', 70);
			return `${timeStr}    ${c('green', '✓')} Iteration ${iteration} ${bold(`${progress}%`)} ${dim(summary)}`;
		}

		case 'goal_complete': {
			const success = event.success as boolean;
			const finalProgress = event.finalProgress as number;
			const iterations = event.iterations as number;
			const reason = event.exitReason as string;
			const icon = success ? c('green', '✓') : c('yellow', '■');
			return `${timeStr} ${icon} ${bold('Goal run finished')} ${dim(
				`(${reason}, ${finalProgress}%, ${iterations} iteration${iterations === 1 ? '' : 's'})`
			)}`;
		}

		default:
			return `${timeStr} ${dim(event.type)}`;
	}
}

// Agent detail formatting
export interface AgentDetailDisplay {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	projectRoot: string;
	groupId?: string;
	groupName?: string;
	autoRunFolderPath?: string;
	bookmarked?: boolean;
	// Editable per-agent settings (the Edit Agent modal fields). `null` = unset.
	nudgeMessage?: string | null;
	peerDescription?: string | null;
	newSessionMessage?: string | null;
	customPath?: string | null;
	customArgs?: string | null;
	customEnvVars?: Record<string, string> | null;
	/** Variables switched off in the editor: kept, never spawned with. */
	parkedEnvVars?: Record<string, string> | null;
	/** What the agent is spawned with, layer by layer. Secrets arrive masked. */
	effectiveEnv?: Array<{ key: string; value: string; source: string; shadowedBy: string[] }>;
	gatewayUrl?: string | null;
	tokenProxyMode?: string | null;
	/** The Run on target; a source target carries its context size. */
	runOn?: unknown;
	runOnLabel?: string | null;
	runOnProblem?: string | null;
	/** Each tier with its target's spelling and the layer it came from. */
	tiers?: Array<{
		tier: string;
		spec: string | null;
		source: TierTargetSource | null;
		problem?: string;
		note?: string;
	}>;
	backgroundRequestsLabel?: string | null;
	backgroundRequestsProblem?: string | null;
	systemOneOptOut?: boolean;
	/** The stored peer configuration and the roster it resolves to. */
	peers?: PeerConfigurationReport;
	customModel?: string | null;
	customEffort?: string | null;
	customContextWindow?: number | null;
	tokenSource?: string | null;
	codexTransport?: string | null;
	stats: {
		historyEntries: number;
		successCount: number;
		failureCount: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheCreationTokens: number;
		totalCost: number;
		totalElapsedMs: number;
	};
	recentHistory: {
		id: string;
		type: string;
		timestamp: number;
		summary: string;
		success?: boolean;
		elapsedTimeMs?: number;
		cost?: number;
	}[];
}

/**
 * Format token count for CLI display (decimal format with K/M suffixes).
 * Note: This differs from shared/formatters.ts which uses integer rounding
 * and ~prefix for approximation. This version uses decimal for precision.
 */
function formatTokens(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	} else if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}K`;
	}
	return count.toString();
}

const formatDuration = formatDurationDecimal;

export function formatAgentDetail(agent: AgentDetailDisplay): string {
	const lines: string[] = [];

	// Header
	lines.push(bold(c('cyan', 'AGENT')));
	lines.push('');

	// Basic info
	lines.push(`  ${c('white', 'Name:')}       ${agent.name}`);
	lines.push(`  ${c('white', 'ID:')}         ${agent.id}`);
	lines.push(`  ${c('white', 'Type:')}       ${c('green', agent.toolType)}`);
	lines.push(`  ${c('white', 'Directory:')}  ${dim(agent.cwd)}`);

	if (agent.groupName) {
		lines.push(`  ${c('white', 'Group:')}      ${agent.groupName}`);
	}

	if (agent.autoRunFolderPath) {
		lines.push(`  ${c('white', 'Auto Run:')}   ${dim(agent.autoRunFolderPath)}`);
	}

	if (agent.bookmarked) {
		lines.push(`  ${c('white', 'Bookmarked:')} ${c('yellow', '\u2605 yes')}`);
	}

	// Configuration (the Edit Agent modal settings). Only render the rows that
	// are actually set so an unconfigured agent stays terse.
	const configRows: string[] = [];
	const addConfig = (label: string, value: string | null | undefined) => {
		if (value === null || value === undefined || value === '') return;
		configRows.push(
			`  ${c('white', `${label}:`)}${' '.repeat(Math.max(1, 20 - label.length))}${value}`
		);
	};
	addConfig('Nudge', agent.nudgeMessage ? truncate(agent.nudgeMessage, 60) : undefined);
	addConfig('Peer description', agent.peerDescription);
	addConfig(
		'New session msg',
		agent.newSessionMessage ? truncate(agent.newSessionMessage, 60) : undefined
	);
	addConfig('Model', agent.customModel);
	addConfig('Effort', agent.customEffort);
	addConfig(
		'Context window',
		typeof agent.customContextWindow === 'number' ? String(agent.customContextWindow) : undefined
	);
	addConfig('Binary path', agent.customPath ? dim(agent.customPath) : undefined);
	addConfig('Custom args', agent.customArgs);
	if (agent.customEnvVars && Object.keys(agent.customEnvVars).length > 0) {
		addConfig('Env vars', Object.keys(agent.customEnvVars).join(', '));
	}
	addConfig('Gateway URL', agent.gatewayUrl ? dim(agent.gatewayUrl) : undefined);
	addConfig('Token proxy mode', agent.tokenProxyMode ?? undefined);
	// Shown only for an agent on a source: the provider's own model is the default.
	if (agent.runOnProblem) {
		addConfig('Run on', c('red', `unusable target: ${agent.runOnProblem}`));
	} else if (agent.runOnLabel) {
		const contextTokens = (agent.runOn as { contextTokens?: unknown } | null | undefined)
			?.contextTokens;
		addConfig(
			'Run on',
			typeof contextTokens === 'number'
				? `${agent.runOnLabel} ${dim(`(context ${contextTokens} tokens)`)}`
				: agent.runOnLabel
		);
	}
	// Every tier of a harness that has tiers, with the layer that answered: the
	// value an agent did not set is still the value its next task launches on.
	for (const tier of agent.tiers ?? []) {
		const layer = tier.source ? TIER_TARGET_SOURCE_LABELS[tier.source] : TIER_NOT_MAPPED_LABEL;
		addConfig(
			`Tier ${tier.tier}`,
			tier.problem
				? c('red', `unusable target: ${tier.problem}`)
				: `${tier.spec ?? '-'} ${dim(`(${layer})`)}`
		);
	}
	// Shown only when set or broken: off is the default.
	if (agent.backgroundRequestsProblem) {
		addConfig(
			'Background requests',
			c('red', `unusable target: ${agent.backgroundRequestsProblem}`)
		);
	} else if (agent.backgroundRequestsLabel) {
		addConfig('Background requests', agent.backgroundRequestsLabel);
	}
	// Shown only when switched off: on is the default.
	if (agent.systemOneOptOut) addConfig('System One', 'off for this agent');
	if (agent.toolType === 'claude-code' && agent.tokenSource) {
		addConfig('Token source', agent.tokenSource);
	}
	if (agent.toolType === 'codex' && agent.codexTransport) {
		addConfig('Codex transport', agent.codexTransport);
	}
	if (configRows.length > 0) {
		lines.push('');
		lines.push(bold(c('cyan', 'CONFIGURATION')));
		lines.push('');
		lines.push(...configRows);
	}

	// The environment the agent is spawned with: every variable, the layer its
	// value came from, and the layers it overrode. The Edit Agent dialog's "Show
	// environment" table. Secret values were masked by the caller.
	if (agent.effectiveEnv && agent.effectiveEnv.length > 0) {
		lines.push('');
		lines.push(bold(c('cyan', 'ENVIRONMENT')));
		lines.push('');
		for (const entry of agent.effectiveEnv) {
			const overrode = entry.shadowedBy.length ? `, overrides ${entry.shadowedBy.join(', ')}` : '';
			lines.push(`  ${entry.key}=${entry.value}  ${dim(`[${entry.source}${overrode}]`)}`);
		}
	}
	if (agent.parkedEnvVars && Object.keys(agent.parkedEnvVars).length > 0) {
		if (!agent.effectiveEnv?.length) {
			lines.push('');
			lines.push(bold(c('cyan', 'ENVIRONMENT')));
			lines.push('');
		}
		lines.push(
			`  ${c('white', 'Parked (not spawned with):')} ${Object.keys(agent.parkedEnvVars).join(', ')}`
		);
	}

	// Peers: the stored rows and grants, then who they resolve to. The two are
	// different lists (a grant adds no row, an exclusion row removes a peer), so
	// both are printed. Skipped for an agent with no peer configuration at all.
	if (agent.peers) {
		const { rows, groupGrant, worktreeGrant, roster } = agent.peers;
		if (rows.length > 0 || groupGrant.on || worktreeGrant.on) {
			lines.push('');
			lines.push(bold(c('cyan', 'PEERS')));
			lines.push('');
			lines.push(
				`  ${c('white', 'Group peers:')}     ${groupGrant.on ? groupGrant.access : dim('off')}` +
					(groupGrant.on && !agent.groupId ? dim(' (agent is in no group)') : '')
			);
			lines.push(
				`  ${c('white', 'Worktree peers:')}  ${worktreeGrant.on ? worktreeGrant.access : dim('off')}`
			);
			if (rows.length > 0) {
				lines.push('');
				lines.push(`  ${c('white', 'Explicit rows:')}`);
				for (const row of rows) {
					const label = row.name ?? dim('(no live agent)');
					const note = row.description ? dim(` - ${truncate(row.description, 60)}`) : '';
					lines.push(`    ${label} ${dim(`(${row.sessionId})`)}  ${row.access}${note}`);
				}
			}
			lines.push('');
			if (roster.length === 0) {
				lines.push(`  ${c('white', 'Can reach:')}  ${dim('nobody')}`);
			} else {
				lines.push(`  ${c('white', 'Can reach:')}`);
				for (const peer of roster) {
					lines.push(
						`    ${peer.name} ${dim(`(${peer.sessionId})`)}  ${peer.access} ${dim(`[${peer.source}]`)}`
					);
				}
			}
		}
	}

	lines.push('');

	// Stats
	lines.push(bold(c('cyan', 'USAGE STATS')));
	lines.push('');

	const { stats } = agent;
	const successRate =
		stats.historyEntries > 0 ? ((stats.successCount / stats.historyEntries) * 100).toFixed(0) : '0';

	lines.push(
		`  ${c('white', 'Sessions:')}      ${stats.historyEntries} total ${dim(`(${stats.successCount} success, ${stats.failureCount} failed, ${successRate}% success rate)`)}`
	);
	lines.push(`  ${c('white', 'Total Cost:')}    ${c('yellow', `$${stats.totalCost.toFixed(4)}`)}`);
	lines.push(`  ${c('white', 'Total Time:')}    ${formatDuration(stats.totalElapsedMs)}`);
	lines.push('');
	lines.push(
		`  ${c('white', 'Tokens:')}        ${dim('Input:')} ${formatTokens(stats.totalInputTokens)}  ${dim('Output:')} ${formatTokens(stats.totalOutputTokens)}`
	);
	lines.push(
		`  ${c('white', 'Cache:')}         ${dim('Read:')} ${formatTokens(stats.totalCacheReadTokens)}  ${dim('Created:')} ${formatTokens(stats.totalCacheCreationTokens)}`
	);

	// Recent history
	if (agent.recentHistory.length > 0) {
		lines.push('');
		lines.push(bold(c('cyan', 'RECENT HISTORY')) + dim(` (last ${agent.recentHistory.length})`));
		lines.push('');

		for (const entry of agent.recentHistory) {
			const date = new Date(entry.timestamp);
			const dateStr = date.toLocaleDateString();
			const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			const icon =
				entry.success === true
					? c('green', '✓')
					: entry.success === false
						? c('red', '✗')
						: c('gray', '•');
			const typeLabel = c('gray', `[${entry.type}]`);
			const summary = truncate(entry.summary, 50);
			const costStr = entry.cost !== undefined ? dim(` $${entry.cost.toFixed(4)}`) : '';
			const timeElapsed = entry.elapsedTimeMs ? dim(` ${formatDuration(entry.elapsedTimeMs)}`) : '';

			lines.push(
				`  ${icon} ${dim(`${dateStr} ${timeStr}`)} ${typeLabel} ${summary}${costStr}${timeElapsed}`
			);
		}
	}

	return lines.join('\n');
}

// Session formatting
export interface SessionDisplay {
	sessionId: string;
	sessionName?: string;
	modifiedAt: string;
	firstMessage: string;
	messageCount: number;
	costUsd: number;
	durationSeconds: number;
	starred?: boolean;
}

export function formatSessions(
	sessions: SessionDisplay[],
	agentName: string,
	totalCount: number,
	filteredCount: number,
	searchQuery?: string
): string {
	if (sessions.length === 0) {
		if (searchQuery) {
			return dim(`No sessions matching "${searchQuery}" found.`);
		}
		return dim('No sessions found.');
	}

	const lines: string[] = [];
	const countInfo = searchQuery
		? `${filteredCount} matching of ${totalCount} total`
		: `showing ${sessions.length} of ${totalCount}`;
	lines.push(bold(c('cyan', 'SESSIONS')) + dim(` for ${agentName} (${countInfo})`));
	lines.push('');

	for (const session of sessions) {
		const date = new Date(session.modifiedAt);
		const dateStr = date.toLocaleDateString();
		const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		const star = session.starred ? c('yellow', '★ ') : '  ';
		const name = session.sessionName ? c('white', session.sessionName) : dim('(unnamed)');
		const cost = session.costUsd > 0 ? c('yellow', `$${session.costUsd.toFixed(4)}`) : dim('$0');
		const msgs = dim(`${session.messageCount} msgs`);
		const dur =
			session.durationSeconds > 0 ? dim(formatDurationSeconds(session.durationSeconds)) : '';
		const preview = session.firstMessage
			? dim(truncate(session.firstMessage.replace(/\n/g, ' '), 70))
			: '';
		const id = dim(session.sessionId);

		lines.push(`${star}${name} ${msgs} ${cost}${dur ? ` ${dur}` : ''}`);
		lines.push(`      ${dim(`${dateStr} ${timeStr}`)} ${id}`);
		if (preview) {
			lines.push(`      ${preview}`);
		}
		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

function formatDurationSeconds(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}

// Settings formatting
export interface SettingDisplay {
	key: string;
	value: unknown;
	type: string;
	category: string;
	description?: string;
	defaultValue?: unknown;
	isDefault?: boolean;
	sensitive?: boolean;
}

function formatSettingValue(value: unknown, sensitive?: boolean): string {
	if (sensitive) return c('red', '***');
	if (value === null) return dim('null');
	if (value === undefined) return dim('undefined');
	if (typeof value === 'boolean') return c(value ? 'green' : 'red', String(value));
	if (typeof value === 'number') return c('yellow', String(value));
	if (typeof value === 'string') {
		if (value === '') return dim('""');
		return c('white', value.length > 60 ? truncate(value, 60) : value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return dim('[]');
		const compact = JSON.stringify(value);
		return dim(compact.length > 60 ? truncate(compact, 60) : compact);
	}
	if (typeof value === 'object') {
		const compact = JSON.stringify(value);
		return dim(compact.length > 60 ? truncate(compact, 60) : compact);
	}
	return String(value);
}

export function formatSettingsList(
	settings: SettingDisplay[],
	options?: { verbose?: boolean; keysOnly?: boolean; showDefaults?: boolean }
): string {
	if (settings.length === 0) {
		return dim('No settings found.');
	}

	const verbose = options?.verbose ?? false;
	const keysOnly = options?.keysOnly ?? false;
	const showDefaults = options?.showDefaults ?? false;

	const lines: string[] = [];
	lines.push(bold(c('cyan', 'SETTINGS')) + dim(` (${settings.length})`));
	lines.push('');

	let currentCategory = '';
	for (const setting of settings) {
		// Category header
		if (setting.category !== currentCategory) {
			if (currentCategory !== '') lines.push('');
			lines.push(`  ${bold(c('blue', setting.category))}`);
			currentCategory = setting.category;
		}

		if (keysOnly) {
			lines.push(`    ${c('white', setting.key)}`);
			continue;
		}

		const valueStr = formatSettingValue(setting.value, setting.sensitive);
		const defaultMarker = setting.isDefault ? dim(' (default)') : '';
		lines.push(`    ${c('white', setting.key)} = ${valueStr}${defaultMarker}`);

		if (showDefaults && !setting.isDefault) {
			const defStr = formatSettingValue(setting.defaultValue);
			lines.push(`      ${dim('default:')} ${defStr}`);
		}

		if (verbose && setting.description) {
			lines.push(`      ${dim(setting.description)}`);
		}
	}

	return lines.join('\n');
}

export function formatSettingDetail(setting: SettingDisplay): string {
	const lines: string[] = [];
	lines.push(bold(c('cyan', 'SETTING')));
	lines.push('');
	lines.push(`  ${c('white', 'Key:')}       ${setting.key}`);
	lines.push(
		`  ${c('white', 'Value:')}     ${formatSettingValue(setting.value, setting.sensitive)}`
	);
	lines.push(`  ${c('white', 'Type:')}      ${dim(setting.type)}`);
	lines.push(`  ${c('white', 'Default:')}   ${formatSettingValue(setting.defaultValue)}`);
	lines.push(`  ${c('white', 'Category:')}  ${setting.category}`);
	if (setting.description) {
		lines.push('');
		lines.push(`  ${dim(setting.description)}`);
	}
	return lines.join('\n');
}

// SSH Remote formatting
export interface SshRemoteDisplay {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	enabled: boolean;
	useSshConfig?: boolean;
	isDefault?: boolean;
}

export function formatSshRemotes(remotes: SshRemoteDisplay[]): string {
	if (remotes.length === 0) {
		return dim('No SSH remotes configured.');
	}

	const lines: string[] = [];
	lines.push(bold(c('cyan', 'SSH REMOTES')) + dim(` (${remotes.length})`));
	lines.push('');

	for (const remote of remotes) {
		const name = c('white', remote.name);
		const status = remote.enabled ? c('green', 'enabled') : c('red', 'disabled');
		const defaultTag = remote.isDefault ? c('yellow', ' [default]') : '';
		const sshConfig = remote.useSshConfig ? c('blue', ' [ssh-config]') : '';
		const hostInfo = remote.username ? `${remote.username}@${remote.host}` : remote.host;
		const portInfo = remote.port !== 22 ? `:${remote.port}` : '';
		const id = dim(remote.id);

		lines.push(`  ${name} ${status}${defaultTag}${sshConfig}`);
		lines.push(`      ${dim(hostInfo + portInfo)}`);
		lines.push(`      ${id}`);
	}

	return lines.join('\n');
}

export interface LocalModelEndpointDisplay {
	id: string;
	name: string;
	kindLabel: string;
	baseUrl: string;
	enabled: boolean;
	apiKeyEnvVar?: string;
	/** False when `apiKeyEnvVar` names a variable Settings -> Environment does not set. */
	apiKeyResolved?: boolean;
}

export function formatLocalModelEndpoints(endpoints: LocalModelEndpointDisplay[]): string {
	if (endpoints.length === 0) {
		return dim('No model endpoints configured.');
	}

	const lines: string[] = [];
	lines.push(bold(c('cyan', 'MODEL ENDPOINTS')) + dim(` (${endpoints.length})`));
	lines.push('');

	for (const endpoint of endpoints) {
		const status = endpoint.enabled ? c('green', 'enabled') : c('red', 'disabled');
		lines.push(`  ${c('white', endpoint.name)} ${status} ${c('blue', `[${endpoint.kindLabel}]`)}`);
		lines.push(`      ${dim(endpoint.baseUrl)}`);
		if (endpoint.apiKeyEnvVar) {
			const key =
				endpoint.apiKeyResolved === false
					? c('yellow', `key: $${endpoint.apiKeyEnvVar} (not set in Settings -> Environment)`)
					: dim(`key: $${endpoint.apiKeyEnvVar}`);
			lines.push(`      ${key}`);
		}
		lines.push(`      ${dim(endpoint.id)}`);
	}

	return lines.join('\n');
}

const TASK_READINESS_STATE: Record<
	LocalModelTaskReadiness['state'],
	{ label: string; color: keyof typeof colors }
> = {
	ready: { label: 'ready', color: 'green' },
	'utility-agent': { label: 'utility agent', color: 'blue' },
	off: { label: 'off', color: 'gray' },
	unavailable: { label: 'unavailable', color: 'red' },
};

/**
 * `maestro-cli models status`: one row per task. The suggested action is shown
 * for an unavailable task, and for an off task only when it is the one asked
 * about (most tasks are off by default, so a full listing would repeat it).
 */
export function formatLocalModelTaskReadiness(
	rows: LocalModelTaskReadiness[],
	options: { single?: boolean } = {}
): string {
	const lines: string[] = [];
	if (!options.single) {
		lines.push(bold(c('cyan', 'LOCAL MODEL TASKS')) + dim(` (${rows.length})`));
		lines.push('');
	}
	const idWidth = Math.max(...rows.map((row) => row.taskId.length));
	const stateWidth = Math.max(
		...Object.values(TASK_READINESS_STATE).map((state) => state.label.length)
	);
	for (const row of rows) {
		const state = TASK_READINESS_STATE[row.state];
		const reason = row.reason ? dim(` [${row.reason}]`) : '';
		lines.push(
			`  ${c('white', row.taskId.padEnd(idWidth))}  ${c(state.color, state.label.padEnd(stateWidth))}  ${row.detail}${reason}`
		);
		const showAction =
			row.suggestedAction &&
			(row.state === 'unavailable' || (row.state === 'off' && options.single));
		if (showAction) {
			lines.push(`  ${' '.repeat(idWidth + stateWidth + 2)}  ${dim(`-> ${row.suggestedAction}`)}`);
		}
	}
	return lines.join('\n');
}

/** The words a person reads for each indexer state, and how loud each is. */
const SEMANTIC_INDEX_STATE: Record<
	SemanticIndexProgress['state'],
	{ label: string; color: Parameters<typeof c>[0] }
> = {
	off: { label: 'off', color: 'gray' },
	idle: { label: 'up to date', color: 'green' },
	indexing: { label: 'indexing', color: 'cyan' },
	paused: { label: 'paused', color: 'yellow' },
	unavailable: { label: 'unavailable', color: 'red' },
};

/** The source types as a person reads them, in the order they are listed. */
const SEMANTIC_INDEX_SOURCE_LABELS: Record<EmbeddingSourceType, string> = {
	history: 'History entries',
	'directors-notes': "Director's Notes",
	transcript: 'Transcript turns',
};

/**
 * `maestro-cli models index`: what the background indexer is doing, how many
 * sources are indexed, and (when it cannot run) why. `off` names the fix,
 * since nothing else on the screen says how to turn it on.
 */
export function formatSemanticIndexProgress(progress: SemanticIndexProgress): string {
	const state = SEMANTIC_INDEX_STATE[progress.state];
	const lines = [`${bold(c('cyan', 'SEMANTIC INDEX'))}  ${c(state.color, state.label)}`];
	if (progress.state === 'off') {
		lines.push(
			'',
			dim(
				'  -> Assign Semantic search a source: maestro-cli models assign semantic-search <source>'
			)
		);
		return lines.join('\n');
	}
	if (progress.modelId) lines.push(dim(`  ${progress.modelId}`));
	if (progress.reason) lines.push(`  ${progress.reason}`);
	lines.push('');
	const labelWidth = Math.max(
		...EMBEDDING_SOURCE_TYPES.map((type) => SEMANTIC_INDEX_SOURCE_LABELS[type].length)
	);
	for (const type of EMBEDDING_SOURCE_TYPES) {
		const { indexed, total } = progress.bySourceType[type];
		lines.push(
			`  ${c('white', SEMANTIC_INDEX_SOURCE_LABELS[type].padEnd(labelWidth))}  ${indexed} / ${total}`
		);
	}
	lines.push(`  ${bold('Total'.padEnd(labelWidth))}  ${progress.indexed} / ${progress.total}`);
	if (progress.lastPassAt === undefined) lines.push('', dim('  No pass has finished yet.'));
	return lines.join('\n');
}

/** Tokens saved with the share of what arrived, or a dash when nothing was read. */
function proxyTokensSaved(totals: ProxyRequestTotals): string {
	if (totals.compressRequests === 0) return '-';
	const share =
		totals.originalTokens > 0 ? Math.round((totals.tokensSaved / totals.originalTokens) * 100) : 0;
	return `${totals.tokensSaved} tokens saved (${share}%)`;
}

function proxyUsageLine(label: string, totals: ProxyRequestTotals): string {
	const latency =
		totals.compressRequests === 0 ? '' : `, ${totals.avgAddedLatencyMs} ms average added latency`;
	return `  ${c('white', label)}  ${totals.requests} ${totals.requests === 1 ? 'request' : 'requests'}, ${proxyTokensSaved(totals)}${latency}`;
}

/**
 * `maestro-cli models proxy status`: the listener, the agents on it with their
 * mode, what it carried in the last 30 days, and the blocks it last shortened
 * (each with the hash `models proxy block` takes).
 */
export function formatTokenProxyReport(report: TokenProxyReport): string {
	const { status } = report;
	const state =
		status.port === null
			? c('gray', 'not set up')
			: status.running
				? c('green', `listening on ${TOKEN_PROXY_HOST}:${status.port}`)
				: status.lastError
					? c('red', `could not start on ${TOKEN_PROXY_HOST}:${status.port}`)
					: c('gray', `stopped (port ${status.port})`);
	const lines = [`${bold(c('cyan', 'TOKEN PROXY'))}  ${state}`];
	if (status.lastError && !status.running) lines.push(`  ${status.lastError}`);
	if (status.port === null) {
		lines.push(
			'',
			dim('  -> Turn it on for an agent: maestro-cli update-agent <agent> --proxy-mode passthrough')
		);
		return lines.join('\n');
	}

	lines.push('', bold('Agents'));
	if (report.agents.length === 0) lines.push(dim('  No agent points at the proxy.'));
	const names = new Map(report.agents.map((agent) => [agent.id, agent.name]));
	for (const agent of report.agents) {
		lines.push(`  ${c('white', agent.name)}  ${agent.mode}  ${dim(agent.gatewayUrl)}`);
	}

	lines.push('', bold('Last 30 days'));
	if (!report.usage) {
		lines.push(dim('  Usage statistics are not available.'));
	} else if (report.usage.totals.requests === 0) {
		lines.push(dim('  No requests.'));
	} else {
		lines.push(proxyUsageLine('All agents', report.usage.totals));
		for (const row of report.usage.byAgent) {
			const label =
				row.agentId === null ? 'No agent' : (names.get(row.agentId) ?? row.agentId.slice(0, 8));
			lines.push(proxyUsageLine(label, row));
		}
		if (report.usage.totals.compressRequests > 0) {
			lines.push(dim(`  ${TOKEN_PROXY_ESTIMATE_NOTE}`));
		}
	}

	if (report.recentCompressions.length > 0) {
		lines.push('', bold('Recent compressions'));
		for (const entry of report.recentCompressions) {
			lines.push(
				`  ${entry.hash}  ${entry.originalTokens} -> ${entry.compressedTokens} tokens  ${dim(`${entry.compressors.join(', ')}, ${formatRelativeTime(entry.at)}`)}`
			);
		}
	}
	return lines.join('\n');
}

/** The lines above a `models proxy block` diff: what the block is and what it cost. */
export function formatTokenProxyBlockHeader(block: TokenProxyBlockDetail): string {
	return [
		`${bold(c('cyan', 'COMPRESSED BLOCK'))}  ${block.hash}`,
		`  ${block.originalTokens} -> ${block.compressedTokens} tokens  ${dim(`${block.compressors.join(', ')}, ${formatRelativeTime(block.createdAt)}`)}`,
		'',
	].join('\n');
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** `p50 240ms  p95 1.2s`, or nothing for a distribution with no sample. */
function latencyCells(latency: DurationPercentiles): string {
	return latency.count === 0
		? ''
		: `p50 ${formatDurationDecimal(latency.p50)}  p95 ${formatDurationDecimal(latency.p95)}`;
}

function decisionOutcomeLine(counts: ModelUsageDecisionCounts): string {
	const outcomes = (Object.keys(counts.outcomes) as Array<keyof typeof counts.outcomes>)
		.filter((outcome) => counts.outcomes[outcome] > 0)
		.map(
			(outcome) =>
				`${counts.outcomes[outcome]} ${SYSTEM_ONE_LEDGER_OUTCOME_LABELS[outcome].toLowerCase()}`
		);
	if (counts.timeouts > 0) {
		outcomes.push(`${counts.timeouts} ${SYSTEM_ONE_LEDGER_OUTCOME_LABELS.timeout.toLowerCase()}`);
	}
	const cached = counts.cached > 0 ? ` (${counts.cached} from the cache)` : '';
	return `${plural(counts.decisions, 'decision')}${cached}${outcomes.length > 0 ? `: ${outcomes.join(', ')}` : ''}`;
}

/**
 * `maestro-cli stats models`: what every model other than a provider's own did
 * in the range, the way the Usage Dashboard's Models tab draws it: the sources
 * (with the providers' own cloud for comparison), the tasks, the agents that
 * ran turns on a Run on source, System One's decisions and the token proxy.
 */
export function formatModelUsage(usage: ModelUsage): string {
	const { totals } = usage;
	const lines = [`${bold(c('cyan', 'MODEL USAGE'))}  ${dim(usage.range)}`];
	if (totals.requests === 0 && isModelUsageEmpty(usage)) {
		lines.push(
			'',
			dim('  Nothing ran in this range.'),
			dim('  -> See what is set up to run on another model: maestro-cli models status')
		);
		return lines.join('\n');
	}
	lines.push(
		`  ${plural(totals.requests, 'request')}, ${formatTokens(totals.tokensIn)} tokens in, ${formatTokens(totals.tokensOut)} out, ${Math.round(modelUsageOnDeviceShare(totals) * 100)}% on this machine, ${plural(totals.errors, 'error')}`
	);

	lines.push('', bold('Sources'));
	const labelWidth = Math.max(...usage.sources.map((source) => source.label.length), 0);
	for (const source of usage.sources) {
		const errors = source.errors > 0 ? c('red', plural(source.errors, 'error')) : '';
		const read = modelUsageSourceLatency(source);
		const latency = read
			? `${latencyCells(read.distribution)}${read.unit === 'turn' ? ' (turns)' : ''}`
			: '';
		lines.push(
			[
				`  ${c('white', source.label.padEnd(labelWidth))}`,
				dim(MODEL_USAGE_SOURCE_KIND_LABELS[source.kind]),
				`${plural(source.requests, 'request')} ${dim(`(${describeModelUsageRequestSplit(source)})`)}`,
				`${formatTokens(source.tokensIn)} in, ${formatTokens(source.tokensOut)} out`,
				errors,
				latency,
			]
				.filter(Boolean)
				.join('  ')
		);
		if (source.kind !== 'provider' && source.models.length > 0) {
			lines.push(`    ${dim(source.models.map((entry) => entry.model).join(', '))}`);
		}
	}
	if (usage.sources.some((source) => modelUsageSourceLatency(source)?.unit === 'turn')) {
		lines.push(dim('  p50 and p95 marked (turns) are whole agent turns, not single requests.'));
	}

	if (usage.byTask.length > 0) {
		lines.push('', bold('Tasks'));
		const taskWidth = Math.max(...usage.byTask.map((task) => task.label.length));
		for (const task of usage.byTask) {
			const errors = task.errors > 0 ? c('red', plural(task.errors, 'error')) : '';
			lines.push(
				[
					`  ${c('white', task.label.padEnd(taskWidth))}`,
					plural(task.runs, 'run'),
					errors,
					latencyCells(task.latency),
					dim(task.sources.map((source) => `${source.label} ${source.runs}`).join(', ')),
				]
					.filter(Boolean)
					.join('  ')
			);
		}
	}

	const runOnAgents = usage.byAgent.filter((agent) => agent.turns > 0);
	if (runOnAgents.length > 0) {
		lines.push('', bold('Agents (Run on turns)'));
		for (const agent of runOnAgents) {
			const targets = agent.targets
				.map((target) => `${target.model} on ${target.sourceLabel} ${target.turns}`)
				.join(', ');
			lines.push(
				`  ${c('white', agent.name ?? agent.agentId.slice(0, 8))}  ${plural(agent.turns, 'turn')}  ${formatTokens(agent.tokensIn)} in, ${formatTokens(agent.tokensOut)} out  ${dim(targets)}`
			);
		}
	}

	const { systemOne } = usage;
	const routed = systemOne.routedTiers;
	const routedTurns = routed.low + routed.medium + routed.high;
	if (systemOne.decisions > 0 || routedTurns > 0) {
		const kept = systemOne.coversRange
			? ''
			: `  ${dim(`decisions are kept ${systemOne.retentionDays} days`)}`;
		lines.push('', `${bold('System One')}${kept}`);
		if (systemOne.decisions > 0) {
			lines.push(`  ${decisionOutcomeLine(systemOne)}, ${formatSystemOneCost(systemOne.costUsd)}`);
			const taskWidth = Math.max(...systemOne.byTask.map((task) => task.label.length));
			for (const task of systemOne.byTask) {
				lines.push(
					[
						`  ${c('white', task.label.padEnd(taskWidth))}`,
						decisionOutcomeLine(task),
						latencyCells(task.latency),
					]
						.filter(Boolean)
						.join('  ')
				);
			}
		}
		if (routedTurns > 0) {
			lines.push(
				`  ${c('white', 'Auto routing')}  ${plural(routedTurns, 'turn')}: low ${routed.low}, medium ${routed.medium}, high ${routed.high}`
			);
		}
	}

	const { proxy } = usage;
	if (proxy.totals.requests > 0) {
		lines.push('', bold('Token proxy'));
		lines.push(proxyUsageLine('All agents', proxy.totals));
		for (const row of proxy.byAgent) {
			const label = row.agentId === null ? 'No agent' : (row.name ?? row.agentId.slice(0, 8));
			lines.push(proxyUsageLine(label, row));
		}
		if (proxy.routedRequests > 0) {
			lines.push(
				`  ${plural(proxy.routedRequests, 'background request')} sent to a Local Models target`
			);
		}
		if (proxy.totals.compressRequests > 0) lines.push(dim(`  ${TOKEN_PROXY_ESTIMATE_NOTE}`));
	}
	return lines.join('\n');
}

/**
 * `maestro-cli models server status`: the state and address, the engine build
 * with its accelerator, the models served and loaded, where the key is kept and
 * where the log is. The key itself is never printed here (`models server key`).
 */
export function formatModelServerReport(report: ModelServerReport): string {
	const { status, engine } = report;
	const stateColor: Record<typeof status.state, keyof typeof colors> = {
		running: 'green',
		starting: 'yellow',
		restarting: 'yellow',
		stopping: 'yellow',
		stopped: 'gray',
		failed: 'red',
	};
	const lines = [
		`${bold(c('cyan', MODEL_SERVER_NAME.toUpperCase()))}  ${c(stateColor[status.state], status.state)}`,
	];
	if (status.lastError) lines.push(`  ${c('red', status.lastError)}`);

	const row = (label: string, value: string) => `  ${c('white', label.padEnd(11))}  ${value}`;
	lines.push('');
	lines.push(
		row(
			'Address',
			status.baseUrl
				? `${status.baseUrl}  ${dim(modelServerBindLabel(status.bind))}`
				: dim(`not chosen yet (${modelServerBindLabel(status.bind)})`)
		)
	);
	if (status.pid !== null) lines.push(row('Process', `pid ${status.pid}`));
	if (status.startedAt !== null) lines.push(row('Up since', formatRelativeTime(status.startedAt)));

	if (report.installing) {
		const { phase, bytes, totalBytes, choice } = report.installing;
		const percent =
			totalBytes > 0 ? ` ${Math.min(100, Math.round((bytes / totalBytes) * 100))}%` : '';
		lines.push(row('Engine', c('yellow', `installing the ${choice} build: ${phase}${percent}`)));
	} else if (!engine.installed) {
		lines.push(row('Engine', c('yellow', 'not installed')));
	} else {
		const stale = engine.stale ? c('yellow', '  needs update') : '';
		lines.push(
			row('Engine', `${engine.label} build, ${engine.release}, ${formatSize(engine.bytes)}${stale}`)
		);
	}
	if (engine.accelerator) {
		lines.push(row('Accelerator', engine.accelerator.label));
		const problem = serverAcceleratorProblemMessage(engine.accelerator);
		if (problem) lines.push(`  ${c('yellow', problem)}`);
	}
	if (engine.builds.length > 0) {
		lines.push(
			row(
				'Builds',
				engine.builds
					.map((build) => `${build.choice} (${build.label}, ${formatSize(build.downloadBytes)})`)
					.join(', ')
			)
		);
	}

	lines.push(row('Max loaded', String(status.maxModels)));
	lines.push(row('Serves', status.models.length > 0 ? status.models.join(', ') : dim('-')));
	lines.push(
		row(
			'Loaded',
			report.loaded.length > 0
				? report.loaded
						.map((model) => `${model.displayName} (about ${formatSize(model.approxBytes)})`)
						.join(', ')
				: dim('-')
		)
	);
	lines.push(
		row(
			'Key',
			status.keyStorage === null
				? dim('not made yet')
				: status.keyStorage === 'os'
					? 'sealed by the OS key store'
					: c('yellow', 'obscured (this system has no OS key store)')
		)
	);
	lines.push(row('Log', status.logPath));

	if (!engine.installed && !report.installing) {
		lines.push('', dim('  -> Install the engine: maestro-cli models server set --build default'));
	} else if (status.state === 'stopped' || status.state === 'failed') {
		lines.push('', dim('  -> Start it: maestro-cli models server start'));
	}
	return lines.join('\n');
}

/** What ranks a hit, as the first column of its row: a score, or a match count. */
function workSearchRank(hit: WorkSearchHit): string {
	if (hit.score !== undefined) return formatWorkSearchScore(hit.score);
	const count = hit.matchCount ?? 0;
	return `${count} ${count === 1 ? 'match' : 'matches'}`;
}

/**
 * `maestro-cli search`: one block per hit (rank, source, agent, age, then the
 * title, the snippet, and the id to act on), best first. A semantic search over
 * an index that is still building says so, since a missing result there means
 * "not indexed yet", not "no such work".
 */
export function formatWorkSearchResult(
	query: string,
	result: Extract<WorkSearchResult, { status: 'ok' }>
): string {
	const kind = result.mode === 'semantic' ? 'SEMANTIC SEARCH' : 'TEXT SEARCH';
	const count = `${result.hits.length} ${result.hits.length === 1 ? 'result' : 'results'}`;
	const lines = [`${bold(c('cyan', kind))}  ${dim(`"${truncate(query, 60)}"`)}  ${count}`];
	if (result.modelId) lines.push(dim(`  ${result.modelId}`));
	const indexNote = describeWorkSearchIndex(result.index);
	if (indexNote) lines.push(c('yellow', `  ${indexNote}`));

	if (result.hits.length === 0) {
		lines.push('', dim('  Nothing matched.'));
		return lines.join('\n');
	}

	for (const hit of result.hits) {
		const meta = [
			WORK_SEARCH_SOURCE_LABELS[hit.sourceType],
			hit.history?.type,
			hit.agentName,
			hit.timestamp !== undefined ? formatRelativeTime(hit.timestamp) : undefined,
		].filter((part): part is string => !!part);
		lines.push(
			'',
			`  ${bold(c('green', workSearchRank(hit)))}  ${dim(meta.join(' · '))}`,
			`  ${c('white', hit.title)}`
		);
		if (hit.snippet && hit.snippet !== hit.title) lines.push(`  ${dim(hit.snippet)}`);
		const ids = hit.transcript
			? `agent ${hit.agentId}  tab ${hit.transcript.tabId}`
			: hit.agentId
				? `agent ${hit.agentId}  entry ${hit.sourceId}`
				: `id ${hit.sourceId}`;
		lines.push(dim(`  ${ids}`));
	}
	return lines.join('\n');
}

/**
 * How a catalog model stands, for a person. `pending` is a model this build
 * cannot run and so never offers for download; it is only shown once it is
 * not on disk, since an installed pending model can still be verified and
 * removed.
 */
export type LocalModelDisplayStatus = 'installed' | 'not-installed' | 'corrupt' | 'pending';

export interface LocalModelDisplay {
	id: string;
	displayName: string;
	status: LocalModelDisplayStatus;
	/** Catalog download size, already formatted. */
	size: string;
	/** Tasks (and voice capabilities) that run this model. */
	usedBy: string[];
	/** Why the model is corrupt or pending. */
	detail?: string;
	/** What the model is good at, in one sentence. */
	goodAt?: string;
	/** Role badges, and "Not verified by Maestro" for a model the user added. */
	badges?: string[];
	/** Whether it runs on this computer (`models list --fit`). */
	fit?: { level: 'fits' | 'tight' | 'too-large'; label: string; reason: string };
}

export interface LocalModelGroupDisplay {
	/** The Library group's heading. */
	label: string;
	models: LocalModelDisplay[];
}

/** What `models list` prints around the groups. */
export interface LocalModelsListNotes {
	/** What the fit labels were judged against (`--fit`). */
	hardware?: string;
	/** Why the fit labels are harsher than the hardware deserves (`--fit`). */
	fitCaveat?: string;
	/** The models that are not offered for download at all. */
	cloudOnly?: string;
}

const LOCAL_MODEL_STATUS: Record<
	LocalModelDisplayStatus,
	{ label: string; color: keyof typeof colors }
> = {
	installed: { label: 'installed', color: 'green' },
	'not-installed': { label: 'not installed', color: 'gray' },
	corrupt: { label: 'corrupt', color: 'red' },
	pending: { label: 'pending', color: 'yellow' },
};

const LOCAL_MODEL_FIT_COLOR: Record<
	NonNullable<LocalModelDisplay['fit']>['level'],
	keyof typeof colors
> = {
	fits: 'green',
	tight: 'yellow',
	'too-large': 'red',
};

/**
 * `maestro-cli models list`: every model in the Library's groups, with the disk
 * footprint, what each is good at, and (with `--fit`) whether it runs here.
 */
export function formatLocalModels(
	groups: LocalModelGroupDisplay[],
	footprint: string,
	notes: LocalModelsListNotes = {}
): string {
	const models = groups.flatMap((group) => group.models);
	if (models.length === 0) return dim('No local models match.');

	const lines: string[] = [];
	lines.push(bold(c('cyan', 'LOCAL MODELS')) + dim(` (${models.length}, ${footprint} on disk)`));
	if (notes.hardware) lines.push(dim(`This computer: ${notes.hardware}`));
	if (notes.fitCaveat) lines.push(c('yellow', notes.fitCaveat));
	const idWidth = Math.max(...models.map((model) => model.id.length));
	const statusWidth = Math.max(
		...Object.values(LOCAL_MODEL_STATUS).map((status) => status.label.length)
	);
	for (const group of groups) {
		if (group.models.length === 0) continue;
		lines.push('');
		lines.push(`  ${bold(group.label)}`);
		for (const model of group.models) {
			const status = LOCAL_MODEL_STATUS[model.status];
			const badges = (model.badges ?? []).map((badge) => `[${badge}]`).join(' ');
			lines.push(
				`    ${c('white', model.id.padEnd(idWidth))}  ${c(status.color, status.label.padEnd(statusWidth))}  ${model.size.padStart(9)}  ${model.displayName}${badges ? `  ${dim(badges)}` : ''}`
			);
			const indent = ' '.repeat(idWidth + statusWidth + 17);
			if (model.goodAt) lines.push(`    ${indent}${dim(`good at: ${model.goodAt}`)}`);
			if (model.fit) {
				const label = c(LOCAL_MODEL_FIT_COLOR[model.fit.level], model.fit.label);
				lines.push(`    ${indent}${label}${dim(`: ${model.fit.reason}`)}`);
			}
			if (model.detail) lines.push(`    ${indent}${dim(model.detail)}`);
			if (model.usedBy.length > 0) {
				lines.push(`    ${indent}${dim(`in use by: ${model.usedBy.join(', ')}`)}`);
			}
		}
	}
	if (notes.cloudOnly) {
		lines.push('');
		lines.push(dim(`Cloud only: ${notes.cloudOnly}`));
	}
	return lines.join('\n');
}

export interface LocalModelTaskDisplay {
	taskId: string;
	label: string;
	/** The assignment in its `models assign` spelling. */
	spec: string;
	/** Absent when the desktop could not be asked. */
	readiness?: LocalModelTaskReadiness;
}

/**
 * `maestro-cli models tasks`: every task with its assignment, and its readiness
 * when the desktop answered. Without the desktop the assignments still print,
 * since they are read from the settings file.
 */
export function formatLocalModelTasks(
	rows: LocalModelTaskDisplay[],
	readinessError?: string
): string {
	const lines: string[] = [];
	lines.push(bold(c('cyan', 'LOCAL MODEL TASKS')) + dim(` (${rows.length})`));
	lines.push('');
	const idWidth = Math.max(...rows.map((row) => row.taskId.length));
	const specWidth = Math.max(...rows.map((row) => row.spec.length));
	for (const row of rows) {
		const state = row.readiness ? TASK_READINESS_STATE[row.readiness.state] : undefined;
		const stateText = state ? c(state.color, state.label) : '';
		lines.push(
			`  ${c('white', row.taskId.padEnd(idWidth))}  ${c('blue', row.spec.padEnd(specWidth))}  ${stateText}`
		);
		const indent = ' '.repeat(idWidth + 4);
		lines.push(`${indent}${dim(row.label)}`);
		if (row.readiness?.state === 'unavailable') {
			const reason = row.readiness.reason ? ` [${row.readiness.reason}]` : '';
			lines.push(`${indent}${row.readiness.detail}${dim(reason)}`);
			if (row.readiness.suggestedAction) {
				lines.push(`${indent}${dim(`-> ${row.readiness.suggestedAction}`)}`);
			}
		}
	}
	if (readinessError) {
		lines.push('');
		lines.push(dim(`Readiness unavailable (${readinessError}). Assignments are from settings.`));
	}
	return lines.join('\n');
}

// Harness tier defaults formatting

/** One tier of one harness, as `models tiers list` and `suggest` print it. */
export interface HarnessTierDisplay {
	tier: string;
	/** The target's spelling, or null when the tier has none. */
	spec: string | null;
	/** The layer it came from, or the reason beside a suggestion. */
	note: string;
	/** Why the stored value cannot be used. */
	problem?: string;
}

export interface HarnessTiersDisplay {
	harness: string;
	name: string;
	tiers: HarnessTierDisplay[];
}

/** The tiers of each harness: value, then the layer (or reason) it came from. */
export function formatHarnessTiers(title: string, harnesses: HarnessTiersDisplay[]): string {
	const lines: string[] = [bold(c('cyan', title)) + dim(` (${harnesses.length})`)];
	const specs = harnesses.flatMap((row) => row.tiers.map((tier) => tier.spec ?? '-'));
	const specWidth = Math.max(1, ...specs.map((spec) => spec.length));
	for (const row of harnesses) {
		lines.push('');
		lines.push(`  ${c('white', row.name)} ${dim(`(${row.harness})`)}`);
		for (const tier of row.tiers) {
			const spec = (tier.spec ?? '-').padEnd(specWidth);
			lines.push(
				`    ${tier.tier.padEnd(6)}  ${tier.spec ? c('blue', spec) : dim(spec)}  ${dim(tier.note)}`
			);
			if (tier.problem) lines.push(`            ${c('red', tier.problem)}`);
		}
	}
	return lines.join('\n');
}

export interface HarnessTierOptionsDisplay {
	harness: string;
	name: string;
	installed: boolean;
	/** The harness's own models, each as the spelling `models tiers set` takes. */
	catalog: Array<{ spec: string; priority?: number; description?: string }>;
	/** Why the harness cannot run on a source, when it cannot. */
	runOnReason?: string;
	sources: Array<{ name: string; specs: string[] }>;
	problems: Array<{ name: string; message: string }>;
}

/** What one harness can launch a tier on, each choice in the spelling `set` takes. */
export function formatHarnessTierOptions(options: HarnessTierOptionsDisplay): string {
	const lines: string[] = [
		bold(c('cyan', 'TIER OPTIONS')) +
			`  ${c('white', options.name)} ${dim(`(${options.harness})`)}`,
	];
	if (!options.installed) {
		lines.push('');
		lines.push(c('yellow', `  ${options.name} was not found on this machine.`));
	}
	lines.push('');
	lines.push(`  ${bold('Catalogue')}${dim(` (${options.catalog.length})`)}`);
	if (options.catalog.length === 0) lines.push(dim('    (lists nothing)'));
	const width = Math.max(1, ...options.catalog.map((model) => model.spec.length));
	for (const model of options.catalog) {
		const facts = [
			...(model.priority === undefined ? [] : [`priority ${model.priority}`]),
			...(model.description ? [model.description] : []),
		].join('  ');
		lines.push(`    ${c('blue', model.spec.padEnd(width))}${facts ? `  ${dim(facts)}` : ''}`);
	}
	for (const source of options.sources) {
		lines.push('');
		lines.push(`  ${bold(source.name)}${dim(` (${source.specs.length})`)}`);
		for (const spec of source.specs) lines.push(`    ${c('blue', spec)}`);
	}
	if (options.runOnReason) {
		lines.push('');
		lines.push(dim(`  Provider models only. ${options.runOnReason}`));
	}
	for (const problem of options.problems) {
		lines.push('');
		lines.push(c('yellow', `  ${problem.name}: ${problem.message}`));
	}
	return lines.join('\n');
}

// Director's Notes History formatting
export interface DirectorNotesHistoryDisplay {
	stats: {
		agentCount: number;
		autoCount: number;
		userCount: number;
		cueCount: number;
		agentEntryCount: number;
		relayCount: number;
		totalCount: number;
		lookbackDays: number;
	};
	total: number;
	showing: number;
	entries: Array<{
		id: string;
		type: string;
		timestamp: number;
		summary: string;
		agentName?: string;
		sourceSessionId: string;
		success?: boolean;
		elapsedTimeMs?: number;
		usageStats?: { totalCostUsd?: number };
	}>;
}

export function formatDirectorNotesHistory(
	data: DirectorNotesHistoryDisplay,
	lookbackDays: number
): string {
	const lines: string[] = [];

	// Header
	const period =
		lookbackDays > 0 ? `last ${lookbackDays} day${lookbackDays !== 1 ? 's' : ''}` : 'all time';
	lines.push(bold(c('cyan', "DIRECTOR'S NOTES - HISTORY")) + dim(` (${period})`));
	lines.push('');

	// Stats
	const { stats } = data;
	lines.push(
		`  ${c('white', 'Agents:')}   ${stats.agentCount}    ${c('white', 'Entries:')} ${stats.totalCount} ${dim(`(${stats.autoCount} auto, ${stats.userCount} user, ${stats.cueCount} cue, ${stats.agentEntryCount} agent, ${stats.relayCount} relay)`)}`
	);
	lines.push(`  ${c('white', 'Showing:')}  ${data.showing} of ${data.total}`);
	lines.push('');

	if (data.entries.length === 0) {
		lines.push(dim('  No entries found for the specified period.'));
		return lines.join('\n');
	}

	for (const entry of data.entries) {
		const date = new Date(entry.timestamp);
		const dateStr = date.toLocaleDateString();
		const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		const icon =
			entry.success === true
				? c('green', '✓')
				: entry.success === false
					? c('red', '✗')
					: c('gray', '•');
		const typeLabel =
			entry.type === 'AUTO'
				? c('blue', '[AUTO]')
				: entry.type === 'CUE'
					? c('magenta', '[CUE]')
					: entry.type === 'AGENT'
						? c('cyan', '[AGENT]')
						: entry.type === 'RELAY'
							? c('cyan', '[RELAY]')
							: c('yellow', '[USER]');
		const agent = entry.agentName
			? c('white', truncate(entry.agentName, 20))
			: dim(entry.sourceSessionId.slice(0, 8));
		const summary = truncate(entry.summary || '', 50);
		const costStr =
			entry.usageStats?.totalCostUsd !== undefined
				? dim(` $${entry.usageStats.totalCostUsd.toFixed(4)}`)
				: '';
		const timeElapsed = entry.elapsedTimeMs ? dim(` ${formatDuration(entry.elapsedTimeMs)}`) : '';

		lines.push(
			`  ${icon} ${dim(`${dateStr} ${timeStr}`)} ${typeLabel} ${agent}  ${summary}${costStr}${timeElapsed}`
		);
	}

	return lines.join('\n');
}

/** A key's source as one phrase. Yellow when it is weaker than a sealed key, or cannot be used. */
function formatSystemOneKey(info: SystemOneKeyInfo): string {
	const text = describeSystemOneKey(info);
	if (info.source === 'none') return dim(text);
	const weak =
		info.source === 'stored' && (info.problem !== undefined || info.storage === 'obscured');
	return weak ? c('yellow', text) : text;
}

/**
 * `maestro-cli s1 status`: the engine in force, where it is called, the model,
 * the budget, where each key comes from, and the fail policies. No key is in
 * the report, so none can be printed.
 */
export function formatSystemOneReport(report: SystemOneReport): string {
	const { settings } = report;
	const off = settings.engine === 'off';
	const lines = [
		`${bold(c('cyan', 'SYSTEM ONE'))}  ${off ? c('gray', report.engineLabel) : report.engineLabel}`,
	];
	if (report.problem) lines.push(`  ${c('yellow', report.problem)}`);

	const row = (label: string, value: string) => `  ${c('white', label.padEnd(9))}  ${value}`;
	lines.push('');
	lines.push(
		row(
			'Engine',
			off
				? dim('off')
				: `${settings.engine}  ${dim(report.calibrated ? 'calibrated' : 'not calibrated')}`
		)
	);
	if (report.baseUrl) lines.push(row('Address', report.baseUrl));
	if (!off) {
		const fallback =
			settings.engine === 'jev-cloud'
				? `${JEV_DEFAULT_MODEL} ${dim('(the newest release; not pinned)')}`
				: settings.engine === 'openjev'
					? dim('the one the server was started with (not pinned)')
					: c('yellow', 'none assigned');
		lines.push(
			row(
				'Model',
				report.model === null
					? fallback
					: report.modelLabel && report.modelLabel !== report.model
						? `${report.modelLabel}  ${dim(report.model)}`
						: report.model
			)
		);
	}
	if (report.timeoutMs !== null) lines.push(row('Timeout', `${report.timeoutMs} ms`));
	lines.push(row('Sends', report.disclosure));

	lines.push('', `  ${c('white', 'Keys')}`);
	for (const engine of SYSTEM_ONE_REMOTE_ENGINE_IDS) {
		lines.push(`    ${engine.padEnd(9)}  ${formatSystemOneKey(report.keys[engine])}`);
	}

	if (report.failPolicies.length > 0) {
		const width = Math.max(...report.failPolicies.map((policy) => policy.taskId.length));
		lines.push(
			'',
			`  ${c('white', 'Fail policies')} ${dim('(what a task does when the engine gives no answer)')}`
		);
		for (const policy of report.failPolicies) {
			const note = policy.policy === policy.defaultPolicy ? dim('  default') : '';
			lines.push(`    ${policy.taskId.padEnd(width)}  ${policy.policy}${note}`);
		}
	}

	lines.push(
		'',
		`  ${c('white', 'Ledger')}  ${settings.keepInputs ? c('yellow', 'keeps inputs, redacted') : 'keeps question ids and answers, not inputs'}  ${dim('maestro-cli s1 ledger')}`
	);

	// What agents may ask and spend. On means nothing until the engine has
	// passed its Test, so the line under it says what still stands in the way.
	const { agents } = settings;
	const cap =
		agents.perAgentBudgetUsd === null
			? 'no cap per agent'
			: `${formatSystemOneCost(agents.perAgentBudgetUsd)} a day per agent`;
	lines.push(
		'',
		`  ${c('white', 'Agents')}  ${agents.enabled ? 'may ask' : c('yellow', 'may not ask')}  ${dim(`budget ${formatSystemOneCost(agents.dailyBudgetUsd)} a day across all agents, ${cap}`)}  ${dim('maestro-cli s1 usage')}`
	);
	const blocker = agents.enabled ? systemOneAgentUseBlocker(report) : null;
	if (blocker) lines.push(`    ${c('yellow', blocker)}`);
	else if (agents.enabled && report.testPassedAt !== null) {
		lines.push(
			`    ${dim(`The engine passed its Test ${formatRelativeTime(report.testPassedAt)}.`)}`
		);
	}

	if (off) {
		lines.push(
			'',
			dim('  -> Choose an engine: maestro-cli s1 set engine jev-cloud|openjev|local-judge')
		);
	} else if (!report.problem) {
		lines.push('', dim('  -> Check that it answers: maestro-cli s1 test'));
	}
	return lines.join('\n');
}

/** `maestro-cli s1 test`: the answer, the latency, and which engine gave it. */
export function formatSystemOneTestResult(result: SystemOneTestResult): string {
	if (!result.ok) {
		const engine = result.engine === 'off' ? systemOneEngineChoiceLabel('off') : result.engineLabel;
		return `${c('red', '✗')} ${engine}: no answer ${dim(`(${result.code})`)}\n  ${result.error}`;
	}
	const said = result.probability >= 0.5 ? 'yes' : 'no';
	const lines = [
		`${c('green', '✓')} ${result.engineLabel} answered in ${result.latencyMs} ms`,
		`  Answer   ${said}, P(yes) ${result.probability.toFixed(2)}  ${dim(result.calibrated ? 'calibrated' : 'not calibrated')}`,
		`  Model    ${result.model}`,
		`  Tokens   ${result.usage.inputTokens} in, ${result.usage.outputTokens} out`,
	];
	if (said === 'no') {
		lines.push(c('yellow', '  The right answer to the test question is yes.'));
	}
	return lines.join('\n');
}

/** A ledger row's time in the reader's zone, to the second: "2026-10-12 14:03:09". */
function formatLedgerTime(at: number): string {
	const date = new Date(at);
	const two = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function ledgerOutcomeColor(entry: SystemOneLedgerEntry): Parameters<typeof c>[0] {
	if (entry.outcome === 'ok') return 'green';
	if (entry.outcome === 'cancelled') return 'gray';
	return entry.outcome === 'failed-closed' ? 'red' : 'yellow';
}

/**
 * `maestro-cli s1 ledger`: one line per decision, newest first, with what was
 * answered or why there was no answer. A kept input is printed under its row.
 */
export function formatSystemOneLedger(page: SystemOneLedgerPage): string {
	const lines = [
		`${bold(c('cyan', 'SYSTEM ONE LEDGER'))}  ${dim(`${page.entries.length} of ${page.total}, kept ${page.retentionDays} days`)}`,
	];
	if (page.notice) lines.push(`  ${c('yellow', page.notice)}`);
	if (page.entries.length === 0) {
		lines.push('', dim('  No decisions match.'));
		return lines.join('\n');
	}

	const taskWidth = Math.max(...page.entries.map((entry) => entry.taskId.length));
	const engineWidth = Math.max(...page.entries.map((entry) => entry.engine.length));
	const outcomeWidth = Math.max(
		...page.entries.map((entry) => SYSTEM_ONE_LEDGER_OUTCOME_LABELS[entry.outcome].length)
	);
	lines.push('');
	for (const entry of page.entries) {
		const outcome = SYSTEM_ONE_LEDGER_OUTCOME_LABELS[entry.outcome].padEnd(outcomeWidth);
		lines.push(
			`  ${dim(formatLedgerTime(entry.startedAt))}  ${c('white', entry.taskId.padEnd(taskWidth))}  ${entry.engine.padEnd(engineWidth)}  ${c(ledgerOutcomeColor(entry), outcome)}  ${summarizeSystemOneDecision(entry)}  ${dim(`${entry.latencyMs} ms`)}`
		);
		if (entry.input !== undefined) lines.push(`    ${dim(entry.input)}`);
	}
	return lines.join('\n');
}

// Plain-text tables

/** The narrowest a column shrinks to when a table is capped to the terminal width. */
const MIN_TABLE_COLUMN_WIDTH = 5;

export interface TextTableOptions {
	/**
	 * Cap each line at this many characters (usually `process.stdout.columns`). The widest columns
	 * shrink first and their cells are truncated with an ellipsis; no column goes below
	 * {@link MIN_TABLE_COLUMN_WIDTH}, so a very narrow terminal can still wrap. Uncapped when omitted.
	 */
	maxWidth?: number;
}

/** The largest per-column cap at which every column fits `budget`, never below the minimum. */
function capColumnWidths(widths: number[], budget: number): number[] {
	const total = (cap: number) => widths.reduce((sum, width) => sum + Math.min(width, cap), 0);
	if (total(Infinity) <= budget) return widths;
	let low = MIN_TABLE_COLUMN_WIDTH;
	let high = Math.max(low, ...widths);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (total(mid) <= budget) low = mid;
		else high = mid - 1;
	}
	return widths.map((width) => Math.min(width, low));
}

/**
 * Lay `rows` out under `headers` as plain-text columns: each column as wide as its widest cell, two
 * spaces between columns, the last column unpadded and trailing spaces trimmed. Newlines and tabs in a
 * cell become spaces so a row stays on one line.
 */
export function formatTextTable(
	headers: string[],
	rows: string[][],
	options: TextTableOptions = {}
): string {
	const clean = (cell: string) => cell.replace(/[\r\n\t]+/g, ' ');
	const lines = [headers, ...rows].map((row) => headers.map((_, i) => clean(row[i] ?? '')));
	const natural = headers.map((_, i) => Math.max(...lines.map((line) => line[i].length)));
	const gaps = 2 * Math.max(0, headers.length - 1);
	const widths =
		options.maxWidth === undefined
			? natural
			: capColumnWidths(natural, Math.max(0, options.maxWidth - gaps));
	return lines
		.map((line) =>
			line
				.map((cell, i) => {
					const text = truncate(cell, widths[i]);
					return i === line.length - 1 ? text : text.padEnd(widths[i]);
				})
				.join('  ')
				.trimEnd()
		)
		.join('\n');
}

// Error formatting
export function formatError(message: string): string {
	return `${c('red', '✗')} ${c('red', 'Error:')} ${message}`;
}

// Success message
export function formatSuccess(message: string): string {
	return `${c('green', '✓')} ${message}`;
}

// Info message
export function formatInfo(message: string): string {
	return `${c('blue', 'ℹ')} ${message}`;
}

// Warning message
export function formatWarning(message: string): string {
	return `${c('yellow', '⚠')} ${message}`;
}

const TAB_CLEANUP_ACTION_COLORS = { close: 'red', snooze: 'yellow', wake: 'green' } as const;

/**
 * Render `maestro-cli tab suggest-cleanup`: one block per suggestion, with the
 * command that applies it. The verb changes nothing itself, so the last line of
 * each block is the whole point: what to run if the suggestion is right.
 */
export function formatTabCleanupSuggestions(
	result: Extract<TabCleanupResult, { success: true }>,
	now: number = Date.now()
): string {
	const coverage = describeTabCleanupCoverage(result);
	const lines = [
		`${bold(c('cyan', 'TAB CLEANUP'))}  ${result.suggestions.length} ${
			result.suggestions.length === 1 ? 'suggestion' : 'suggestions'
		}`,
		dim(`  ${coverage}${result.producedBy ? `. Suggested by ${result.producedBy}` : ''}.`),
	];
	if (result.suggestions.length === 0) {
		lines.push('', '  Nothing to clean up.');
		return lines.join('\n');
	}
	for (const suggestion of result.suggestions) {
		const when =
			suggestion.kind === 'snoozed' && suggestion.wakeAt !== undefined
				? `snoozed until ${formatSnoozeTarget(suggestion.wakeAt, now)}`
				: `last active ${formatTabCleanupAge(suggestion.lastActivityAt, now)}`;
		lines.push(
			'',
			`  ${c(TAB_CLEANUP_ACTION_COLORS[suggestion.action], suggestion.action.padEnd(6))}  ${c('white', suggestion.label)}`,
			dim(`          ${suggestion.agentName} | ${when}`)
		);
		if (suggestion.reason) lines.push(`          ${suggestion.reason}`);
		lines.push(dim(`          -> ${tabCleanupApplyCommand(suggestion)}`));
	}
	lines.push('', dim('  Nothing was changed. Run a command above to apply a suggestion.'));
	return lines.join('\n');
}

// ============================================================================
// Group Settings
// ============================================================================

/**
 * One group default as a line of text, in the spelling the flag that sets it
 * takes. A secret never prints: environment variables are named, not shown.
 */
export function describeGroupDefaultValue(
	key: GroupDefaultKey,
	value: GroupDefaultsFieldChange['after']
): string {
	switch (key) {
		case 'customEnvVars':
		case 'customEnvVarsDisabled': {
			const names = Object.keys((value ?? {}) as Record<string, string>);
			return names.length > 0 ? names.join(', ') : '(none)';
		}
		case 'runOn':
			return value
				? formatRunOnSpec(value as NonNullable<GroupAgentDefaults['runOn']>)
				: 'provider';
		case 'tierTargets': {
			const tiers = (value ?? {}) as Record<string, TierTarget | undefined>;
			const set = TIER_LEVELS.filter((tier) => tiers[tier] !== undefined);
			return set.length > 0
				? set.map((tier) => `${tier}=${formatTierTargetSpec(tiers[tier])}`).join(', ')
				: '(none)';
		}
		case 'backgroundRequests':
			return formatBackgroundRequestsSpec(
				value as NonNullable<GroupAgentDefaults['backgroundRequests']> | undefined
			);
		case 'peerAgents': {
			const rows = (value ?? []) as NonNullable<GroupAgentDefaults['peerAgents']>;
			return rows.length > 0
				? rows.map((row) => `${row.sessionId}:${peerAccessLabel(row)}`).join(', ')
				: '(none)';
		}
		case 'groupPeerAccess':
		case 'worktreePeerAccess':
			return value ? peerAccessLabel(value as { read: boolean; write: boolean }) : 'off';
		case 'additionalDirectories': {
			const dirs = (value ?? []) as NonNullable<GroupAgentDefaults['additionalDirectories']>;
			return dirs.length > 0 ? dirs.map((dir) => dir.path).join(', ') : '(none)';
		}
		case 'sessionSshRemoteConfig': {
			const ssh = value as GroupAgentDefaults['sessionSshRemoteConfig'];
			if (!ssh?.enabled || !ssh.remoteId) return 'local';
			return ssh.workingDirOverride
				? `${ssh.remoteId} (cwd ${ssh.workingDirOverride})`
				: ssh.remoteId;
		}
		case 'systemOneOptOut':
			return value ? 'off' : 'on';
		default:
			if (typeof value === 'boolean') return value ? 'on' : 'off';
			return value === undefined || value === null ? '(none)' : String(value);
	}
}

/** What `group-settings` knows about one group, as `describeGroupSettings` returns it. */
export interface GroupSettingsView {
	id: string;
	name: string;
	emoji: string;
	shortLabel: string | null;
	badgeLabel: string;
	badgeLabelSource: 'custom' | 'automatic';
	defaults: GroupAgentDefaults | null;
}

/**
 * Render `maestro-cli group-settings`: the pill label (and whether Maestro or
 * the user chose it), then every default a new agent in the group starts with.
 */
export function formatGroupSettings(group: GroupSettingsView): string {
	const lines = [
		`${bold(c('cyan', 'GROUP'))}  ${group.emoji} ${c('white', group.name)} ${dim(`(${group.id})`)}`,
		'',
		`  ${c('white', 'Pill label:')}  ${group.badgeLabel} ${dim(
			group.badgeLabelSource === 'custom' ? '(custom)' : '(automatic, abbreviated from the name)'
		)}`,
		'',
	];
	if (!group.defaults) {
		lines.push(`  ${c('white', 'Defaults:')}    ${dim('no defaults')}`);
		return lines.join('\n');
	}
	lines.push(`  ${bold(c('white', 'Defaults for a new agent in this group'))}`);
	const keys = Object.keys(group.defaults) as GroupDefaultKey[];
	const width = Math.max(...keys.map((key) => groupDefaultLabel(key).length)) + 1;
	for (const key of keys) {
		lines.push(
			`    ${`${groupDefaultLabel(key)}:`.padEnd(width + 1)} ${describeGroupDefaultValue(key, group.defaults[key])}`
		);
	}
	return lines.join('\n');
}

/** What `update-group-settings` did, for a person. */
export function formatGroupSettingsUpdate(
	group: GroupSettingsView,
	changed: readonly string[],
	publish: GroupSettingsPublishReport | undefined
): string {
	const lines = [formatSuccess(`Updated group settings for ${group.emoji} ${group.name}`)];
	if (changed.length > 0) lines.push(`  Changed: ${changed.join(', ')}`);
	else lines.push(dim('  The profile already held these values.'));
	lines.push(`  Pill label: ${group.badgeLabel} ${dim(`(${group.badgeLabelSource})`)}`);
	if (publish) {
		const count = publish.agents.length;
		lines.push(
			count > 0
				? `  Published to ${count} ${count === 1 ? 'agent' : 'agents'}: ${publish.agents.map((agent) => agent.name).join(', ')}`
				: dim('  Nothing to publish: the agents in the group already had these settings.')
		);
		if (publish.replaced.length > 0) {
			lines.push(`  Replaced (the agent's own rows are gone): ${publish.replaced.join(', ')}`);
		}
		if (publish.providerBound.length > 0) {
			lines.push(
				`  Reached only agents on the profile's provider: ${publish.providerBound.join(', ')}`
			);
		}
		if (publish.unpublished.length > 0) {
			lines.push(`  Not published (new agents only): ${publish.unpublished.join(', ')}`);
		}
		for (const skip of publish.skipped) {
			lines.push(`  Skipped on ${skip.agentName}: ${skip.label}. ${skip.reason}`);
		}
	}
	return lines.join('\n');
}

/** What `maestro-cli delegation graph` prints for a person. */
export interface DelegationGraphView {
	/** The group the graph is about, or `null` for the graph of every agent. */
	group: { id: string; name: string; emoji?: string } | null;
	stats: DelegationGraphStats;
	/** `delegationAdjacency()` of the model: one entry per agent on the graph. */
	agents: DelegationAdjacencyEntry[];
}

/**
 * Render `maestro-cli delegation graph`: the Delegation Graph as an adjacency
 * listing. Each agent is followed by the edges that leave it (whom it may
 * consult or delegate to, with the grant that produced the edge) and by the
 * names of the agents that reach it. An edge is printed once, under its source.
 */
export function formatDelegationGraph(view: DelegationGraphView): string {
	const { group, stats, agents } = view;
	const scope = group
		? `${group.emoji ? `${group.emoji} ` : ''}${c('white', group.name)} ${dim(`(${group.id})`)}`
		: c('white', 'All agents');
	const lines = [`${bold(c('cyan', 'DELEGATION GRAPH'))}  ${scope}`];
	if (agents.length === 0) {
		lines.push('', dim(group ? '  No agents in this group.' : '  No agents found.'));
		return lines.join('\n');
	}
	lines.push(`  ${dim(describeDelegationGraphStats(stats).join(', '))}`);

	// A `spill` agent lists only the edges that join it to the group, so
	// "nobody" is true of the group and not of the fleet. Say which.
	for (const { node, reaches, reachedBy } of agents) {
		const outside = node.scope === 'spill';
		const where = outside ? ' in this group' : '';
		lines.push('');
		lines.push(
			`  ${c('white', node.name)} ${dim(`(${node.sessionId})`)}${outside ? dim(' [outside the group]') : ''}`
		);
		if (reaches.length === 0 && reachedBy.length === 0) {
			lines.push(`    ${c('yellow', 'no peers in either direction')}`);
			continue;
		}
		if (reaches.length === 0) lines.push(`    ${dim(`reaches nobody${where}`)}`);
		for (const { edge, peer, mutual } of reaches) {
			const note = edge.description ? dim(` - ${truncate(edge.description, 60)}`) : '';
			lines.push(
				`    -> ${peer.name} ${dim(`(${peer.sessionId})`)}  ${peerAccessLabel(edge)} ${dim(`[${edge.source}]`)}${mutual ? dim(' (mutual)') : ''}${note}`
			);
		}
		lines.push(
			reachedBy.length === 0
				? `    ${dim(`reached by nobody${where}`)}`
				: `    ${dim('reached by:')} ${reachedBy.map((link) => link.peer.name).join(', ')}`
		);
	}
	return lines.join('\n');
}
