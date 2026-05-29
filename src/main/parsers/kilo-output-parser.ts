import { OpenCodeOutputParser } from './opencode-output-parser';
import type { ToolType } from '../../shared/types';

export class KiloOutputParser extends OpenCodeOutputParser {
	readonly agentId: ToolType = 'kilo';
}
