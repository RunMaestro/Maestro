// Human-readable output formatter for CLI
// Provides beautiful, colored terminal output

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
		lines.push(`  ${emoji}  ${name}`);
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

		lines.push(`  ${name} ${toolType}${autoRun}`);
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

/**
 * Format duration for CLI display (decimal format with ms/s/m/h suffixes).
 * Note: This differs from shared/formatters.ts formatElapsedTime which
 * shows combined units like "5m 12s". This version uses single decimals
 * like "5.2m" for compact CLI output.
 */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3600_000).toFixed(1)}h`;
}

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
