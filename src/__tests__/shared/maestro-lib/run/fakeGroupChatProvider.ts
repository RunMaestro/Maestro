/**
 * A fake provider for the runtime's group chat and consult turns.
 *
 * The seam is `RuntimeDeps.background.runTurn`: the runtime plans a real process spec for a turn
 * (the real SSH, Claude and Windows decisions, the real pipe spec), and this swaps the command for
 * `src/__tests__/fixtures/fake-agent.mjs` replaying a synthesized Claude Code stream. A turn is
 * still a real process on a real pipe, started and stopped by the real run layer.
 *
 * What each process says is a script, told apart by the shape of its id (the router's own
 * rules, `Plans/maestro-tui-group-chat.md` B15): a moderator turn, a participant turn, a recovery
 * turn, or a consult. A synthesis turn runs under an ordinary moderator id (so its reply routes
 * like any moderator reply), so it is told apart by its prompt.
 */
import { parseParticipantSessionId } from '../../../../shared/maestro-lib/groupchat/session-ids';
import type { BackgroundTurnDeps } from '../../../../shared/maestro-lib/runtime/background-turns';
import { runTurn } from '../../../../shared/maestro-lib/run/run-to-completion';
import type { TurnProcessSpec } from '../../../../shared/maestro-lib/run/start-turn';
import { FAKE_AGENT_PATH, writeFakeTurn } from './fakeAgent';

export type FakeRole = 'moderator' | 'synthesis' | 'participant' | 'recovery' | 'consult' | 'other';

/** One turn the runtime asked for, as the script sees it. */
export interface FakeCall {
	processId: string;
	role: FakeRole;
	/** The participant's name, for a participant or recovery turn. */
	participant?: string;
	/** How many turns of this role this call is, from 1. */
	nth: number;
	spec: TurnProcessSpec;
}

/** What the fake process does. */
export interface FakeReply {
	/** The answer text. Empty: the process says nothing. */
	text: string;
	exitCode?: number;
	sessionId?: string;
	/** Stay running after the answer until stopped (a participant mid-work). */
	hold?: boolean;
	/** Extra stderr, for a failure that says why. */
	stderr?: string;
}

export type FakeScript = (call: FakeCall) => FakeReply;

/** What only the synthesis prompt says (`src/prompts/group-chat-moderator-synthesis.md`). */
const SYNTHESIS_MARKER = 'You are reviewing responses from AI agents in a group chat';

/** Everything the process was told: its arguments and its stdin. */
export const promptOf = (spec: TurnProcessSpec): string =>
	[...spec.args, spec.stdin ?? ''].join('\n');

export function roleOf(
	processId: string,
	spec?: TurnProcessSpec
): { role: FakeRole; participant?: string } {
	if (processId.startsWith('cross-agent-')) return { role: 'consult' };
	const participant = parseParticipantSessionId(processId);
	if (participant) {
		return {
			role: processId.includes('-recovery-') ? 'recovery' : 'participant',
			participant: participant.participantName,
		};
	}
	if (/-moderator-/.test(processId)) {
		return { role: spec && promptOf(spec).includes(SYNTHESIS_MARKER) ? 'synthesis' : 'moderator' };
	}
	return { role: 'other' };
}

/** A Claude Code stream-json turn that answers `text` and exits as told. */
export function claudeStream(text: string, sessionId: string): string[] {
	const usage = {
		input_tokens: 1000,
		output_tokens: 50,
		cache_read_input_tokens: 200,
		cache_creation_input_tokens: 100,
	};
	return [
		`${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5', slash_commands: [] })}\n`,
		`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], usage }, session_id: sessionId })}\n`,
		`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.01, usage })}\n`,
	];
}

export interface FakeGroupChatProvider {
	/** Pass as `deps.background.runTurn`. */
	runTurn: BackgroundTurnDeps['runTurn'];
	/** Every turn asked for, in order. */
	calls: FakeCall[];
	/** The turns asked for in one role. */
	callsFor(role: FakeRole): FakeCall[];
}

export function createFakeGroupChatProvider(
	dir: string,
	script: FakeScript
): FakeGroupChatProvider {
	const calls: FakeCall[] = [];
	const counts = new Map<FakeRole, number>();
	let sequence = 0;

	return {
		calls,
		callsFor: (role) => calls.filter((call) => call.role === role),
		runTurn: (spec, options, handlers) => {
			const processId = options.sessionId;
			const { role, participant } = roleOf(processId, spec);
			const nth = (counts.get(role) ?? 0) + 1;
			counts.set(role, nth);
			const call: FakeCall = { processId, role, participant, nth, spec };
			calls.push(call);

			const reply = script(call);
			const sessionId = reply.sessionId ?? `session-${++sequence}`;
			const recording = writeFakeTurn(dir, {
				chunks: reply.text ? claudeStream(reply.text, sessionId) : [],
				stderr: reply.stderr,
				close: { code: reply.exitCode ?? 0, signal: null },
			});
			const fakeSpec: TurnProcessSpec = {
				command: process.execPath,
				args: [FAKE_AGENT_PATH],
				cwd: dir,
				env: {
					...process.env,
					FAKE_AGENT_RECORDING: recording,
					...(reply.hold ? { FAKE_AGENT_HOLD: '1' } : {}),
				},
			};
			return runTurn(fakeSpec, { ...options, stopGraceMs: 200 }, handlers);
		},
	};
}
