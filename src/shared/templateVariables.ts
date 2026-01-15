/**
 * Template Variable System for Auto Run and Custom AI Commands
 *
 * Available variables (case-insensitive):
 *
 * Agent Variables:
 *   {{AGENT_NAME}}        - Agent name
 *   {{AGENT_PATH}}        - Agent home directory path (full path to project)
 *   {{AGENT_GROUP}}       - Agent's group name (if grouped)
 *   {{AGENT_SESSION_ID}}  - Agent session ID (for conversation continuity)
 *   {{AGENT_HISTORY_PATH}} - Path to agent's history JSON file (for task recall)
 *   {{TAB_NAME}}          - Custom tab name (alias: SESSION_NAME)
 *   {{TOOL_TYPE}}         - Agent type (claude-code, aider, etc.)
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
 * Context Variables:
 *   {{CONTEXT_USAGE}}     - Current context window usage percentage
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
  autoRunFolder?: string;
  loopNumber?: number;
  // Auto Run document context
  documentName?: string;
  documentPath?: string;
  // History file path for task recall
  historyFilePath?: string;
}

// List of all available template variables for documentation (alphabetically sorted)
// Variables marked as autoRunOnly are only shown in Auto Run contexts, not in AI Commands settings
export const TEMPLATE_VARIABLES = [
  { variable: '{{AGENT_GROUP}}', description: 'Agent group name' },
  { variable: '{{AGENT_HISTORY_PATH}}', description: 'History file path (task recall)' },
  { variable: '{{AGENT_NAME}}', description: 'Agent name' },
  { variable: '{{AGENT_PATH}}', description: 'Agent home directory path' },
  { variable: '{{AGENT_SESSION_ID}}', description: 'Agent session ID' },
  { variable: '{{AUTORUN_FOLDER}}', description: 'Auto Run folder path', autoRunOnly: true },
  { variable: '{{TAB_NAME}}', description: 'Custom tab name' },
  { variable: '{{CONTEXT_USAGE}}', description: 'Context usage %' },
  { variable: '{{CWD}}', description: 'Working directory' },
  { variable: '{{DATE}}', description: 'Date (YYYY-MM-DD)' },
  { variable: '{{DATETIME}}', description: 'Full datetime' },
  { variable: '{{DATE_SHORT}}', description: 'Date (MM/DD/YY)' },
  { variable: '{{DAY}}', description: 'Day of month (01-31)' },
  { variable: '{{DOCUMENT_NAME}}', description: 'Current document name', autoRunOnly: true },
  { variable: '{{DOCUMENT_PATH}}', description: 'Current document path', autoRunOnly: true },
  { variable: '{{GIT_BRANCH}}', description: 'Git branch name' },
  { variable: '{{IS_GIT_REPO}}', description: 'Is git repo (true/false)' },
  { variable: '{{LOOP_NUMBER}}', description: 'Loop iteration (00001, 00002...)', autoRunOnly: true },
  { variable: '{{MONTH}}', description: 'Month (01-12)' },
  { variable: '{{TIME}}', description: 'Time (HH:MM:SS)' },
  { variable: '{{TIMESTAMP}}', description: 'Unix timestamp (ms)' },
  { variable: '{{TIME_SHORT}}', description: 'Time (HH:MM)' },
  { variable: '{{TOOL_TYPE}}', description: 'Agent type' },
  { variable: '{{WEEKDAY}}', description: 'Day of week (Monday, etc.)' },
  { variable: '{{YEAR}}', description: 'Current year' },
];

// Filtered list excluding Auto Run-only variables (for AI Commands panel)
export const TEMPLATE_VARIABLES_GENERAL = TEMPLATE_VARIABLES.filter(v => !v.autoRunOnly);

/**
 * Substitute template variables in a string with actual values
 */
export function substituteTemplateVariables(
  template: string,
  context: TemplateContext
): string {
  const { session, gitBranch, groupName, autoRunFolder, loopNumber, documentName, documentPath, historyFilePath } = context;
  const now = new Date();

  // Build replacements map
  const replacements: Record<string, string> = {
    // Agent variables
    'AGENT_NAME': session.name,
    'AGENT_PATH': session.fullPath || session.projectRoot || session.cwd,
    'AGENT_GROUP': groupName || '',
    'AGENT_SESSION_ID': session.agentSessionId || '',
    'AGENT_HISTORY_PATH': historyFilePath || '',
    'TAB_NAME': session.name,
    'TOOL_TYPE': session.toolType,

    // Path variables
    'CWD': session.cwd,
    'AUTORUN_FOLDER': autoRunFolder || session.autoRunFolderPath || '',

    // Aliases (not documented in TEMPLATE_VARIABLES but still supported for internal use and backwards compatibility)
    'SESSION_ID': session.id,
    'SESSION_NAME': session.name, // Alias for TAB_NAME
    'PROJECT_PATH': session.fullPath || session.projectRoot || session.cwd,
    'PROJECT_NAME': (session.fullPath || session.projectRoot || session.cwd).split(/[/\\]/).filter(Boolean).pop() || '',

    // Document variables (for Auto Run)
    'DOCUMENT_NAME': documentName || '',
    'DOCUMENT_PATH': documentPath || '',

    // Loop tracking (1-indexed, defaults to 1 if not in loop mode, 5-digit padded)
    'LOOP_NUMBER': String(loopNumber ?? 1).padStart(5, '0'),

    // Date/Time variables
    'DATE': now.toISOString().split('T')[0],
    'TIME': now.toTimeString().split(' ')[0],
    'DATETIME': `${now.toISOString().split('T')[0]} ${now.toTimeString().split(' ')[0]}`,
    'TIMESTAMP': String(now.getTime()),
    'DATE_SHORT': `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${String(now.getFullYear()).slice(-2)}`,
    'TIME_SHORT': `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    'YEAR': String(now.getFullYear()),
    'MONTH': String(now.getMonth() + 1).padStart(2, '0'),
    'DAY': String(now.getDate()).padStart(2, '0'),
    'WEEKDAY': now.toLocaleDateString('en-US', { weekday: 'long' }),

    // Git variables
    'GIT_BRANCH': gitBranch || '',
    'IS_GIT_REPO': String(session.isGitRepo ?? false),

    // Context variables
    'CONTEXT_USAGE': String(session.contextUsage || 0),
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
