/**
 * Test helpers for starting `src/__tests__/fixtures/fake-agent.mjs` as a real
 * process in place of a provider.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TurnProcessSpec } from '../../../../shared/maestro-lib/run/start-turn';
import type { TurnRecording } from '../../../main/process-manager/recordings/fixtures';

export const FAKE_AGENT_PATH = path.resolve(__dirname, '../../../fixtures/fake-agent.mjs');

/** What the fake agent replays. */
export interface FakeTurn {
	chunks: string[];
	stderr?: string;
	close: { code: number | null; signal: NodeJS.Signals | null };
}

export function fakeTurnFromRecording(recording: TurnRecording): FakeTurn {
	return {
		chunks: recording.chunks,
		stderr: recording.stderrBuffer,
		close: { code: recording.exitCode, signal: recording.exitSignal ?? null },
	};
}

/** A scratch directory per test file, removed by `cleanup()`. */
export function createScratchDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
	return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

let sequence = 0;

export function writeFakeTurn(dir: string, turn: FakeTurn): string {
	const file = path.join(dir, `turn-${++sequence}.json`);
	fs.writeFileSync(file, JSON.stringify(turn));
	return file;
}

export interface FakeAgentOptions {
	/** Stay running after the replay, until signalled. */
	hold?: boolean;
	stdin?: string;
	argvOut?: string;
	stdinOut?: string;
	envOut?: string;
	args?: string[];
}

/**
 * A process spec that runs the fake agent under this test's own `node`, so it
 * starts the same way on every platform.
 */
export function fakeAgentSpec(
	dir: string,
	turn: FakeTurn,
	options: FakeAgentOptions = {}
): TurnProcessSpec {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FAKE_AGENT_RECORDING: writeFakeTurn(dir, turn),
	};
	if (options.hold) env.FAKE_AGENT_HOLD = '1';
	if (options.argvOut) env.FAKE_AGENT_ARGV_OUT = options.argvOut;
	if (options.stdinOut) env.FAKE_AGENT_STDIN_OUT = options.stdinOut;
	if (options.envOut) env.FAKE_AGENT_ENV_OUT = options.envOut;

	return {
		command: process.execPath,
		args: [FAKE_AGENT_PATH, ...(options.args ?? [])],
		cwd: dir,
		env,
		stdin: options.stdin,
	};
}
