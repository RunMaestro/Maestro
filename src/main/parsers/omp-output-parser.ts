/**
 * Parser for Oh My Pi's (`omp`) JSON event protocol (`omp -p --mode json ...`).
 *
 * Oh My Pi shares Pi's documented JSON shape but is registered as its own agent
 * with its own parser instance, error patterns, and TTSR retry policy.
 */

import type { AgentError, ToolType } from '../../shared/types';
import { stripAnsiCodes } from '../../shared/stringUtils';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns } from './error-patterns';
import {
	createPiProtocolCore,
	type PiProtocolAdapter,
	type PiProtocolRawEvent,
} from './pi-protocol-core';

/**
 * Oh My Pi's Time-Traveling Stream Rules (TTSR) deliberately abort the in-flight
 * turn when generated output matches a rule and let the agent re-iterate. This
 * is an in-loop interrupt, not a terminal error. The exact anchored label keeps
 * genuine errors that merely mention a rule visible to callers.
 */
const TTSR_ABORT_REASON_PATTERN = /^TTSR matched rules?:/i;

const OMP_PROTOCOL_ADAPTER: PiProtocolAdapter = {
	agentId: 'omp',
	agentDisplayName: 'Oh My Pi',
	errorPatterns: getErrorPatterns('omp'),
	emitEmptyAgentEndResult: false,
	stripExitOutput: stripAnsiCodes,
	shouldSuppressError(event: PiProtocolRawEvent, errorText: string): boolean {
		return Boolean(event.willRetry) || TTSR_ABORT_REASON_PATTERN.test(errorText.trim());
	},
};

const ompProtocolCore = createPiProtocolCore(OMP_PROTOCOL_ADAPTER);

export class OmpOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'omp';

	parseJsonLine(line: string): ParsedEvent | null {
		return ompProtocolCore.parseJsonLine(line);
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		return ompProtocolCore.parseJsonObject(parsed);
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
		return ompProtocolCore.detectErrorFromLine(line);
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		return ompProtocolCore.detectErrorFromParsed(parsed);
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		return ompProtocolCore.detectErrorFromExit(exitCode, stderr, stdout);
	}
}
