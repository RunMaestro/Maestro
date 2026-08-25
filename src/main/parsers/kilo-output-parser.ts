/**
 * Kilo Output Parser
 *
 * Kilo (KiloCode) is a fork of OpenCode that emits a byte-identical JSONL
 * event stream from `kilo run --format json`, so the whole parse is inherited.
 * Only `agentId` differs, which is what routes error matching to Kilo's own
 * pattern set and stamps the right agent on emitted errors.
 *
 * @see https://github.com/Kilo-Org/kilocode
 */

import type { ToolType } from '../../shared/types';
import { OpenCodeOutputParser } from './opencode-output-parser';

export class KiloOutputParser extends OpenCodeOutputParser {
	readonly agentId: ToolType = 'kilo';
}
