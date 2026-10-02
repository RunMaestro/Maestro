import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { PianolaProgram, PianolaAsk } from '../../../shared/pianola/pianola-programs';
import type { PianolaPlan } from '../../../shared/pianola/pianola-tasks';

const { state, connect, sendCommand, disconnect } = vi.hoisted(() => ({
	state: { programs: [] as PianolaProgram[], asks: [] as PianolaAsk[], plans: [] as PianolaPlan[] },
	connect: vi.fn(),
	sendCommand: vi.fn(),
	disconnect: vi.fn(),
}));
vi.mock('../../../cli/commands/pianola', () => ({ ensurePianolaEnabled: vi.fn() }));
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = connect;
		sendCommand = sendCommand;
		disconnect = disconnect;
	},
}));
vi.mock('../../../cli/services/agent-run-store', () => ({ readAgentRuns: vi.fn(() => []) }));
vi.mock('../../../cli/services/pianola-store', () => ({
	readPianolaPrograms: () => state.programs,
	upsertPianolaProgram: (program: PianolaProgram) => {
		state.programs = [...state.programs.filter((p) => p.id !== program.id), program];
		return state.programs;
	},
	readPianolaAsks: () => state.asks,
	writePianolaAsks: (asks: PianolaAsk[]) => {
		state.asks = asks;
		return asks;
	},
	readPianolaPlans: () => state.plans,
	readPianolaDecisions: () => [],
}));

import {
	pianolaProgramApply,
	pianolaEscalate,
	pianolaResolve,
	pianolaDismiss,
	pianolaNeedsMe,
	pianolaBrief,
} from '../../../cli/commands/pianola-portfolio';

beforeEach(() => {
	state.programs = [];
	state.asks = [];
	state.plans = [];
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	connect.mockResolvedValue(undefined);
	sendCommand.mockResolvedValue({ success: true, sessionId: 'session-1' });
});

describe('portfolio CLI commands', () => {
	it('applies a real-manifest-shaped YAML program once, with its role model and remote root', async () => {
		const file = path.resolve(__dirname, 'fixtures/maestro-programs.yaml');
		await pianolaProgramApply({ file, json: true });
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'create_session',
				toolType: 'omp',
				cwd: '/home/dev/ai-ventures',
				customModel: 'openai-codex/gpt-5.6-sol',
				sessionSshRemoteConfig: expect.objectContaining({ remoteId: 'wsl-dev' }),
			}),
			'create_session_result'
		);
		expect(state.programs[0].roles.lead.agentId).toBe('session-1');
		const saved = state.programs[0];
		await pianolaProgramApply({ file, json: true });
		expect(state.programs[0]).toEqual(saved);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(sendCommand).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});
	it('retries a role left unassigned by an interrupted apply', async () => {
		state.programs = [
			{
				id: 'ai-ventures',
				title: 'AI Ventures',
				root: '/home/dev/ai-ventures',
				remoteId: 'wsl-dev',
				roles: {
					lead: {
						name: 'AI Ventures Lead',
						agentType: 'omp',
						model: 'openai-codex/gpt-5.6-sol',
						instructions:
							'Project Lead for AI Ventures. Own the roadmap, hand off one bounded outcome at a time as a plan under this program, and direct engineer, qa, and marketing on it.',
					},
				},
				charter: { maxConcurrent: 2, maxAttempts: 3, validationRequired: true },
				status: 'active',
				createdAt: 1,
				updatedAt: 1,
			},
		];
		await pianolaProgramApply({
			file: path.resolve(__dirname, 'fixtures/maestro-programs.yaml'),
			json: true,
		});
		expect(state.programs[0].roles.lead.agentId).toBe('session-1');
	});
	it('escalates with dedupe, resolves a decision, and keeps separate asks distinct', () => {
		pianolaEscalate({
			title: 'First',
			detail: 'Need answer',
			agent: 'agent-1',
			severity: 'high',
			json: true,
		});
		const id = state.asks[0].id;
		pianolaEscalate({
			title: 'Updated',
			detail: 'More detail',
			agent: 'agent-1',
			severity: 'low',
			json: true,
		});
		expect(state.asks).toHaveLength(1);
		expect(state.asks[0]).toMatchObject({ id, title: 'Updated', severity: 'high' });
		pianolaEscalate({
			title: 'Separate',
			detail: 'Other question',
			agent: 'agent-1',
			distinct: true,
			json: true,
		});
		expect(state.asks).toHaveLength(2);
		pianolaResolve(id, { option: 'Proceed', note: 'Approved', json: true });
		expect(state.asks[0]).toMatchObject({
			status: 'resolved',
			resolution: { option: 'Proceed', note: 'Approved' },
		});
		pianolaDismiss(state.asks[1].id, { json: true });
		expect(state.asks[1].status).toBe('dismissed');
	});
	it('returns the matching needs-me list and brief for a founder', () => {
		pianolaEscalate({ title: 'Approval', detail: 'Choose one', json: true });
		pianolaNeedsMe({ json: true });
		const needs = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
		expect(needs).toEqual([expect.objectContaining({ kind: 'ask', title: 'Approval' })]);
		pianolaBrief({ json: true });
		const brief = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
		expect(brief.needsMe).toEqual(needs);
		expect(brief.inFlight).toEqual([]);
		expect(brief.verified).toEqual([]);
	});
});
