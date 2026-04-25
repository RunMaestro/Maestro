import { describe, it, expect } from 'vitest';
import {
	validatePipelines,
	DEFAULT_TRIGGER_LABELS,
} from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineValidation';
import type {
	CuePipeline,
	PipelineNode,
	PipelineEdge,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
	CueEventType,
} from '../../../../../shared/cue-pipeline-types';

function triggerNode(
	id: string,
	eventType: CueEventType,
	config: TriggerNodeData['config'] = {},
	customLabel?: string
): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: { eventType, label: 'Trigger', customLabel, config },
	};
}

function agentNode(id: string, data: Partial<AgentNodeData> = {}): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 0, y: 0 },
		data: {
			sessionId: `session-${id}`,
			sessionName: data.sessionName ?? `Agent ${id}`,
			toolType: 'claude-code',
			inputPrompt: data.inputPrompt,
			outputPrompt: data.outputPrompt,
			includeUpstreamOutput: data.includeUpstreamOutput,
			fanInTimeoutMinutes: data.fanInTimeoutMinutes,
			fanInTimeoutOnFail: data.fanInTimeoutOnFail,
		},
	};
}

function edge(id: string, source: string, target: string, prompt?: string): PipelineEdge {
	return { id, source, target, mode: 'pass', prompt };
}

function commandNode(id: string, data: Partial<CommandNodeData> = {}): PipelineNode {
	return {
		id,
		type: 'command',
		position: { x: 0, y: 0 },
		data: {
			name: data.name ?? `cmd-${id}`,
			mode: data.mode ?? 'shell',
			shell: data.shell,
			cliCommand: data.cliCommand,
			cliTarget: data.cliTarget,
			cliMessage: data.cliMessage,
			owningSessionId: data.owningSessionId ?? 'session-owner',
			owningSessionName: data.owningSessionName ?? 'Owner Session',
		},
	};
}

function pipeline(
	name: string,
	nodes: PipelineNode[],
	edges: PipelineEdge[] = [],
	id = `p-${name}`
): CuePipeline {
	return { id, name, color: '#06b6d4', nodes, edges };
}

describe('pipelineValidation', () => {
	describe('DEFAULT_TRIGGER_LABELS', () => {
		it('covers all 9 CueEventType values', () => {
			expect(Object.keys(DEFAULT_TRIGGER_LABELS)).toHaveLength(9);
			expect(DEFAULT_TRIGGER_LABELS['app.startup']).toBe('Startup');
			expect(DEFAULT_TRIGGER_LABELS['time.heartbeat']).toBe('Heartbeat');
			expect(DEFAULT_TRIGGER_LABELS['time.scheduled']).toBe('Scheduled');
			expect(DEFAULT_TRIGGER_LABELS['file.changed']).toBe('File Change');
			expect(DEFAULT_TRIGGER_LABELS['agent.completed']).toBe('Agent Done');
			expect(DEFAULT_TRIGGER_LABELS['github.pull_request']).toBe('Pull Request');
			expect(DEFAULT_TRIGGER_LABELS['github.issue']).toBe('Issue');
			expect(DEFAULT_TRIGGER_LABELS['task.pending']).toBe('Pending Task');
			expect(DEFAULT_TRIGGER_LABELS['cli.trigger']).toBe('CLI Trigger');
		});
	});

	describe('validatePipelines', () => {
		it('returns no errors for empty input', () => {
			expect(validatePipelines([])).toEqual([]);
		});

		it('flags completely empty pipelines', () => {
			const errors = validatePipelines([pipeline('Empty', [])]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(/add a trigger and an agent/);
		});

		it('flags missing triggers', () => {
			const a = agentNode('a1', { inputPrompt: 'p' });
			const errors = validatePipelines([pipeline('NoTrig', [a])]);
			expect(errors.some((e) => /needs at least one trigger/.test(e))).toBe(true);
		});

		it('flags missing agents', () => {
			const t = triggerNode('t1', 'app.startup');
			const errors = validatePipelines([pipeline('NoAgent', [t])]);
			expect(errors.some((e) => /needs at least one agent/.test(e))).toBe(true);
		});

		it('flags disconnected agents', () => {
			const t = triggerNode('t1', 'app.startup');
			const a = agentNode('a1', { sessionName: 'Alpha', inputPrompt: 'p' });
			const errors = validatePipelines([pipeline('Disc', [t, a], [])]);
			expect(errors.some((e) => /agent "Alpha" has no incoming connection/.test(e))).toBe(true);
		});

		it('flags agents without prompts (no node prompt, no edge prompt)', () => {
			const t = triggerNode('t1', 'app.startup');
			const a = agentNode('a1', { sessionName: 'Bravo' });
			const errors = validatePipelines([pipeline('NoPrompt', [t, a], [edge('e1', 't1', 'a1')])]);
			expect(errors.some((e) => /agent "Bravo" is missing a prompt/.test(e))).toBe(true);
		});

		it('accepts agent with node-level prompt', () => {
			const t = triggerNode('t1', 'app.startup');
			const a = agentNode('a1', { sessionName: 'Charlie', inputPrompt: 'Do X' });
			const errors = validatePipelines([pipeline('OK', [t, a], [edge('e1', 't1', 'a1')])]);
			expect(errors).toEqual([]);
		});

		it('accepts agent when all trigger edges have prompts', () => {
			const t1 = triggerNode('t1', 'app.startup');
			const t2 = triggerNode('t2', 'time.heartbeat', { interval_minutes: 5 });
			const a = agentNode('a1', { sessionName: 'Delta' });
			const pipe = pipeline(
				'EdgePrompts',
				[t1, t2, a],
				[edge('e1', 't1', 'a1', 'p1'), edge('e2', 't2', 'a1', 'p2')]
			);
			expect(validatePipelines([pipe])).toEqual([]);
		});

		it('flags chain agent with upstream-output disabled and no node prompt', () => {
			const t = triggerNode('t1', 'app.startup');
			const a1 = agentNode('a1', { sessionName: 'Echo', inputPrompt: 'Start' });
			const a2 = agentNode('a2', { sessionName: 'Foxtrot', includeUpstreamOutput: false });
			const errors = validatePipelines([
				pipeline('Chain', [t, a1, a2], [edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2')]),
			]);
			expect(errors.some((e) => /agent "Foxtrot" is missing a prompt/.test(e))).toBe(true);
		});

		it('accepts chain agent that inherits upstream output', () => {
			const t = triggerNode('t1', 'app.startup');
			const a1 = agentNode('a1', { inputPrompt: 'Start' });
			const a2 = agentNode('a2'); // no prompt, but includeUpstreamOutput defaults to true
			expect(
				validatePipelines([
					pipeline('Chain', [t, a1, a2], [edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2')]),
				])
			).toEqual([]);
		});

		describe('per-event trigger config', () => {
			it('time.heartbeat requires positive interval_minutes', () => {
				const cases = [
					{ interval_minutes: undefined },
					{ interval_minutes: 0 },
					{ interval_minutes: -5 },
					{ interval_minutes: Number.NaN },
				];
				for (const config of cases) {
					const t = triggerNode('t1', 'time.heartbeat', config as TriggerNodeData['config']);
					const a = agentNode('a1', { inputPrompt: 'p' });
					const errors = validatePipelines([pipeline('HB', [t, a], [edge('e1', 't1', 'a1')])]);
					expect(errors.some((e) => /positive interval/.test(e))).toBe(true);
				}
			});

			it('time.heartbeat accepts positive interval', () => {
				const t = triggerNode('t1', 'time.heartbeat', { interval_minutes: 5 });
				const a = agentNode('a1', { inputPrompt: 'p' });
				expect(validatePipelines([pipeline('HB', [t, a], [edge('e1', 't1', 'a1')])])).toEqual([]);
			});

			it('time.scheduled requires schedule_times array', () => {
				const cases: TriggerNodeData['config'][] = [{}, { schedule_times: [] }];
				for (const config of cases) {
					const t = triggerNode('t1', 'time.scheduled', config);
					const a = agentNode('a1', { inputPrompt: 'p' });
					const errors = validatePipelines([pipeline('Sched', [t, a], [edge('e1', 't1', 'a1')])]);
					expect(errors.some((e) => /at least one schedule time/.test(e))).toBe(true);
				}
			});

			it('time.scheduled accepts non-empty schedule_times', () => {
				const t = triggerNode('t1', 'time.scheduled', { schedule_times: ['09:00'] });
				const a = agentNode('a1', { inputPrompt: 'p' });
				expect(validatePipelines([pipeline('Sched', [t, a], [edge('e1', 't1', 'a1')])])).toEqual(
					[]
				);
			});

			it('file.changed requires non-empty watch pattern', () => {
				const cases: TriggerNodeData['config'][] = [{}, { watch: '' }, { watch: '   ' }];
				for (const config of cases) {
					const t = triggerNode('t1', 'file.changed', config);
					const a = agentNode('a1', { inputPrompt: 'p' });
					const errors = validatePipelines([pipeline('FC', [t, a], [edge('e1', 't1', 'a1')])]);
					expect(errors.some((e) => /needs a "watch" glob pattern/.test(e))).toBe(true);
				}
			});

			it('task.pending requires non-empty watch pattern', () => {
				const t = triggerNode('t1', 'task.pending', {});
				const a = agentNode('a1', { inputPrompt: 'p' });
				const errors = validatePipelines([pipeline('TP', [t, a], [edge('e1', 't1', 'a1')])]);
				expect(errors.some((e) => /needs a "watch" glob pattern/.test(e))).toBe(true);
			});

			it('github.pull_request accepts missing repo (defaults to current)', () => {
				const t = triggerNode('t1', 'github.pull_request', {});
				const a = agentNode('a1', { inputPrompt: 'p' });
				expect(validatePipelines([pipeline('PR', [t, a], [edge('e1', 't1', 'a1')])])).toEqual([]);
			});

			it('github.pull_request flags empty-string repo', () => {
				const t = triggerNode('t1', 'github.pull_request', { repo: '  ' });
				const a = agentNode('a1', { inputPrompt: 'p' });
				const errors = validatePipelines([pipeline('PR', [t, a], [edge('e1', 't1', 'a1')])]);
				expect(errors.some((e) => /empty "repo"/.test(e))).toBe(true);
			});

			it('github.issue same rule as pull_request', () => {
				const t = triggerNode('t1', 'github.issue', { repo: '' });
				const a = agentNode('a1', { inputPrompt: 'p' });
				const errors = validatePipelines([pipeline('Issue', [t, a], [edge('e1', 't1', 'a1')])]);
				expect(errors.some((e) => /empty "repo"/.test(e))).toBe(true);
			});

			it('includes customLabel in trigger error messages', () => {
				const t = triggerNode('t1', 'time.heartbeat', {}, 'Morning Check');
				const a = agentNode('a1', { inputPrompt: 'p' });
				const errors = validatePipelines([pipeline('HB', [t, a], [edge('e1', 't1', 'a1')])]);
				expect(errors.some((e) => /"Morning Check"/.test(e))).toBe(true);
			});
		});

		describe('cycle detection', () => {
			it('rejects self-loop (A -> A)', () => {
				const a = agentNode('a1', { inputPrompt: 'p' });
				const t = triggerNode('t1', 'app.startup');
				const errors = validatePipelines([
					pipeline('Self', [t, a], [edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a1')]),
				]);
				expect(errors.some((e) => /contains a cycle/.test(e))).toBe(true);
			});

			it('rejects two-node cycle (A -> B -> A)', () => {
				const t = triggerNode('t1', 'app.startup');
				const a = agentNode('a1', { inputPrompt: 'p' });
				const b = agentNode('a2', { inputPrompt: 'p' });
				const errors = validatePipelines([
					pipeline(
						'AB',
						[t, a, b],
						[edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2'), edge('e3', 'a2', 'a1')]
					),
				]);
				expect(errors.some((e) => /contains a cycle/.test(e))).toBe(true);
			});

			it('rejects three-node cycle (A -> B -> C -> A)', () => {
				const t = triggerNode('t1', 'app.startup');
				const a = agentNode('a1', { inputPrompt: 'p' });
				const b = agentNode('a2', { inputPrompt: 'p' });
				const c = agentNode('a3', { inputPrompt: 'p' });
				const errors = validatePipelines([
					pipeline(
						'ABC',
						[t, a, b, c],
						[
							edge('e1', 't1', 'a1'),
							edge('e2', 'a1', 'a2'),
							edge('e3', 'a2', 'a3'),
							edge('e4', 'a3', 'a1'),
						]
					),
				]);
				expect(errors.some((e) => /contains a cycle/.test(e))).toBe(true);
			});

			it('accepts linear DAG with 10+ nodes (no false cycle)', () => {
				const t = triggerNode('t1', 'app.startup');
				const agents = Array.from({ length: 12 }, (_, i) =>
					agentNode(`a${i}`, { inputPrompt: 'p' })
				);
				const edges: PipelineEdge[] = [edge('e0', 't1', 'a0')];
				for (let i = 0; i < agents.length - 1; i++) {
					edges.push(edge(`e${i + 1}`, `a${i}`, `a${i + 1}`));
				}
				expect(validatePipelines([pipeline('DAG', [t, ...agents], edges)])).toEqual([]);
			});

			it('accepts fan-out DAG (A -> B, A -> C)', () => {
				const t = triggerNode('t1', 'app.startup');
				const a = agentNode('a1', { inputPrompt: 'p' });
				const b = agentNode('a2', { inputPrompt: 'p' });
				const c = agentNode('a3', { inputPrompt: 'p' });
				expect(
					validatePipelines([
						pipeline(
							'FanOut',
							[t, a, b, c],
							[edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2'), edge('e3', 'a1', 'a3')]
						),
					])
				).toEqual([]);
			});

			it('accepts fan-in DAG (A -> C, B -> C)', () => {
				const t = triggerNode('t1', 'app.startup');
				const a = agentNode('a1', { inputPrompt: 'p' });
				const b = agentNode('a2', { inputPrompt: 'p' });
				const c = agentNode('a3', { inputPrompt: 'p' });
				expect(
					validatePipelines([
						pipeline(
							'FanIn',
							[t, a, b, c],
							[
								edge('e0', 't1', 'a1'),
								edge('e0b', 't1', 'a2'),
								edge('e1', 'a1', 'a3'),
								edge('e2', 'a2', 'a3'),
							]
						),
					])
				).toEqual([]);
			});
		});

		describe('command nodes', () => {
			it('flags command with no owning agent (unbound from standalone pill)', () => {
				const t = triggerNode('t1', 'app.startup');
				const c = commandNode('c1', {
					name: 'lint',
					mode: 'shell',
					shell: 'npm run lint',
					owningSessionId: '',
				});
				const errors = validatePipelines([
					pipeline('UnboundCmd', [t, c], [edge('e1', 't1', 'c1')]),
				]);
				expect(errors.some((e) => /command "lint" needs an owning agent/.test(e))).toBe(true);
			});

			it('flags shell-mode command missing a shell body', () => {
				const t = triggerNode('t1', 'app.startup');
				const c = commandNode('c1', { name: 'lint', mode: 'shell', shell: '' });
				const errors = validatePipelines([
					pipeline('EmptyShell', [t, c], [edge('e1', 't1', 'c1')]),
				]);
				expect(errors.some((e) => /missing a shell command/.test(e))).toBe(true);
			});

			it('flags cli-mode command missing a target session', () => {
				const t = triggerNode('t1', 'app.startup');
				const c = commandNode('c1', {
					name: 'relay',
					mode: 'cli',
					cliCommand: 'send',
					cliTarget: '',
				});
				const errors = validatePipelines([pipeline('EmptyCli', [t, c], [edge('e1', 't1', 'c1')])]);
				expect(errors.some((e) => /missing a target session/.test(e))).toBe(true);
			});

			it('accepts a well-formed shell command node', () => {
				const t = triggerNode('t1', 'app.startup');
				const c = commandNode('c1', {
					name: 'lint',
					mode: 'shell',
					shell: 'npm run lint',
				});
				expect(validatePipelines([pipeline('GoodCmd', [t, c], [edge('e1', 't1', 'c1')])])).toEqual(
					[]
				);
			});

			it('accepts pipeline with only command (no agents)', () => {
				// A trigger -> command pipeline is valid; the old "needs at least one agent"
				// rule was too strict — command-only pipelines ship work too.
				const t = triggerNode('t1', 'app.startup');
				const c = commandNode('c1', {
					name: 'lint',
					mode: 'shell',
					shell: 'echo hi',
				});
				expect(validatePipelines([pipeline('CmdOnly', [t, c], [edge('e1', 't1', 'c1')])])).toEqual(
					[]
				);
			});
		});

		it('validates multiple pipelines independently', () => {
			const ok = pipeline(
				'Good',
				[triggerNode('t1', 'app.startup'), agentNode('a1', { inputPrompt: 'p' })],
				[edge('e1', 't1', 'a1')]
			);
			const bad = pipeline('Bad', []);
			const errors = validatePipelines([ok, bad]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(/"Bad"/);
		});
	});
});
