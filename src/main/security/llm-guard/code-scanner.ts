/**
 * Code Scanner for LLM Guard
 *
 * Detects potentially dangerous code patterns in LLM responses:
 * - Destructive shell commands: `rm -rf`, `sudo`, `chmod 777`, `curl | bash`
 * - SQL injection patterns: `'; DROP TABLE`, `OR 1=1`
 * - OS command injection: `$(...)`, backticks in strings
 * - File system operations on sensitive paths: `/etc/passwd`, `~/.ssh`
 * - Network operations: raw socket code, port scanning
 *
 * This scanner is context-aware and only flags patterns when they appear
 * in code blocks or command contexts to reduce false positives.
 */

import type { LlmGuardFinding } from './types';

/**
 * Dangerous shell command patterns.
 * These patterns detect potentially destructive or dangerous shell commands.
 */
const SHELL_COMMAND_PATTERNS = [
	// Destructive removal commands
	{
		type: 'DANGEROUS_CODE_RM_RF',
		pattern: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+)?(?:-[a-zA-Z]*f[a-zA-Z]*\s+)?(?:\/|~|\*|\$)/gi,
		description: 'Recursive force delete command',
		confidence: 0.92,
	},
	{
		type: 'DANGEROUS_CODE_RM_RF_ROOT',
		pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(?:\/(?:\s|$)|\/\*|~\/)/gi,
		description: 'Recursive delete targeting root or home directory',
		confidence: 0.98,
	},
	// Sudo with dangerous commands
	{
		type: 'DANGEROUS_CODE_SUDO_DESTRUCTIVE',
		pattern:
			/\bsudo\s+(?:rm|chmod|chown|dd|mkfs|fdisk|wipefs|shred|crontab\s+-r|userdel|groupdel)\b/gi,
		description: 'Sudo with potentially destructive command',
		confidence: 0.88,
	},
	// Insecure permissions
	{
		type: 'DANGEROUS_CODE_CHMOD_777',
		pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)?(?:777|a\+rwx)\b/gi,
		description: 'Setting world-writable permissions',
		confidence: 0.85,
	},
	// Pipe to shell (code execution from network)
	{
		type: 'DANGEROUS_CODE_CURL_PIPE_BASH',
		pattern:
			/\b(?:curl|wget)\s+[^\n|;]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh|dash|python|perl|ruby)\b/gi,
		description: 'Piping downloaded content directly to shell interpreter',
		confidence: 0.95,
	},
	// Wget/curl with execution
	{
		type: 'DANGEROUS_CODE_DOWNLOAD_EXEC',
		pattern:
			/\b(?:curl|wget)\s+[^\n;]*-O\s*-?\s*(?:\|\s*(?:bash|sh)|&&\s*(?:bash|sh|chmod\s+\+x))/gi,
		description: 'Downloading and executing remote script',
		confidence: 0.93,
	},
	// Fork bomb
	{
		type: 'DANGEROUS_CODE_FORK_BOMB',
		pattern: /:[\(\)]\s*{\s*:[\|\&]/g,
		description: 'Fork bomb pattern that can crash the system',
		confidence: 0.98,
	},
	// Disk overwrite
	{
		type: 'DANGEROUS_CODE_DD_DISK',
		pattern: /\bdd\s+[^\n]*of\s*=\s*\/dev\/(?:sd[a-z]|hd[a-z]|nvme|disk)/gi,
		description: 'Direct disk write operation',
		confidence: 0.92,
	},
	// History manipulation (hiding tracks)
	{
		type: 'DANGEROUS_CODE_HISTORY_CLEAR',
		pattern: /\b(?:history\s+-c|unset\s+HISTFILE|export\s+HISTFILE\s*=\s*\/dev\/null)\b/gi,
		description: 'Clearing or disabling shell history',
		confidence: 0.78,
	},
	// Reverse shell patterns
	{
		type: 'DANGEROUS_CODE_REVERSE_SHELL',
		pattern:
			/\b(?:bash\s+-i\s+[>&]+\s*\/dev\/tcp|nc\s+[^\n]*-e\s+(?:\/bin\/)?(?:ba)?sh|python[23]?\s+[^\n]*socket[^\n]*connect)/gi,
		description: 'Reverse shell pattern',
		confidence: 0.96,
	},
];

/**
 * SQL injection patterns.
 * These patterns detect SQL injection attempts in code.
 */
const SQL_INJECTION_PATTERNS = [
	{
		type: 'DANGEROUS_CODE_SQL_DROP',
		pattern: /['";]\s*(?:DROP|DELETE|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/gi,
		description: 'SQL DROP/DELETE/TRUNCATE statement in string context',
		confidence: 0.88,
	},
	{
		type: 'DANGEROUS_CODE_SQL_UNION',
		pattern: /['";]\s*(?:UNION\s+(?:ALL\s+)?SELECT|SELECT\s+\*\s+FROM)/gi,
		description: 'SQL UNION SELECT or SELECT * in string context',
		confidence: 0.75,
	},
	{
		type: 'DANGEROUS_CODE_SQL_OR_1',
		pattern: /['"]\s*OR\s+['"]?\d+['"]\s*=\s*['"]?\d+/gi,
		description: 'SQL OR 1=1 style injection pattern',
		confidence: 0.82,
	},
	{
		type: 'DANGEROUS_CODE_SQL_COMMENT',
		pattern: /['";]\s*--\s*$/gm,
		description: 'SQL comment injection to truncate query',
		confidence: 0.7,
	},
	{
		type: 'DANGEROUS_CODE_SQL_SEMICOLON',
		pattern: /['"];\s*(?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC)\b/gi,
		description: 'SQL statement injection via semicolon',
		confidence: 0.85,
	},
];

/**
 * Command injection patterns.
 * These patterns detect OS command injection attempts.
 */
const COMMAND_INJECTION_PATTERNS = [
	{
		type: 'DANGEROUS_CODE_CMD_SUBSTITUTION',
		pattern: /\$\([^)]*(?:rm|wget|curl|nc|bash|sh|python|perl|ruby|chmod|chown|sudo)[^)]*\)/gi,
		description: 'Command substitution with dangerous command',
		confidence: 0.88,
	},
	{
		type: 'DANGEROUS_CODE_BACKTICK_INJECTION',
		pattern: /`[^`]*(?:rm|wget|curl|nc|bash|sh|python|perl|ruby|chmod|chown|sudo)[^`]*`/gi,
		description: 'Backtick command execution with dangerous command',
		confidence: 0.85,
	},
	{
		type: 'DANGEROUS_CODE_EVAL_EXEC',
		pattern: /\b(?:eval|exec)\s*\(\s*(?:["'`].*["'`]|\$|request|input|user|data)/gi,
		description: 'Dynamic code execution with external input',
		confidence: 0.9,
	},
	{
		type: 'DANGEROUS_CODE_SYSTEM_CALL',
		pattern: /\b(?:os\.system|subprocess\.(?:call|run|Popen)|shell_exec|system)\s*\([^)]*\$/gi,
		description: 'System call with variable input (potential injection)',
		confidence: 0.82,
	},
];

/**
 * Sensitive file access patterns.
 * These patterns detect operations on sensitive system files and directories.
 */
const SENSITIVE_PATH_PATTERNS = [
	{
		type: 'DANGEROUS_CODE_ACCESS_PASSWD',
		pattern: /(?:\/etc\/passwd|\/etc\/shadow|\/etc\/sudoers)/gi,
		description: 'Access to system authentication files',
		confidence: 0.88,
	},
	{
		type: 'DANGEROUS_CODE_ACCESS_SSH',
		pattern: /(?:~\/\.ssh|\/\.ssh|id_rsa|id_ed25519|authorized_keys)/gi,
		description: 'Access to SSH keys or configuration',
		confidence: 0.85,
	},
	{
		type: 'DANGEROUS_CODE_ACCESS_AWS',
		pattern: /(?:~\/\.aws|\/\.aws\/credentials|AWS_SECRET_ACCESS_KEY)/gi,
		description: 'Access to AWS credentials',
		confidence: 0.9,
	},
	{
		type: 'DANGEROUS_CODE_ACCESS_ENV',
		pattern: /(?:\/proc\/\d+\/environ|\/proc\/self\/environ)/gi,
		description: 'Access to process environment variables',
		confidence: 0.82,
	},
	{
		type: 'DANGEROUS_CODE_ACCESS_HOSTS',
		pattern: /\b(?:echo|printf|cat)\s+[^;|]*>+\s*\/etc\/(?:hosts|resolv\.conf|nsswitch\.conf)/gi,
		description: 'Modifying DNS or network configuration files',
		confidence: 0.88,
	},
	{
		type: 'DANGEROUS_CODE_ACCESS_CRON',
		pattern: /(?:\/etc\/cron|\/var\/spool\/cron|crontab\s+-[el])/gi,
		description: 'Access to cron job configuration',
		confidence: 0.75,
	},
];

/**
 * Network operation patterns.
 * These patterns detect suspicious network operations.
 */
const NETWORK_OPERATION_PATTERNS = [
	{
		type: 'DANGEROUS_CODE_PORT_SCAN',
		pattern: /\b(?:nmap|masscan|zmap)\s+/gi,
		description: 'Port scanning tool usage',
		confidence: 0.78,
	},
	{
		type: 'DANGEROUS_CODE_RAW_SOCKET',
		pattern: /socket\.(?:SOCK_RAW|socket)\s*\([^)]*IPPROTO_(?:ICMP|RAW)/gi,
		description: 'Raw socket creation',
		confidence: 0.72,
	},
	{
		type: 'DANGEROUS_CODE_NETCAT_LISTEN',
		pattern: /\bnc\s+[^\n]*-l[^\n]*-p\s*\d+/gi,
		description: 'Netcat listening on port (potential backdoor)',
		confidence: 0.82,
	},
	{
		type: 'DANGEROUS_CODE_IPTABLES_FLUSH',
		pattern: /\biptables\s+(?:-F|--flush)\b/gi,
		description: 'Flushing firewall rules',
		confidence: 0.85,
	},
	{
		type: 'DANGEROUS_CODE_SSH_NO_CHECK',
		pattern:
			/ssh\s+[^\n]*-o\s*(?:StrictHostKeyChecking\s*=\s*no|UserKnownHostsFile\s*=\s*\/dev\/null)/gi,
		description: 'SSH with disabled host key checking',
		confidence: 0.75,
	},
];

/**
 * Code block detection patterns.
 * Used to identify when content is within a code context.
 */
const CODE_BLOCK_PATTERNS = {
	// Markdown code blocks
	markdown: /```(?:[a-z]*\n)?[\s\S]*?```/gi,
	// Inline code
	inlineCode: /`[^`]+`/g,
	// Command line indicators
	shellPrompt: /^(?:\$|#|>|%)\s+.+$/gm,
	// Common shebang lines
	shebang: /^#!\/(?:bin|usr\/bin)\/(?:bash|sh|zsh|python|node|ruby|perl)/gm,
};

export interface CodeFinding extends LlmGuardFinding {
	/** Category of the dangerous pattern */
	category: 'shell' | 'sql' | 'injection' | 'filesystem' | 'network';
	/** Whether the pattern was found within a code block */
	inCodeBlock: boolean;
}

/**
 * Check if a position is within a code block in the text.
 */
function isInCodeBlock(text: string, start: number, end: number): boolean {
	// Check markdown code blocks
	const markdownMatcher = new RegExp(CODE_BLOCK_PATTERNS.markdown.source, 'gi');
	let match: RegExpExecArray | null;
	while ((match = markdownMatcher.exec(text)) !== null) {
		if (start >= match.index && end <= match.index + match[0].length) {
			return true;
		}
	}

	// Check inline code
	const inlineMatcher = new RegExp(CODE_BLOCK_PATTERNS.inlineCode.source, 'g');
	while ((match = inlineMatcher.exec(text)) !== null) {
		if (start >= match.index && end <= match.index + match[0].length) {
			return true;
		}
	}

	// Check if the line starts with a shell prompt
	const currentLineStart = text.lastIndexOf('\n', start - 1) + 1;
	const currentLine = text.substring(currentLineStart, text.indexOf('\n', start));
	if (CODE_BLOCK_PATTERNS.shellPrompt.test(currentLine)) {
		return true;
	}

	return false;
}

/**
 * Extract code blocks from text for focused scanning.
 * Returns an array of { content, start, end } for each code block.
 */
function extractCodeBlocks(text: string): { content: string; start: number; end: number }[] {
	const blocks: { content: string; start: number; end: number }[] = [];

	// Extract markdown code blocks
	const markdownMatcher = new RegExp(CODE_BLOCK_PATTERNS.markdown.source, 'gi');
	let match: RegExpExecArray | null;
	while ((match = markdownMatcher.exec(text)) !== null) {
		blocks.push({
			content: match[0],
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	// Extract shell prompt lines
	const shellMatcher = new RegExp(CODE_BLOCK_PATTERNS.shellPrompt.source, 'gm');
	while ((match = shellMatcher.exec(text)) !== null) {
		// Avoid duplicates if already in a markdown block
		const overlaps = blocks.some(
			(b) => match!.index >= b.start && match!.index + match![0].length <= b.end
		);
		if (!overlaps) {
			blocks.push({
				content: match[0],
				start: match.index,
				end: match.index + match[0].length,
			});
		}
	}

	return blocks;
}

/**
 * Apply pattern matching to find dangerous code patterns.
 */
function matchPatterns(
	text: string,
	patterns: typeof SHELL_COMMAND_PATTERNS,
	category: CodeFinding['category']
): CodeFinding[] {
	const findings: CodeFinding[] = [];

	for (const patternDef of patterns) {
		const matcher = new RegExp(patternDef.pattern.source, patternDef.pattern.flags);
		let match: RegExpExecArray | null;

		while ((match = matcher.exec(text)) !== null) {
			const value = match[0];
			const start = match.index;
			const end = start + value.length;

			// Check if this is within a code block
			const inCodeBlock = isInCodeBlock(text, start, end);

			findings.push({
				type: patternDef.type,
				value,
				start,
				end,
				confidence: patternDef.confidence,
				replacement: `[DANGEROUS: ${patternDef.description}]`,
				category,
				inCodeBlock,
			});
		}
	}

	return findings;
}

/**
 * Scan text for dangerous code patterns.
 *
 * This scanner detects potentially dangerous code that could be harmful if executed:
 * - Destructive shell commands (rm -rf, sudo, chmod 777)
 * - Download and execute patterns (curl | bash)
 * - SQL injection patterns
 * - Command injection via substitution
 * - Access to sensitive files and directories
 * - Suspicious network operations
 *
 * @param text - The text to scan for dangerous code patterns
 * @param options - Optional configuration
 * @returns Array of findings for detected dangerous patterns
 */
export function scanCode(
	text: string,
	options: {
		/** Only report findings within code blocks (default: false) */
		codeBlocksOnly?: boolean;
		/** Minimum confidence threshold (default: 0.6) */
		minConfidence?: number;
		/** Categories to scan for (default: all) */
		categories?: Array<'shell' | 'sql' | 'injection' | 'filesystem' | 'network'>;
	} = {}
): LlmGuardFinding[] {
	const {
		codeBlocksOnly = false,
		minConfidence = 0.6,
		categories = ['shell', 'sql', 'injection', 'filesystem', 'network'],
	} = options;

	const findings: CodeFinding[] = [];

	// Scan for each category of patterns
	if (categories.includes('shell')) {
		findings.push(...matchPatterns(text, SHELL_COMMAND_PATTERNS, 'shell'));
	}
	if (categories.includes('sql')) {
		findings.push(...matchPatterns(text, SQL_INJECTION_PATTERNS, 'sql'));
	}
	if (categories.includes('injection')) {
		findings.push(...matchPatterns(text, COMMAND_INJECTION_PATTERNS, 'injection'));
	}
	if (categories.includes('filesystem')) {
		findings.push(...matchPatterns(text, SENSITIVE_PATH_PATTERNS, 'filesystem'));
	}
	if (categories.includes('network')) {
		findings.push(...matchPatterns(text, NETWORK_OPERATION_PATTERNS, 'network'));
	}

	// Filter results
	let filtered = findings;

	// Filter by code block context if requested
	if (codeBlocksOnly) {
		filtered = filtered.filter((f) => f.inCodeBlock);
	}

	// Filter by minimum confidence
	filtered = filtered.filter((f) => f.confidence >= minConfidence);

	// Remove duplicates (same position)
	const seen = new Set<string>();
	filtered = filtered.filter((f) => {
		const key = `${f.start}-${f.end}-${f.type}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	// Sort by position
	filtered.sort((a, b) => a.start - b.start);

	return filtered;
}

/**
 * Scan text for dangerous code patterns with detailed output.
 * This includes additional context about each finding.
 *
 * @param text - The text to scan
 * @returns Array of detailed code findings
 */
export function scanCodeDetailed(text: string): CodeFinding[] {
	const allFindings: CodeFinding[] = [];

	// Collect all pattern matches
	allFindings.push(...matchPatterns(text, SHELL_COMMAND_PATTERNS, 'shell'));
	allFindings.push(...matchPatterns(text, SQL_INJECTION_PATTERNS, 'sql'));
	allFindings.push(...matchPatterns(text, COMMAND_INJECTION_PATTERNS, 'injection'));
	allFindings.push(...matchPatterns(text, SENSITIVE_PATH_PATTERNS, 'filesystem'));
	allFindings.push(...matchPatterns(text, NETWORK_OPERATION_PATTERNS, 'network'));

	// Sort by position
	allFindings.sort((a, b) => a.start - b.start);

	return allFindings;
}

/**
 * Check if text contains any dangerous code patterns.
 * This is a quick check that returns true if any patterns are detected.
 *
 * @param text - The text to check
 * @param minConfidence - Minimum confidence threshold (default: 0.7)
 * @returns True if dangerous patterns are detected
 */
export function containsDangerousCode(text: string, minConfidence = 0.7): boolean {
	const findings = scanCode(text, { minConfidence });
	return findings.length > 0;
}

// Export utility functions for testing
export const _internals = {
	isInCodeBlock,
	extractCodeBlocks,
	matchPatterns,
	SHELL_COMMAND_PATTERNS,
	SQL_INJECTION_PATTERNS,
	COMMAND_INJECTION_PATTERNS,
	SENSITIVE_PATH_PATTERNS,
	NETWORK_OPERATION_PATTERNS,
	CODE_BLOCK_PATTERNS,
};
