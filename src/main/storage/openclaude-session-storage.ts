/**
 * OpenClaude Session Storage
 *
 * OpenClaude is a fork of Claude Code: same JSONL transcript format, same
 * `<home>/projects/<encoded-path>/<session-id>.jsonl` layout, same remote
 * shape. Only the home directory is rebranded, so this subclass supplies the
 * brand and inherits the rest.
 *
 * The homes are deliberately separate. OpenClaude stores under `~/.openclaude`
 * and explicitly does NOT read `~/.claude` or honor `CLAUDE_CONFIG_DIR`, so
 * pointing this at Claude's tree would list another provider's transcripts.
 *
 * @see https://github.com/Gitlawb/openclaude
 */

import type { ToolType } from '../../shared/types';
import { ClaudeSessionStorage, type ClaudeStorageBrand } from './claude-session-storage';

const OPENCLAUDE_BRAND: ClaudeStorageBrand = {
	homeDirName: '.openclaude',
	originsStoreName: 'openclaude-session-origins',
};

export class OpenClaudeSessionStorage extends ClaudeSessionStorage {
	readonly agentId: ToolType = 'openclaude';

	protected get brand(): ClaudeStorageBrand {
		return OPENCLAUDE_BRAND;
	}
}
