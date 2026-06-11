/**
 * Kilo Output Parser Implementation
 *
 * KiloCode is a 1:1 fork of OpenCode with the same JSONL output format,
 * so the parser logic is identical — we just subclass and override agentId.
 */

import type { ToolType } from '../../shared/types';
import { OpenCodeOutputParser } from './opencode-output-parser';

export class KiloOutputParser extends OpenCodeOutputParser {
	readonly agentId: ToolType = 'kilo';
}
