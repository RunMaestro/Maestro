import { describe, expect, it } from 'vitest';
import type { AgentOutputParser, ParsedEvent } from '../../../main/parsers/agent-output-parser';
import { OmpOutputParser } from '../../../main/parsers/omp-output-parser';
import { PiOutputParser } from '../../../main/parsers/pi-output-parser';
import {
	OMP_TTSR_GOLDEN_CASES,
	PI_PROTOCOL_EXIT_GOLDEN_CASE,
	PI_PROTOCOL_EXIT_FALLBACK_GOLDEN_CASE,
	PI_PROTOCOL_GOLDEN_CASES,
} from '../../fixtures/pi-protocol';

const parsers: readonly [string, AgentOutputParser][] = [
	['Pi', new PiOutputParser()],
	['OMP', new OmpOutputParser()],
];

function parseTranscript(parser: AgentOutputParser): Array<ParsedEvent | null> {
	return PI_PROTOCOL_GOLDEN_CASES.map(({ line }) => parser.parseJsonLine(line));
}

describe('Pi protocol golden transcript', () => {
	for (const [name, parser] of parsers) {
		it(`${name} produces the golden events`, () => {
			const actual = parseTranscript(parser);
			const expected = PI_PROTOCOL_GOLDEN_CASES.map(({ expected }) => expected);

			expect(actual).toEqual(expected);
		});

		it(`${name} preserves chunks and malformed-line boundaries`, () => {
			const events = parseTranscript(parser);
			const visibleChunks = events
				.filter((event): event is ParsedEvent => event?.type === 'text' && event.isPartial)
				.map((event) => event.text);

			expect(visibleChunks).toEqual(['hello ', 'considering']);
			expect(events.at(-2)).toEqual({ type: 'text', text: 'not json', raw: 'not json' });
			expect(events.at(-1)).toBeNull();
		});
	}

	it('keeps Pi and OMP event streams byte-equal for the shared protocol', () => {
		const piOutput = JSON.stringify(parseTranscript(new PiOutputParser()));
		const ompOutput = JSON.stringify(parseTranscript(new OmpOutputParser()));

		expect(ompOutput).toBe(piOutput);
	});

	it('preserves each adapter exit fallback', () => {
		const pi = new PiOutputParser().detectErrorFromExit(
			PI_PROTOCOL_EXIT_GOLDEN_CASE.exitCode,
			PI_PROTOCOL_EXIT_GOLDEN_CASE.stderr,
			PI_PROTOCOL_EXIT_GOLDEN_CASE.stdout
		);
		const omp = new OmpOutputParser().detectErrorFromExit(
			PI_PROTOCOL_EXIT_GOLDEN_CASE.exitCode,
			PI_PROTOCOL_EXIT_GOLDEN_CASE.stderr,
			PI_PROTOCOL_EXIT_GOLDEN_CASE.stdout
		);

		expect(pi).toMatchObject({
			type: 'network_error',
			message: 'Pi could not reach the selected provider. Check your network connection.',
			agentId: 'pi',
		});
		expect(omp).toMatchObject({
			type: 'network_error',
			message: 'Oh My Pi could not reach the selected provider. Check your network connection.',
			agentId: 'omp',
		});
	});

	it('preserves adapter-specific unclassified exit fallback text', () => {
		const pi = new PiOutputParser().detectErrorFromExit(
			PI_PROTOCOL_EXIT_FALLBACK_GOLDEN_CASE.exitCode,
			PI_PROTOCOL_EXIT_FALLBACK_GOLDEN_CASE.stderr,
			PI_PROTOCOL_EXIT_FALLBACK_GOLDEN_CASE.stdout
		);
		const omp = new OmpOutputParser().detectErrorFromExit(
			PI_PROTOCOL_EXIT_FALLBACK_GOLDEN_CASE.exitCode,
			PI_PROTOCOL_EXIT_FALLBACK_GOLDEN_CASE.stderr,
			PI_PROTOCOL_EXIT_FALLBACK_GOLDEN_CASE.stdout
		);

		expect(pi).toMatchObject({
			type: 'agent_crashed',
			message: 'Pi exited with code 9: plain failure',
			agentId: 'pi',
		});
		expect(omp).toMatchObject({
			type: 'agent_crashed',
			message: 'Oh My Pi exited with code 9: plain failure',
			agentId: 'omp',
		});
	});
});

describe('OMP TTSR adapter hook', () => {
	it('suppresses only documented TTSR aborts while preserving usage and exit fallback', () => {
		const parser = new OmpOutputParser();

		expect(parser.parseJsonObject(OMP_TTSR_GOLDEN_CASES.messageEnd)).toEqual({
			type: 'usage',
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0.01,
			},
			raw: OMP_TTSR_GOLDEN_CASES.messageEnd,
		});
		expect(parser.parseJsonObject(OMP_TTSR_GOLDEN_CASES.agentEnd)).toEqual({
			type: 'system',
			raw: OMP_TTSR_GOLDEN_CASES.agentEnd,
		});
		expect(parser.detectErrorFromParsed(OMP_TTSR_GOLDEN_CASES.messageEnd)).toBeNull();
		expect(parser.parseJsonObject(OMP_TTSR_GOLDEN_CASES.nonTtsr)).toMatchObject({
			type: 'error',
			text: 'TTSR matched rulebook is unavailable',
		});
	});
});
