/**
 * `planSessionTurn`: from "run this agent on this prompt" to a process spec,
 * using nothing but the library.
 *
 * The provider's binary is the fake agent, handed in as `command`, so planning
 * is tested against real provider definitions without any provider installed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// Pinned so the same shape is asserted on every runner, with one Windows case:
// a session turn is planned as the CLI plans one, prompt on the command line.
const mocks = vi.hoisted(() => ({ isWindows: vi.fn(() => false) }));
vi.mock('../../../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../shared/platformDetection')>()),
	isWindows: () => mocks.isWindows(),
}));

import {
	planSessionTurn,
	type SessionTurnRequest,
} from '../../../../shared/maestro-lib/run/session';
import { QUERY_SOURCE_ENV_VAR } from '../../../../shared/querySource';
import { FAKE_AGENT_PATH } from './fakeAgent';

const CWD = path.resolve(__dirname);
const SESSION_ID = 'ses_f16769d8cffe7rc1MP406tiARM';

function request(overrides: Partial<SessionTurnRequest> = {}): SessionTurnRequest {
	return {
		agentId: 'opencode',
		cwd: CWD,
		prompt: 'fix the bug',
		command: FAKE_AGENT_PATH,
		...overrides,
	};
}

async function plan(overrides: Partial<SessionTurnRequest> = {}) {
	const planned = await planSessionTurn(request(overrides));
	if (!planned.ok) throw new Error(`expected a plan, got: ${planned.error}`);
	return planned;
}

/** Whether `needle` appears in `haystack` as a contiguous run. */
function containsRun(haystack: string[], needle: string[]): boolean {
	return haystack.some((_, start) =>
		needle.every((value, offset) => haystack[start + offset] === value)
	);
}

describe('planSessionTurn', () => {
	beforeEach(() => {
		mocks.isWindows.mockReturnValue(false);
	});

	it('plans a new OpenCode turn in batch mode, with the prompt on the command line', async () => {
		const { spec, resuming } = await plan();

		expect(resuming).toBe(false);
		expect(spec.command).toBe(FAKE_AGENT_PATH);
		expect(spec.cwd).toBe(CWD);
		expect(spec.args[0]).toBe('run');
		expect(containsRun(spec.args, ['--format', 'json'])).toBe(true);
		expect(spec.args).toContain('fix the bug');
		expect(spec.args).not.toContain('--session');
		expect(spec.stdin).toBeUndefined();
	});

	it.each([
		['opencode', ['--session', SESSION_ID]],
		['claude-code', ['--resume', SESSION_ID]],
	])('continues a %s session with that provider resume arguments', async (agentId, resumeArgs) => {
		const { spec, resuming } = await plan({ agentId, resumeSessionId: SESSION_ID });

		expect(resuming).toBe(true);
		expect(containsRun(spec.args, resumeArgs)).toBe(true);
		expect(spec.env.MAESTRO_SESSION_RESUMED).toBe('1');
	});

	it('does not mark a new session as resumed', async () => {
		const { spec } = await plan();

		expect(spec.env.MAESTRO_SESSION_RESUMED).toBeUndefined();
	});

	it('plans a Claude Code turn with stream-json output and full access', async () => {
		const { spec } = await plan({ agentId: 'claude-code' });

		expect(spec.args).toContain('--print');
		expect(containsRun(spec.args, ['--output-format', 'stream-json'])).toBe(true);
		expect(spec.args).toContain('--dangerously-skip-permissions');
		expect(spec.args.slice(-2)).toEqual(['--', 'fix the bug']);
	});

	it('plans a read-only turn with the provider plan-mode arguments and no bypass', async () => {
		const { spec } = await plan({ agentId: 'claude-code', readOnly: true });

		expect(containsRun(spec.args, ['--permission-mode', 'plan'])).toBe(true);
		expect(spec.args).not.toContain('--dangerously-skip-permissions');
	});

	it('selects the model through the provider own flag', async () => {
		const { spec } = await plan({ model: 'opencode/big-pickle' });

		expect(containsRun(spec.args, ['--model', 'opencode/big-pickle'])).toBe(true);
	});

	it('keeps the prompt on the command line on a Windows host, as the CLI does', async () => {
		mocks.isWindows.mockReturnValue(true);

		const { spec } = await plan({ agentId: 'claude-code' });

		expect(spec.stdin).toBeUndefined();
		expect(spec.args.slice(-2)).toEqual(['--', 'fix the bug']);
	});

	it('stays in batch mode for an empty prompt', async () => {
		// No terminal is attached, so dropping the batch arguments would start
		// the provider's interactive mode and fail on "stdin is not a terminal".
		const { spec } = await plan({ prompt: '' });

		expect(spec.args[0]).toBe('run');
		expect(containsRun(spec.args, ['--format', 'json'])).toBe(true);
	});

	it('builds the environment from the provider defaults and the request', async () => {
		const { spec } = await plan({
			envVars: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
			querySource: 'cue',
		});

		expect(spec.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
		expect(spec.env[QUERY_SOURCE_ENV_VAR]).toBe('cue');
		expect(spec.env.PATH).toBeTruthy();
	});

	it('refuses a provider it does not know', async () => {
		expect(await planSessionTurn(request({ agentId: 'no-such-provider' }))).toEqual({
			ok: false,
			reason: 'unknown-agent',
			error: 'Unknown agent "no-such-provider"',
		});
	});

	it('refuses a provider that cannot run a single turn', async () => {
		const planned = await planSessionTurn(request({ agentId: 'terminal' }));

		expect(planned).toMatchObject({ ok: false, reason: 'no-batch-mode' });
	});

	it('refuses to resume a provider that cannot', async () => {
		const planned = await planSessionTurn(
			request({ agentId: 'hermes', resumeSessionId: SESSION_ID })
		);

		expect(planned).toMatchObject({ ok: false, reason: 'no-resume' });
	});

	it('still plans a new turn for a provider that cannot resume', async () => {
		expect((await planSessionTurn(request({ agentId: 'hermes' }))).ok).toBe(true);
	});

	it('reports a binary that is not where the request said', async () => {
		const missing = path.join(CWD, 'no-such-binary');

		expect(await planSessionTurn(request({ command: missing }))).toEqual({
			ok: false,
			reason: 'not-installed',
			error: `OpenCode was not found at ${missing}`,
		});
	});
});
