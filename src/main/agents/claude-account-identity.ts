/**
 * Claude Account Identity Reader
 *
 * Filesystem half of `src/shared/claudeAccountIdentity.ts`: read
 * `<configDir>/.claude.json` and hand the parsed blob to the shared pure
 * parser. Kept separate from the parser so the shape logic stays testable
 * without an fs mock, and so the renderer never imports a Node module.
 *
 * Never throws. A missing dir, an unreadable file, or a malformed JSON blob all
 * resolve to `null`, and every consumer treats null as "unknown account" and
 * falls back to the config-dir name. Losing the email is a cosmetic downgrade;
 * failing a usage sample over it would not be.
 *
 * No caching here. The only caller is the usage sampler, which already pays a
 * multi-second `maestro-p --status` spawn per account, so one ~100KB read
 * alongside it is noise. Adding a cache would introduce a staleness window
 * exactly where correctness matters: `/login` rewrites this file, and a cached
 * identity would keep labeling the row with the account the user just left.
 */

import * as fs from 'fs';
import path from 'path';

import { logger } from '../utils/logger';
import {
	parseClaudeAccountIdentity,
	type ClaudeAccountIdentity,
} from '../../shared/claudeAccountIdentity';

const LOG_CONTEXT = '[ClaudeAccountIdentity]';

/**
 * Read the Anthropic account logged into `configDir`, or null when the file is
 * absent / unreadable / malformed / carries no `oauthAccount`.
 */
export async function readClaudeAccountIdentity(
	configDir: string
): Promise<ClaudeAccountIdentity | null> {
	const configPath = path.join(configDir, '.claude.json');

	let raw: string;
	try {
		raw = await fs.promises.readFile(configPath, 'utf8');
	} catch {
		// A config dir with no `.claude.json` is normal (never logged in here).
		// Not worth a log line per sample.
		return null;
	}

	try {
		return parseClaudeAccountIdentity(JSON.parse(raw));
	} catch (err) {
		logger.warn('Failed to parse .claude.json for account identity', LOG_CONTEXT, {
			configPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
