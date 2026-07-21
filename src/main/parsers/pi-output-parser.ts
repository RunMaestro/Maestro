/**
 * Parser for Pi's documented JSONL protocol (`pi --mode json -p ...`).
 *
 * @see https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md
 */

import type { AgentError, ToolType } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns } from './error-patterns';
import { createPiProtocolCore, type PiProtocolAdapter } from './pi-protocol-core';
import { stripAllAnsiCodes } from '../utils/terminalFilter';

const PI_PROTOCOL_ADAPTER: PiProtocolAdapter = {
	agentId: 'pi',
	agentDisplayName: 'Pi',
	errorPatterns: getErrorPatterns('pi'),
	emitEmptyAgentEndResult: true,
	stripExitOutput: stripAllAnsiCodes,
	shouldSuppressError: () => false,
};

const piProtocolCore = createPiProtocolCore(PI_PROTOCOL_ADAPTER);

export class PiOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'pi';

	parseJsonLine(line: string): ParsedEvent | null {
		return piProtocolCore.parseJsonLine(line);
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		return piProtocolCore.parseJsonObject(parsed);
	}

	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId || null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	extractSlashCommands(event: ParsedEvent): string[] | null {
		return event.slashCommands || null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		return piProtocolCore.detectErrorFromLine(line);
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		return piProtocolCore.detectErrorFromParsed(parsed);
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		return piProtocolCore.detectErrorFromExit(exitCode, stderr, stdout);
	}
}
