// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTurn, TurnNotStartedError } from '../../../shared/maestro-lib/run/start-turn';
import {
	configureAgentAdmission,
	createAdmittedCliTurnStarter,
	hasHeadlessAgentActivity,
	issueAgentTurnAdmission,
	revokeAgentTurnAdmission,
} from '../../../main/utils/headless-agent-activity';

const spec = {
	command: process.execPath,
	args: ['-e', "console.log('first answer');setTimeout(() => {}, 200)"],
	cwd: process.cwd(),
};
afterEach(() => configureAgentAdmission(() => true));
describe('final headless turn admission', () => {
	it.each(['missing', 'forged', 'foreign', 'revoked', 'reserved'])(
		'rejects %s identity before a process can start',
		(kind) => {
			const proof = issueAgentTurnAdmission('worker');
			if (kind === 'revoked') revokeAgentTurnAdmission(proof);
			if (kind === 'reserved') configureAgentAdmission(() => false);
			const launch = vi.fn(startTurn);
			const start = createAdmittedCliTurnStarter(
				launch,
				{
					originWorkerId: kind === 'foreign' ? 'other' : 'worker',
					workerAdmission:
						kind === 'missing' ? undefined : kind === 'forged' ? { agentId: 'worker' } : proof,
				},
				false
			);
			expect(() => start(spec, {}, { stopGraceMs: 20 })).toThrow();
			expect(launch).not.toHaveBeenCalled();
			expect(hasHeadlessAgentActivity('worker')).toBe(false);
		}
	);
	it('holds a real child beyond its first answer and abort, until exit', async () => {
		const abort = new AbortController();
		const proof = issueAgentTurnAdmission('worker', abort.signal);
		let first!: () => void;
		const answer = new Promise<void>((resolve) => {
			first = resolve;
		});
		const start = createAdmittedCliTurnStarter(
			startTurn,
			{ originWorkerId: 'worker', workerAdmission: proof, signal: abort.signal },
			false
		);
		const turn = start(spec, { onStdout: first }, { stopGraceMs: 20 });
		try {
			await answer;
			expect(hasHeadlessAgentActivity('worker')).toBe(true);
			abort.abort();
			expect(hasHeadlessAgentActivity('worker')).toBe(true);
			expect(() => start(spec, {}, { stopGraceMs: 20 })).toThrow();
			await turn.done;
			expect(hasHeadlessAgentActivity('worker')).toBe(false);
		} finally {
			turn.terminate();
			await turn.done;
			revokeAgentTurnAdmission(proof);
		}
	});
	it('releases a proven synchronous nonstart exactly once', () => {
		const proof = issueAgentTurnAdmission('worker');
		const start = createAdmittedCliTurnStarter(
			() => {
				throw new TurnNotStartedError(new Error('nonstart'));
			},
			{ originWorkerId: 'worker', workerAdmission: proof },
			false
		);
		expect(() => start(spec, {}, { stopGraceMs: 20 })).toThrow('nonstart');
		expect(hasHeadlessAgentActivity('worker')).toBe(false);
		revokeAgentTurnAdmission(proof);
	});
	it('retains uncertain remote occupancy after a real local client stops', async () => {
		const proof = issueAgentTurnAdmission('remote-worker');
		let first!: () => void;
		const ready = new Promise<void>((resolve) => {
			first = resolve;
		});
		// This child represents only the local SSH client, not a remote process.
		const start = createAdmittedCliTurnStarter(
			startTurn,
			{ originWorkerId: 'remote-worker', workerAdmission: proof },
			true
		);
		const turn = start(
			{ ...spec, args: ['-e', "console.log('ready');setInterval(() => {}, 1000)"] },
			{ onStdout: first },
			{ stopGraceMs: 20 }
		);
		try {
			await ready;
			turn.terminate();
			await turn.done;
			expect(hasHeadlessAgentActivity('remote-worker')).toBe(true);
		} finally {
			turn.terminate();
			await turn.done;
			revokeAgentTurnAdmission(proof);
		}
	});
});
