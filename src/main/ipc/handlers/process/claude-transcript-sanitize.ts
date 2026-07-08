import * as path from 'path';
import { stripThinkingFromTranscript } from '../../../agents/claude-transcript-sanitizer';
import { encodeClaudeProjectPath } from '../../../../shared/pathUtils';
import { logger } from '../../../utils/logger';

const LOG_CONTEXT = '[ProcessManager]';

/**
 * Strip subscription-account thinking blocks from a Claude Code transcript before
 * an API-mode `--resume` re-sends them.
 *
 * Interactive (maestro-p) turns persist thinking as signature-only shells bound
 * to the Max-plan subscription account. Resuming them under the API token source
 * trips Anthropic's "thinking blocks cannot be modified" 400 and poisons the
 * conversation for every later `--resume`. Stripping is benign (thinking is
 * ephemeral reasoning) and the only thing that resumes cleanly across the mode
 * switch. Best-effort: a failure here just means the resume might still hit the
 * 400, so it must never abort the spawn.
 */
export function sanitizeClaudeTranscriptBeforeApiResume(args: {
	configDirKey: string;
	cwd: string;
	agentSessionId: string;
	sessionId: string;
}): void {
	const { configDirKey, cwd, agentSessionId, sessionId } = args;
	try {
		const transcriptPath = path.join(
			configDirKey,
			'projects',
			encodeClaudeProjectPath(cwd),
			`${agentSessionId}.jsonl`
		);
		const result = stripThinkingFromTranscript(transcriptPath);
		if (result.sanitized) {
			logger.info('Sanitized transcript thinking blocks before API resume', LOG_CONTEXT, {
				sessionId,
				droppedRows: result.droppedRows,
				strippedBlocks: result.strippedBlocks,
			});
		}
	} catch (err) {
		logger.warn('Failed to sanitize transcript before API resume; continuing', LOG_CONTEXT, {
			sessionId,
			error: (err as Error).message,
		});
	}
}
