#!/usr/bin/env node
// src/shared/maestro-lib/bin/run-turn.ts

/**
 * Run one agent turn from a plain program.
 *
 * Everything here comes from maestro-lib: no desktop app, no window, no
 * Electron. It starts a provider, sends a prompt, streams the reply as it
 * arrives, and reports how the turn ended together with the session id that
 * continues the conversation.
 *
 *   maestro-lib-run --agent <id> --cwd <dir> --prompt <text>
 *                   [--resume <session id>] [--model <model>]
 *                   [--command <path>] [--read-only]
 *
 * Output is JSON lines on stdout: one object per streamed event, then a final
 * `turn` object. Exit status: 0 for a completed turn, 1 for a crashed one,
 * 130 for a stopped one, 2 for a request that could not be started.
 */

import type { ParsedEvent } from '../parsers/agent-output-parser';
import { BACKGROUND_STOP_GRACE_MS } from '../control/termination';
import { runTurn, UnknownProviderError, type CompletedTurn } from '../run/run-to-completion';
import { planSessionTurn, type SessionTurnRequest } from '../run/session';

const EXIT_COMPLETED = 0;
const EXIT_CRASHED = 1;
const EXIT_BAD_REQUEST = 2;
/** The shell convention for a process ended by an interrupt (128 + SIGINT). */
const EXIT_STOPPED = 130;

const USAGE = `Usage: maestro-lib-run --agent <id> --cwd <dir> --prompt <text>
                       [--resume <session id>] [--model <model>]
                       [--command <path>] [--read-only]`;

type ParsedArgs = { ok: true; request: SessionTurnRequest } | { ok: false; error: string };

const VALUE_FLAGS = ['--agent', '--cwd', '--prompt', '--resume', '--model', '--command'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

function isValueFlag(flag: string): flag is ValueFlag {
	return (VALUE_FLAGS as readonly string[]).includes(flag);
}

export function parseRunTurnArgs(argv: string[]): ParsedArgs {
	const values = new Map<ValueFlag, string>();
	let readOnly = false;

	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--read-only') {
			readOnly = true;
			continue;
		}
		if (!isValueFlag(flag)) {
			return { ok: false, error: `Unknown option: ${flag}` };
		}
		const value = argv[index + 1];
		if (value === undefined) {
			return { ok: false, error: `${flag} needs a value` };
		}
		values.set(flag, value);
		index++;
	}

	const agentId = values.get('--agent');
	const cwd = values.get('--cwd');
	const prompt = values.get('--prompt');
	if (!agentId) return { ok: false, error: '--agent is required' };
	if (!cwd) return { ok: false, error: '--cwd is required' };
	if (prompt === undefined) return { ok: false, error: '--prompt is required' };

	return {
		ok: true,
		request: {
			agentId,
			cwd,
			prompt,
			resumeSessionId: values.get('--resume'),
			model: values.get('--model'),
			command: values.get('--command'),
			readOnly,
		},
	};
}

function writeLine(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** The streamed form of one parsed event: what it is and what it says, nothing provider-specific. */
function describeEvent(event: ParsedEvent): Record<string, unknown> | null {
	switch (event.type) {
		case 'init':
			return { type: 'session', sessionId: event.sessionId };
		case 'text':
			return {
				type: event.isReasoning ? 'thinking' : 'text',
				text: event.text,
				partial: Boolean(event.isPartial),
			};
		case 'tool_use':
			return { type: 'tool', name: event.toolName, state: event.toolState };
		case 'usage':
			return { type: 'usage', usage: event.usage };
		case 'error':
			return { type: 'error', message: event.text };
		case 'result':
			return { type: 'result', text: event.text };
		default:
			return null;
	}
}

function exitStatusFor(turn: CompletedTurn): number {
	if (turn.outcome === 'interrupted') return EXIT_STOPPED;
	if (turn.outcome === 'crashed') return EXIT_CRASHED;
	return EXIT_COMPLETED;
}

export async function main(argv: string[]): Promise<number> {
	const parsed = parseRunTurnArgs(argv);
	if (!parsed.ok) {
		process.stderr.write(`${parsed.error}\n${USAGE}\n`);
		return EXIT_BAD_REQUEST;
	}

	const planned = await planSessionTurn(parsed.request);
	if (!planned.ok) {
		process.stderr.write(`${planned.error}\n`);
		return EXIT_BAD_REQUEST;
	}

	let running;
	try {
		running = runTurn(
			planned.spec,
			{
				agentId: parsed.request.agentId,
				sessionId: 'maestro-lib-run',
				stopGraceMs: BACKGROUND_STOP_GRACE_MS,
				label: 'maestro-lib-run',
			},
			{
				onStarted: (pid) => writeLine({ type: 'started', pid, resuming: planned.resuming }),
				onEvent: (event) => {
					const described = describeEvent(event);
					if (described) writeLine(described);
				},
			}
		);
	} catch (error) {
		if (!(error instanceof UnknownProviderError)) throw error;
		process.stderr.write(`${error.message}\n`);
		return EXIT_BAD_REQUEST;
	}

	// The first signal stops the turn so it can end with a result. A second one
	// means the operator will not wait: end the agent's tree now, then leave.
	let stopping = false;
	const onSignal = (): void => {
		if (stopping) {
			running.handle.terminateNow({ blocking: true });
			process.exit(EXIT_STOPPED);
		}
		stopping = true;
		running.handle.interrupt();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	const turn = await running.completed;
	process.off('SIGINT', onSignal);
	process.off('SIGTERM', onSignal);

	writeLine({
		type: 'turn',
		outcome: turn.outcome,
		sessionId: turn.sessionId ?? null,
		answer: turn.answerText ?? null,
		usage: turn.usage ?? null,
		error: turn.error?.message ?? null,
		exitCode: turn.exit.exitCode,
		signal: turn.exit.signal,
	});
	return exitStatusFor(turn);
}

if (require.main === module) {
	main(process.argv.slice(2)).then(
		(status) => {
			process.exitCode = status;
		},
		(error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
			process.exitCode = EXIT_CRASHED;
		}
	);
}
