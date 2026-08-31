/**
 * OpenClaude Output Parser
 *
 * OpenClaude is a fork of Claude Code that keeps its headless CLI surface flag
 * for flag: `--print --verbose --output-format stream-json` emits a
 * byte-identical event stream, down to `session_id`, `modelUsage`,
 * `total_cost_usd` and `parent_tool_use_id`. So the whole parse is inherited.
 *
 * Only `agentId` differs, which is what routes error matching to OpenClaude's
 * pattern set and stamps the right agent on emitted errors.
 *
 * @see https://github.com/Gitlawb/openclaude
 */

import type { ToolType } from '../../shared/types';
import { ClaudeOutputParser } from './claude-output-parser';

export class OpenClaudeOutputParser extends ClaudeOutputParser {
	readonly agentId: ToolType = 'openclaude';
}
