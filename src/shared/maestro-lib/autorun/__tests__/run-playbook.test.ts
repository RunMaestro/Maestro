import { describe, expect, it } from 'vitest';
import type { Playbook } from '../../../types';
import { runPlaybook } from '../run-playbook';
import { collect, createFakeDeps, session, tickFirstTask } from './fake-deps';

const playbook = (overrides: Partial<Playbook> = {}): Playbook => ({
	id: 'pb-1',
	name: 'Test Playbook',
	createdAt: 0,
	updatedAt: 0,
	prompt: 'Do the task',
	documents: [{ filename: 'tasks', resetOnCompletion: false }],
	loopEnabled: false,
	...overrides,
});

const types = (events: Array<{ type: string }>) => events.map((e) => e.type);

describe('runPlaybook (library engine)', () => {
	it('runs a document task by task and writes one row per task plus the run summary', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n- [ ] three\n' });

		const events = await collect(
			runPlaybook(session(), playbook(), '/playbooks', { skipSynopsis: true }, fake.deps)
		);

		expect(types(events)).toEqual([
			'start',
			'document_start',
			'task_start',
			'task_complete',
			'task_start',
			'task_complete',
			'task_start',
			'task_complete',
			'document_complete',
			'complete',
		]);
		expect(fake.docs.get('tasks')).toBe('- [x] one\n- [x] two\n- [x] three\n');
		const taskRows = fake.history.filter((e) => e.completedTaskCount !== undefined);
		expect(taskRows).toHaveLength(3);
		expect(taskRows.every((e) => e.completedTaskCount === 1)).toBe(true);
		expect(fake.history.at(-1)?.summary).toBe('Auto Run completed: 3 tasks in 1 loop');
		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			success: true,
			totalTasksCompleted: 3,
		});
	});

	it('prepares once, after the preflight reads and before the first task', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });

		await collect(runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps));

		expect(fake.order.filter((s) => s === 'prepare')).toHaveLength(1);
		expect(fake.order.indexOf('prepare')).toBeLessThan(fake.order.indexOf('turn:task'));
	});

	it('marks the agent busy for the run and clears it on every exit', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n' });

		await collect(runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps));

		expect(fake.activity[0]).toBe('begin:agent-1:pb-1');
		expect(fake.activity.at(-1)).toBe('end:agent-1');
	});

	it('clears the busy mark when the consumer abandons the generator', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });
		const generator = runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps);

		await generator.next();
		await generator.return(undefined);

		expect(fake.activity.at(-1)).toBe('end:agent-1');
	});

	it('refuses a document set with no unchecked tasks', async () => {
		const fake = createFakeDeps({ tasks: '- [x] done\n' });

		const events = await collect(runPlaybook(session(), playbook(), '/p', {}, fake.deps));

		expect(events.at(-1)).toMatchObject({ type: 'error', code: 'NO_TASKS' });
		expect(fake.requests).toHaveLength(0);
	});

	it('refuses to start over a halt marker an earlier run left', async () => {
		const fake = createFakeDeps({ tasks: '<!-- maestro:halt: blocked -->\n- [ ] one\n' });

		const events = await collect(runPlaybook(session(), playbook(), '/p', {}, fake.deps));

		expect(events.at(-1)).toMatchObject({ type: 'error', code: 'HALT_MARKER_PRESENT' });
		expect(fake.requests).toHaveLength(0);
	});

	it('previews tasks on a dry run without a turn, a prepare, or a History row', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });

		const events = await collect(
			runPlaybook(session(), playbook(), '/p', { dryRun: true }, fake.deps)
		);

		expect(types(events).filter((t) => t === 'task_preview')).toHaveLength(2);
		expect(events.at(-1)).toMatchObject({ type: 'complete', dryRun: true, wouldProcess: 2 });
		expect(fake.requests).toHaveLength(0);
		expect(fake.order).not.toContain('prepare');
		expect(fake.history).toHaveLength(0);
	});

	it('skips a document that carries a pending HITL gate', async () => {
		const fake = createFakeDeps({
			gated: '<!-- MAESTRO:HITL reason="Approve it" -->\n- [ ] after\n',
			open: '- [ ] go\n',
		});

		const events = await collect(
			runPlaybook(
				session(),
				playbook({
					documents: [
						{ filename: 'gated', resetOnCompletion: false },
						{ filename: 'open', resetOnCompletion: false },
					],
				}),
				'/p',
				{ skipSynopsis: true },
				fake.deps
			)
		);

		expect(events.find((e) => e.type === 'document_gated')).toMatchObject({
			document: 'gated',
			reason: 'Approve it',
		});
		expect(fake.requests.map((r) => r.document)).toEqual(['open']);
	});

	it('ends the run on a halt marker and writes a halted summary row', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });
		fake.onTurn = (request, f) => {
			f.docs.set(
				request.document ?? 'tasks',
				`${tickFirstTask(f.docs.get('tasks') ?? '')}\n<!-- maestro:halt: out of credit -->\n`
			);
			return { success: true, response: 'x' };
		};

		const events = await collect(
			runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps)
		);

		expect(events.find((e) => e.type === 'halt')).toMatchObject({ reason: 'out of credit' });
		expect(events.at(-1)).toMatchObject({ type: 'complete', halted: true, success: false });
		expect(fake.history.at(-1)?.summary).toBe('Auto Run halted: out of credit');
		expect(fake.requests).toHaveLength(1);
	});

	it('gives up on a document that moves no checkbox, then goes on to the next one', async () => {
		const fake = createFakeDeps({ stuck: '- [ ] never\n', fine: '- [ ] easy\n' });
		fake.onTurn = (request, f) => {
			if (request.document === 'fine') {
				f.docs.set('fine', tickFirstTask(f.docs.get('fine') ?? ''));
			}
			return { success: true, response: 'x' };
		};

		const events = await collect(
			runPlaybook(
				session(),
				playbook({
					documents: [
						{ filename: 'stuck', resetOnCompletion: false },
						{ filename: 'fine', resetOnCompletion: false },
					],
				}),
				'/p',
				{ skipSynopsis: true },
				fake.deps
			)
		);

		expect(events.find((e) => e.type === 'document_stalled')).toMatchObject({
			document: 'stuck',
			hasNextDocument: true,
		});
		expect(fake.requests.filter((r) => r.document === 'stuck')).toHaveLength(3);
		expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
	});

	it('records an interrupted turn as a stop, not a failure', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });
		fake.onTurn = () => ({ success: false, outcome: 'interrupted', error: 'stopped' });

		const events = await collect(runPlaybook(session(), playbook(), '/p', {}, fake.deps));

		expect(events.find((e) => e.type === 'task_complete')).toMatchObject({
			summary: '[tasks] Task interrupted',
		});
		expect(events.at(-1)).toMatchObject({ type: 'complete', stopped: true, success: false });
		expect(fake.history.at(-1)?.summary).toBe('Auto Run stopped: by operator');
		expect(fake.requests).toHaveLength(1);
	});

	it('stops after the task in flight when the signal aborts', async () => {
		const controller = new AbortController();
		const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n- [ ] three\n' });
		const base = fake.onTurn;
		fake.onTurn = (request, f) => {
			controller.abort();
			return base(request, f);
		};

		const events = await collect(
			runPlaybook(
				session(),
				playbook(),
				'/p',
				{ signal: controller.signal, skipSynopsis: true },
				fake.deps
			)
		);

		expect(events.at(-1)).toMatchObject({ type: 'complete', stopped: true });
		expect(fake.requests).toHaveLength(1);
	});

	it('asks for a synopsis at the cheapest settings and parses it into the row', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n' });
		fake.onTurn = (request, f) => {
			if (request.purpose === 'synopsis') {
				return { success: true, response: 'Added the thing\n\nIt now works.' };
			}
			f.docs.set('tasks', tickFirstTask(f.docs.get('tasks') ?? ''));
			return { success: true, response: 'ok', agentSessionId: 'prov-1' };
		};

		const events = await collect(
			runPlaybook(
				session({ customModel: 'opus', customEffort: 'high' }),
				playbook(),
				'/p',
				{},
				fake.deps
			)
		);

		const synopsis = fake.requests.find((r) => r.purpose === 'synopsis');
		expect(synopsis).toMatchObject({
			resumeSessionId: 'prov-1',
			prompt: 'prompt:autorun-synopsis',
		});
		expect(events.find((e) => e.type === 'task_complete')).toMatchObject({
			summary: 'Added the thing',
		});
	});

	it('loops until no document has work left and writes the loop rows', async () => {
		const fake = createFakeDeps({ first: '- [ ] one\n', second: '- [ ] two\n' });
		fake.onTurn = (request, f) => {
			const name = request.document ?? 'first';
			f.docs.set(name, tickFirstTask(f.docs.get(name) ?? ''));
			// Working the second document hands the first one more work, once.
			if (name === 'second' && !f.docs.get('first')?.includes('again')) {
				f.docs.set('first', `${f.docs.get('first')}- [ ] again\n`);
			}
			return { success: true, response: 'x' };
		};

		const events = await collect(
			runPlaybook(
				session(),
				playbook({
					loopEnabled: true,
					maxLoops: 5,
					documents: [
						{ filename: 'first', resetOnCompletion: false },
						{ filename: 'second', resetOnCompletion: false },
					],
				}),
				'/p',
				{ skipSynopsis: true },
				fake.deps
			)
		);

		expect(types(events)).toContain('loop_complete');
		expect(fake.history.some((e) => e.summary === 'Loop 1 completed: 2 tasks accomplished')).toBe(
			true
		);
		expect(fake.history.some((e) => e.summary?.startsWith('Loop 2 (final) completed'))).toBe(true);
		expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
	});

	it('resets a reset-on-completion document through the documents port', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n' });

		await collect(
			runPlaybook(
				session(),
				playbook({ documents: [{ filename: 'tasks', resetOnCompletion: true }] }),
				'/p',
				{ skipSynopsis: true },
				fake.deps
			)
		);

		expect(fake.docs.get('tasks')).toBe('- [ ] one\n');
	});

	it('writes no History when asked not to', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n' });

		await collect(
			runPlaybook(
				session(),
				playbook(),
				'/p',
				{ writeHistory: false, skipSynopsis: true },
				fake.deps
			)
		);

		expect(fake.history).toHaveLength(0);
	});

	it('falls back to its own counters when History cannot be read', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n' });
		fake.deps.history.readAll = () => {
			throw new Error('disk gone');
		};

		const events = await collect(
			runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps)
		);

		expect(events.at(-1)).toMatchObject({ type: 'complete', totalTasksCompleted: 1 });
	});

	it('expands template variables in the document and writes the expansion back', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] work in {{AUTORUN_FOLDER}}\n' });

		await collect(runPlaybook(session(), playbook(), '/folder', { skipSynopsis: true }, fake.deps));

		const request = fake.requests[0];
		expect(request.prompt).toContain('# Current Document: /folder/tasks.md');
		expect(request.prompt).toContain('work in /folder');
	});

	it('hands the task turn the document hint settings and run overrides', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n' });

		await collect(
			runPlaybook(
				session(),
				playbook(),
				'/p',
				{ skipSynopsis: true, model: 'sonnet', effort: 'low' },
				fake.deps
			)
		);

		expect(fake.requests[0]).toMatchObject({ purpose: 'task', model: 'sonnet', effort: 'low' });
	});
});
