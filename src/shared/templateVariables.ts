import { buildSessionDeepLink, buildGroupDeepLink } from './deep-link-urls';

/**
 * Template Variable System for Auto Run and Custom AI Commands
 *
 * Available variables (case-insensitive):
 *
 * Conductor Variables (the Maestro user):
 *   {{CONDUCTOR_PROFILE}} - User's About Me profile (from Settings → General)
 *
 * Agent Variables:
 *   {{AGENT_NAME}}        - Agent name
 *   {{AGENT_PATH}}        - Agent home directory path (full path to project)
 *   {{AGENT_GROUP}}       - Agent's group name (if grouped)
 *   {{AGENT_SESSION_ID}}  - Agent session ID (for conversation continuity)
 *   {{AGENT_HISTORY_PATH}} - Path to agent's history JSON file (for task recall)
 *   {{TAB_NAME}}          - Custom tab name (alias: SESSION_NAME)
 *   {{TOOL_TYPE}}         - Agent type (claude-code, codex, opencode, factory-droid)
 *
 * Path Variables:
 *   {{CWD}}               - Current working directory
 *   {{AUTORUN_FOLDER}}    - Auto Run documents folder path
 *
 * Auto Run Variables:
 *   {{DOCUMENT_NAME}}     - Current Auto Run document name (without .md)
 *   {{DOCUMENT_PATH}}     - Full path to current Auto Run document
 *   {{LOOP_NUMBER}}       - Current loop iteration (5-digit padded, e.g., 00001)
 *
 * Date/Time Variables:
 *   {{DATE}}              - Current date (YYYY-MM-DD)
 *   {{TIME}}              - Current time (HH:MM:SS)
 *   {{DATETIME}}          - Full datetime (YYYY-MM-DD HH:MM:SS)
 *   {{TIMESTAMP}}         - Unix timestamp in milliseconds
 *   {{DATE_SHORT}}        - Short date (MM/DD/YY)
 *   {{TIME_SHORT}}        - Short time (HH:MM)
 *   {{YEAR}}              - Current year (YYYY)
 *   {{MONTH}}             - Current month (01-12)
 *   {{DAY}}               - Current day (01-31)
 *   {{WEEKDAY}}           - Day of week (Monday, Tuesday, etc.)
 *
 * Git Variables (if available):
 *   {{GIT_BRANCH}}        - Current git branch name (requires git repo)
 *   {{IS_GIT_REPO}}       - "true" or "false"
 *
 * Deep Link Variables:
 *   {{AGENT_DEEP_LINK}}   - maestro:// deep link to this agent
 *   {{TAB_DEEP_LINK}}     - maestro:// deep link to this agent + active tab
 *   {{GROUP_DEEP_LINK}}   - maestro:// deep link to this agent's group (if grouped)
 *
 * Context Variables:
 *   {{CONTEXT_USAGE}}     - Current context window usage percentage
 *
 * Cue Variables (Cue automation only):
 *   {{CUE_EVENT_TYPE}}      - Cue event type (time.interval, file.changed, agent.completed)
 *   {{CUE_EVENT_TIMESTAMP}} - Cue event timestamp
 *   {{CUE_TRIGGER_NAME}}   - Cue trigger/subscription name
 *   {{CUE_RUN_ID}}         - Cue run UUID
 *   {{CUE_FILE_PATH}}      - Changed file path (file.changed events)
 *   {{CUE_FILE_NAME}}      - Changed file name
 *   {{CUE_FILE_DIR}}       - Changed file directory
 *   {{CUE_FILE_EXT}}       - Changed file extension
 *   {{CUE_FILE_CHANGE_TYPE}} - Change type: add, change, or unlink (file.changed events)
 *   {{CUE_SOURCE_SESSION}} - Source session name (agent.completed events)
 *   {{CUE_SOURCE_OUTPUT}}  - Source session output (agent.completed events)
 *   {{CUE_SOURCE_STATUS}}  - Source run status: completed, failed, timeout (agent.completed events)
 *   {{CUE_SOURCE_EXIT_CODE}} - Source process exit code (agent.completed events)
 *   {{CUE_SOURCE_DURATION}} - Source run duration in ms (agent.completed events)
 *   {{CUE_SOURCE_TRIGGERED_BY}} - Subscription that triggered the source (agent.completed events)
 *
 *   {{CUE_TASK_FILE}}        - File path with pending tasks (task.pending events)
 *   {{CUE_TASK_FILE_NAME}}   - File name with pending tasks (task.pending events)
 *   {{CUE_TASK_FILE_DIR}}    - Directory of file with pending tasks (task.pending events)
 *   {{CUE_TASK_COUNT}}       - Number of pending tasks found (task.pending events)
 *   {{CUE_TASK_LIST}}        - Formatted list of pending tasks (task.pending events)
 *   {{CUE_TASK_CONTENT}}     - Full file content, truncated to 10K chars (task.pending events)
 *
 *   {{CUE_GH_TYPE}}         - GitHub item type: "pull_request" or "issue" (github.* events)
 *   {{CUE_GH_NUMBER}}       - PR/issue number (github.* events)
 *   {{CUE_GH_TITLE}}        - PR/issue title (github.* events)
 *   {{CUE_GH_AUTHOR}}       - PR/issue author login (github.* events)
 *   {{CUE_GH_URL}}          - PR/issue HTML URL (github.* events)
 *   {{CUE_GH_BODY}}         - PR/issue body text, truncated (github.* events)
 *   {{CUE_GH_LABELS}}       - Comma-separated labels (github.* events)
 *   {{CUE_GH_STATE}}        - State: "open" or "closed" (github.* events)
 *   {{CUE_GH_REPO}}         - GitHub repo (owner/repo) (github.* events)
 *   {{CUE_GH_BRANCH}}       - Head branch (github.pull_request events)
 *   {{CUE_GH_BASE_BRANCH}}  - Base branch (github.pull_request events)
 *   {{CUE_GH_ASSIGNEES}}    - Comma-separated assignees (github.issue events)
 */

/**
 * Minimal session interface that works for both CLI (SessionInfo) and renderer (Session)
 */
export interface TemplateSessionInfo {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	projectRoot?: string;
	fullPath?: string;
	autoRunFolderPath?: string;
	agentSessionId?: string;
	isGitRepo?: boolean;
	contextUsage?: number;
}

export interface TemplateContext {
	session: TemplateSessionInfo;
	gitBranch?: string;
	groupName?: string;
	groupId?: string;
	activeTabId?: string;
	autoRunFolder?: string;
	loopNumber?: number;
	// Auto Run document context
	documentName?: string;
	documentPath?: string;
	// History file path for task recall
	historyFilePath?: string;
	// Conductor profile (user's About Me from settings)
	conductorProfile?: string;
	// Cue event context (for Cue automation prompts)
	cue?: {
		eventType?: string;
		eventTimestamp?: string;
		triggerName?: string;
		runId?: string;
		filePath?: string;
		fileName?: string;
		fileDir?: string;
		fileExt?: string;
		fileChangeType?: string;
		sourceSession?: string;
		sourceOutput?: string;
		sourceStatus?: string;
		sourceExitCode?: string;
		sourceDuration?: string;
		sourceTriggeredBy?: string;
		// Task pending fields (task.pending)
		taskFile?: string;
		taskFileName?: string;
		taskFileDir?: string;
		taskCount?: string;
		taskList?: string;
		taskContent?: string;
		// GitHub event fields (github.pull_request, github.issue)
		ghType?: string;
		ghNumber?: string;
		ghTitle?: string;
		ghAuthor?: string;
		ghUrl?: string;
		ghBody?: string;
		ghLabels?: string;
		ghState?: string;
		ghRepo?: string;
		ghBranch?: string;
		ghBaseBranch?: string;
		ghAssignees?: string;
	};
}

// List of all available template variables for documentation (alphabetically sorted)
// Variables marked as autoRunOnly are only shown in Auto Run contexts, not in AI Commands settings
// Variables marked as cueOnly are only shown in Cue automation contexts
export const TEMPLATE_VARIABLES = [
	{ variable: '{{AGENT_DEEP_LINK}}', description: 'Deep link to this agent (maestro://)' },
	{ variable: '{{AGENT_GROUP}}', description: 'Agent group name' },
	{ variable: '{{CONDUCTOR_PROFILE}}', description: "Conductor's About Me profile" },
	{ variable: '{{AGENT_HISTORY_PATH}}', description: 'History file path (task recall)' },
	{ variable: '{{AGENT_NAME}}', description: 'Agent name' },
	{ variable: '{{AGENT_PATH}}', description: 'Agent home directory path' },
	{ variable: '{{AGENT_SESSION_ID}}', description: 'Agent session ID' },
	{ variable: '{{AUTORUN_FOLDER}}', description: 'Auto Run folder path', autoRunOnly: true },
	{ variable: '{{TAB_NAME}}', description: 'Custom tab name' },
	{ variable: '{{CONTEXT_USAGE}}', description: 'Context usage %' },
	{ variable: '{{CUE_EVENT_TIMESTAMP}}', description: 'Cue event timestamp', cueOnly: true },
	{ variable: '{{CUE_EVENT_TYPE}}', description: 'Cue event type', cueOnly: true },
	{
		variable: '{{CUE_GH_ASSIGNEES}}',
		description: 'Issue assignees (comma-separated)',
		cueOnly: true,
	},
	{ variable: '{{CUE_GH_AUTHOR}}', description: 'PR/issue author login', cueOnly: true },
	{ variable: '{{CUE_GH_BASE_BRANCH}}', description: 'PR base branch', cueOnly: true },
	{ variable: '{{CUE_GH_BODY}}', description: 'PR/issue body (truncated)', cueOnly: true },
	{ variable: '{{CUE_GH_BRANCH}}', description: 'PR head branch', cueOnly: true },
	{ variable: '{{CUE_GH_LABELS}}', description: 'Labels (comma-separated)', cueOnly: true },
	{ variable: '{{CUE_GH_NUMBER}}', description: 'PR/issue number', cueOnly: true },
	{ variable: '{{CUE_GH_REPO}}', description: 'GitHub repo (owner/repo)', cueOnly: true },
	{ variable: '{{CUE_GH_STATE}}', description: 'PR/issue state', cueOnly: true },
	{ variable: '{{CUE_GH_TITLE}}', description: 'PR/issue title', cueOnly: true },
	{ variable: '{{CUE_GH_TYPE}}', description: 'Item type (pull_request/issue)', cueOnly: true },
	{ variable: '{{CUE_GH_URL}}', description: 'PR/issue HTML URL', cueOnly: true },
	{ variable: '{{CUE_TASK_CONTENT}}', description: 'Task file content (truncated)', cueOnly: true },
	{ variable: '{{CUE_TASK_COUNT}}', description: 'Number of pending tasks', cueOnly: true },
	{ variable: '{{CUE_TASK_FILE}}', description: 'File path with pending tasks', cueOnly: true },
	{
		variable: '{{CUE_TASK_FILE_DIR}}',
		description: 'Directory of task file',
		cueOnly: true,
	},
	{
		variable: '{{CUE_TASK_FILE_NAME}}',
		description: 'Name of file with pending tasks',
		cueOnly: true,
	},
	{ variable: '{{CUE_TASK_LIST}}', description: 'Formatted list of pending tasks', cueOnly: true },
	{
		variable: '{{CUE_FILE_CHANGE_TYPE}}',
		description: 'Change type (add/change/unlink)',
		cueOnly: true,
	},
	{ variable: '{{CUE_FILE_DIR}}', description: 'Changed file directory', cueOnly: true },
	{ variable: '{{CUE_FILE_EXT}}', description: 'Changed file extension', cueOnly: true },
	{ variable: '{{CUE_FILE_NAME}}', description: 'Changed file name', cueOnly: true },
	{ variable: '{{CUE_FILE_PATH}}', description: 'Changed file path', cueOnly: true },
	{ variable: '{{CUE_RUN_ID}}', description: 'Cue run UUID', cueOnly: true },
	{
		variable: '{{CUE_SOURCE_DURATION}}',
		description: 'Source run duration (ms)',
		cueOnly: true,
	},
	{
		variable: '{{CUE_SOURCE_EXIT_CODE}}',
		description: 'Source process exit code',
		cueOnly: true,
	},
	{ variable: '{{CUE_SOURCE_OUTPUT}}', description: 'Source session output', cueOnly: true },
	{ variable: '{{CUE_SOURCE_SESSION}}', description: 'Source session name', cueOnly: true },
	{
		variable: '{{CUE_SOURCE_STATUS}}',
		description: 'Source run status (completed/failed/timeout)',
		cueOnly: true,
	},
	{
		variable: '{{CUE_SOURCE_TRIGGERED_BY}}',
		description: 'Subscription that triggered the source',
		cueOnly: true,
	},
	{ variable: '{{CUE_TRIGGER_NAME}}', description: 'Cue trigger name', cueOnly: true },
	{ variable: '{{CWD}}', description: 'Working directory' },
	{ variable: '{{DATE}}', description: 'Date (YYYY-MM-DD)' },
	{ variable: '{{DATETIME}}', description: 'Full datetime' },
	{ variable: '{{DATE_SHORT}}', description: 'Date (MM/DD/YY)' },
	{ variable: '{{DAY}}', description: 'Day of month (01-31)' },
	{ variable: '{{DOCUMENT_NAME}}', description: 'Current document name', autoRunOnly: true },
	{ variable: '{{DOCUMENT_PATH}}', description: 'Current document path', autoRunOnly: true },
	{ variable: '{{GIT_BRANCH}}', description: 'Git branch name' },
	{ variable: '{{GROUP_DEEP_LINK}}', description: 'Deep link to agent group (maestro://)' },
	{ variable: '{{IS_GIT_REPO}}', description: 'Is git repo (true/false)' },
	{
		variable: '{{LOOP_NUMBER}}',
		description: 'Loop iteration (00001, 00002...)',
		autoRunOnly: true,
	},
	{ variable: '{{MONTH}}', description: 'Month (01-12)' },
	{ variable: '{{TAB_DEEP_LINK}}', description: 'Deep link to agent + active tab (maestro://)' },
	{ variable: '{{TIME}}', description: 'Time (HH:MM:SS)' },
	{ variable: '{{TIMESTAMP}}', description: 'Unix timestamp (ms)' },
	{ variable: '{{TIME_SHORT}}', description: 'Time (HH:MM)' },
	{ variable: '{{TOOL_TYPE}}', description: 'Agent type' },
	{ variable: '{{WEEKDAY}}', description: 'Day of week (Monday, etc.)' },
	{ variable: '{{YEAR}}', description: 'Current year' },
];

// Filtered list excluding Auto Run-only variables (for AI Commands panel)
export const TEMPLATE_VARIABLES_GENERAL = TEMPLATE_VARIABLES.filter(
	(v) => !v.autoRunOnly && !v.cueOnly
);

/**
 * Substitute template variables in a string with actual values
 */
export function substituteTemplateVariables(template: string, context: TemplateContext): string {
	const {
		session,
		gitBranch,
		groupName,
		groupId,
		activeTabId,
		autoRunFolder,
		loopNumber,
		documentName,
		documentPath,
		historyFilePath,
		conductorProfile,
	} = context;
	const now = new Date();

	// Build replacements map
	const replacements: Record<string, string> = {
		// Conductor variables (the Maestro user)
		CONDUCTOR_PROFILE: conductorProfile || '',

		// Agent variables
		AGENT_NAME: session.name,
		AGENT_PATH: session.fullPath || session.projectRoot || session.cwd,
		AGENT_GROUP: groupName || '',
		AGENT_SESSION_ID: session.agentSessionId || '',
		AGENT_HISTORY_PATH: historyFilePath || '',
		TAB_NAME: session.name,
		TOOL_TYPE: session.toolType,

		// Path variables
		CWD: session.cwd,
		AUTORUN_FOLDER: autoRunFolder || session.autoRunFolderPath || '',

		// Aliases (not documented in TEMPLATE_VARIABLES but still supported for internal use and backwards compatibility)
		SESSION_ID: session.id,
		SESSION_NAME: session.name, // Alias for TAB_NAME
		PROJECT_PATH: session.fullPath || session.projectRoot || session.cwd,
		PROJECT_NAME:
			(session.fullPath || session.projectRoot || session.cwd)
				.split(/[/\\]/)
				.filter(Boolean)
				.pop() || '',

		// Document variables (for Auto Run)
		DOCUMENT_NAME: documentName || '',
		DOCUMENT_PATH: documentPath || '',

		// Loop tracking (1-indexed, defaults to 1 if not in loop mode, 5-digit padded)
		LOOP_NUMBER: String(loopNumber ?? 1).padStart(5, '0'),

		// Date/Time variables
		DATE: now.toISOString().split('T')[0],
		TIME: now.toTimeString().split(' ')[0],
		DATETIME: `${now.toISOString().split('T')[0]} ${now.toTimeString().split(' ')[0]}`,
		TIMESTAMP: String(now.getTime()),
		DATE_SHORT: `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${String(now.getFullYear()).slice(-2)}`,
		TIME_SHORT: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
		YEAR: String(now.getFullYear()),
		MONTH: String(now.getMonth() + 1).padStart(2, '0'),
		DAY: String(now.getDate()).padStart(2, '0'),
		WEEKDAY: now.toLocaleDateString('en-US', { weekday: 'long' }),

		// Git variables
		GIT_BRANCH: gitBranch || '',
		IS_GIT_REPO: String(session.isGitRepo ?? false),

		// Deep link variables
		AGENT_DEEP_LINK: buildSessionDeepLink(session.id),
		TAB_DEEP_LINK: buildSessionDeepLink(session.id, activeTabId),
		GROUP_DEEP_LINK: groupId ? buildGroupDeepLink(groupId) : '',

		// Context variables
		CONTEXT_USAGE: String(session.contextUsage || 0),

		// Cue variables
		CUE_EVENT_TYPE: context.cue?.eventType || '',
		CUE_EVENT_TIMESTAMP: context.cue?.eventTimestamp || '',
		CUE_TRIGGER_NAME: context.cue?.triggerName || '',
		CUE_RUN_ID: context.cue?.runId || '',
		CUE_FILE_PATH: context.cue?.filePath || '',
		CUE_FILE_NAME: context.cue?.fileName || '',
		CUE_FILE_DIR: context.cue?.fileDir || '',
		CUE_FILE_EXT: context.cue?.fileExt || '',
		CUE_FILE_CHANGE_TYPE: context.cue?.fileChangeType || '',
		CUE_SOURCE_SESSION: context.cue?.sourceSession || '',
		CUE_SOURCE_OUTPUT: context.cue?.sourceOutput || '',
		CUE_SOURCE_STATUS: context.cue?.sourceStatus || '',
		CUE_SOURCE_EXIT_CODE: context.cue?.sourceExitCode || '',
		CUE_SOURCE_DURATION: context.cue?.sourceDuration || '',
		CUE_SOURCE_TRIGGERED_BY: context.cue?.sourceTriggeredBy || '',

		// Cue task variables
		CUE_TASK_FILE: context.cue?.taskFile || '',
		CUE_TASK_FILE_NAME: context.cue?.taskFileName || '',
		CUE_TASK_FILE_DIR: context.cue?.taskFileDir || '',
		CUE_TASK_COUNT: context.cue?.taskCount || '',
		CUE_TASK_LIST: context.cue?.taskList || '',
		CUE_TASK_CONTENT: context.cue?.taskContent || '',

		// Cue GitHub variables
		CUE_GH_TYPE: context.cue?.ghType || '',
		CUE_GH_NUMBER: context.cue?.ghNumber || '',
		CUE_GH_TITLE: context.cue?.ghTitle || '',
		CUE_GH_AUTHOR: context.cue?.ghAuthor || '',
		CUE_GH_URL: context.cue?.ghUrl || '',
		CUE_GH_BODY: context.cue?.ghBody || '',
		CUE_GH_LABELS: context.cue?.ghLabels || '',
		CUE_GH_STATE: context.cue?.ghState || '',
		CUE_GH_REPO: context.cue?.ghRepo || '',
		CUE_GH_BRANCH: context.cue?.ghBranch || '',
		CUE_GH_BASE_BRANCH: context.cue?.ghBaseBranch || '',
		CUE_GH_ASSIGNEES: context.cue?.ghAssignees || '',
	};

	// Perform case-insensitive replacement
	let result = template;
	for (const [key, value] of Object.entries(replacements)) {
		// Match {{KEY}} with case insensitivity
		const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
		result = result.replace(regex, value);
	}

	return result;
}
