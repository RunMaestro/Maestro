import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_PR_URL } from '../../../playbookParams';
import { parsePlaybookRunReportJson } from '../../../playbookReportAuthoring';
import { renderPlaybookReportMarkdown, type PlaybookRunReport } from '../../../playbookRunReport';
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
			'report',
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

	describe('playbook parameters', () => {
		const PARAM_PROMPT = [
			'<!-- CONFIGURE: How many items to process -->',
			'**MAX_ITEMS:** `25`',
			'',
			'<!-- CONFIGURE: Folder to work in -->',
			'**TARGET_DIR:** `{{AUTORUN_FOLDER}}`',
			'',
			'<!-- CONFIGURE: Pull request to review -->',
			`**PR_URL:** \`${PLACEHOLDER_PR_URL}\``,
			'',
			'Process [MAX_ITEMS] items under [TARGET_DIR].',
		].join('\n');

		it('substitutes [NAME] in memory while the document on disk keeps the token', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] Process [MAX_ITEMS] items for [PR_URL]\n' });
			let diskAtDispatch = '';
			fake.onTurn = (_request, f) => {
				diskAtDispatch = f.docs.get('tasks') ?? '';
				f.docs.set('tasks', tickFirstTask(diskAtDispatch));
				return { success: true, response: 'x' };
			};

			const events = await collect(
				runPlaybook(
					session(),
					playbook({
						prompt: PARAM_PROMPT,
						parameterValues: { MAX_ITEMS: '7', PR_URL: 'https://github.com/o/r/pull/1' },
					}),
					'/folder',
					{ skipSynopsis: true },
					fake.deps
				)
			);

			const prompt = fake.requests[0].prompt;
			expect(prompt).toContain('Process 7 items under /folder.');
			expect(prompt).toContain('- [ ] Process 7 items for https://github.com/o/r/pull/1');
			expect(prompt).toContain('## Resolved Configuration');
			expect(prompt).toContain('| `TARGET_DIR` | /folder |');
			expect(prompt).not.toContain('[MAX_ITEMS]');
			expect(diskAtDispatch).toBe('- [ ] Process [MAX_ITEMS] items for [PR_URL]\n');
			expect(fake.docs.get('tasks')).toBe('- [x] Process [MAX_ITEMS] items for [PR_URL]\n');
			expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
		});

		it('halts before any spawn when a [NAME] token survives substitution', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] Review [PR_URL]\n- [ ] two\n' });

			const events = await collect(
				runPlaybook(
					session(),
					playbook({ prompt: PARAM_PROMPT }),
					'/p',
					{ skipSynopsis: true },
					fake.deps
				)
			);

			expect(fake.requests).toHaveLength(0);
			expect(events.find((e) => e.type === 'error')).toMatchObject({
				code: 'PARAMETER_SUBSTITUTION',
				document: 'tasks',
				parameters: ['PR_URL'],
			});
			expect(events.at(-1)).toMatchObject({ type: 'complete', halted: true, success: false });
			expect(fake.history.at(-1)?.summary).toContain('Auto Run halted');
			expect(fake.activity.at(-1)).toBe('end:agent-1');
			expect(fake.docs.get('tasks')).toBe('- [ ] Review [PR_URL]\n- [ ] two\n');
		});

		it('leaves a playbook with no parameter form untouched', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] keep [LITERAL] brackets\n' });

			await collect(runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps));

			expect(fake.requests[0].prompt).toContain('- [ ] keep [LITERAL] brackets');
			expect(fake.requests[0].prompt).not.toContain('## Resolved Configuration');
		});
	});

	describe('disk evidence (run report tier B)', () => {
		const snapshot = {
			source: 'mtime' as const,
			takenAt: 1,
			files: { 'a.txt': 1 },
			truncated: false,
		};
		const evidence = {
			source: 'mtime' as const,
			changedFiles: ['a.txt'],
			createdFiles: ['b.txt'],
			deletedFiles: [],
		};

		const withEvidencePorts = (fake: ReturnType<typeof createFakeDeps>) => {
			const calls: string[] = [];
			fake.deps.environment.evidenceStart = (cwd) => {
				calls.push(`start:${cwd}`);
				return snapshot;
			};
			fake.deps.environment.evidenceEnd = (cwd, start) => {
				calls.push(`end:${cwd}:${start === snapshot}`);
				return evidence;
			};
			return calls;
		};

		it('snapshots the agent folder before the first task and emits the diff just before complete', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] one\n' });
			const calls = withEvidencePorts(fake);
			const base = fake.onTurn;
			fake.onTurn = (request, f) => {
				calls.push('turn');
				return base(request, f);
			};

			const events = await collect(
				runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps)
			);

			expect(calls).toEqual(['start:/work/project', 'turn', 'end:/work/project:true']);
			expect(types(events).slice(-3)).toEqual(['evidence', 'report', 'complete']);
			expect(events.at(-3)).toMatchObject({ type: 'evidence', evidence });
		});

		it('emits evidence on a halted run and on a stopped run too', async () => {
			const halted = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });
			withEvidencePorts(halted);
			halted.onTurn = (_request, f) => {
				f.docs.set(
					'tasks',
					`${tickFirstTask(f.docs.get('tasks') ?? '')}\n<!-- maestro:halt: stop -->\n`
				);
				return { success: true, response: 'x' };
			};
			const haltEvents = await collect(
				runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, halted.deps)
			);
			expect(types(haltEvents).slice(-3)).toEqual(['evidence', 'report', 'complete']);
			expect(haltEvents.at(-1)).toMatchObject({ halted: true });

			const controller = new AbortController();
			const stopped = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });
			withEvidencePorts(stopped);
			const base = stopped.onTurn;
			stopped.onTurn = (request, f) => {
				controller.abort();
				return base(request, f);
			};
			const stopEvents = await collect(
				runPlaybook(
					session(),
					playbook(),
					'/p',
					{ signal: controller.signal, skipSynopsis: true },
					stopped.deps
				)
			);
			expect(types(stopEvents).slice(-3)).toEqual(['evidence', 'report', 'complete']);
			expect(stopEvents.at(-1)).toMatchObject({ stopped: true });
		});

		it('never snapshots a dry run', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] one\n' });
			const calls = withEvidencePorts(fake);

			const events = await collect(
				runPlaybook(session(), playbook(), '/p', { dryRun: true }, fake.deps)
			);

			expect(calls).toEqual([]);
			expect(types(events)).not.toContain('evidence');
		});

		it('skips the end diff when the start had nothing to compare', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] one\n' });
			const calls = withEvidencePorts(fake);
			fake.deps.environment.evidenceStart = () => null;

			const events = await collect(
				runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps)
			);

			expect(calls).toEqual([]);
			expect(types(events)).not.toContain('evidence');
			expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
		});

		it('turns a throwing evidence port into a warning, not a failed run', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] one\n' });
			withEvidencePorts(fake);
			fake.deps.environment.evidenceEnd = () => {
				throw new Error('git exploded');
			};
			const warnings: string[] = [];
			fake.deps.log.warn = (message) => {
				warnings.push(message);
			};

			const events = await collect(
				runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps)
			);

			expect(types(events)).not.toContain('evidence');
			expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
			expect(warnings).toContain('Failed to diff the folder for run evidence');
		});
	});

	describe('playbook run report', () => {
		const NARRATIVE = {
			version: 1,
			sections: [
				{ kind: 'accomplishments', title: 'Accomplishments', items: [{ text: 'Built it.' }] },
			],
		};
		const REPORT_ANSWER = [
			'```json',
			JSON.stringify(NARRATIVE),
			'```',
			'',
			'## How to use it',
			'',
			'Run `make demo`.',
			'',
			'## Next steps',
			'',
			'- Ship it',
			'- Tell people',
		].join('\n');

		/** A reports port that keeps what it was given. */
		const withReportsPort = (fake: ReturnType<typeof createFakeDeps>) => {
			const files = new Map<string, string>();
			fake.deps.reports = {
				write: (path, content) => {
					files.set(path, content);
				},
			};
			return files;
		};

		const reportEvent = (events: Array<{ type: string; [key: string]: unknown }>) =>
			events.find((e) => e.type === 'report') as
				| {
						type: 'report';
						timestamp: number;
						status: string;
						path?: string;
						jsonPath?: string;
						report: PlaybookRunReport;
				  }
				| undefined;

		it('saves the report beside the documents, emits it, and leads the summary row with it', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });
			const files = withReportsPort(fake);

			const events = await collect(
				runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps)
			);

			const event = reportEvent(events);
			expect(types(events).slice(-2)).toEqual(['report', 'complete']);
			expect(event?.status).toBe('completed');
			expect(event?.path).toMatch(/^\/p\/\.maestro-reports\/test-playbook-\d{8}-\d{6}\.md$/);
			expect(event?.jsonPath).toBe(event?.path?.replace(/\.md$/, '.json'));
			expect(event?.report).toMatchObject({
				playbookName: 'Test Playbook',
				playbookId: 'pb-1',
				status: 'completed',
				facts: { totalCompletedTasks: 2, documents: ['tasks'] },
				reportPath: event?.path,
				cwd: '/work/project',
			});
			expect(event?.report.problems).toBeUndefined();

			// The two files: the rendered markdown and the JSON, which carries reportPath.
			expect(files.get(event!.path!)).toBe(renderPlaybookReportMarkdown(event!.report));
			expect(parsePlaybookRunReportJson(files.get(event!.jsonPath!)!)).toEqual(event!.report);

			const summary = fake.history.at(-1);
			expect(summary?.summary).toBe('Auto Run completed: 2 tasks in 1 loop');
			expect(summary?.playbookReport).toEqual(event?.report);
			expect(summary?.fullResponse?.startsWith('# Test Playbook')).toBe(true);
			expect(summary?.fullResponse).toContain('**Auto Run Summary**');
		});

		it('still emits the report, without a path, when there is no port or the write fails', async () => {
			const noPort = createFakeDeps({ tasks: '- [ ] one\n' });
			const noPortEvent = reportEvent(
				await collect(runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, noPort.deps))
			);
			expect(noPortEvent?.status).toBe('completed');
			expect(noPortEvent?.path).toBeUndefined();
			expect(noPortEvent?.report.reportPath).toBeUndefined();

			const failing = createFakeDeps({ tasks: '- [ ] one\n' });
			failing.deps.reports = {
				write: () => {
					throw new Error('disk full');
				},
			};
			const warnings: string[] = [];
			failing.deps.log.warn = (message) => {
				warnings.push(message);
			};
			const events = await collect(
				runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, failing.deps)
			);
			expect(reportEvent(events)?.path).toBeUndefined();
			expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
			expect(warnings).toContain('Failed to save the playbook run report');
		});

		it('builds no report when the caller opts out (run-doc)', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] one\n' });
			const files = withReportsPort(fake);

			const events = await collect(
				runPlaybook(session(), playbook(), '/p', { skipSynopsis: true, report: false }, fake.deps)
			);

			expect(types(events)).not.toContain('report');
			expect(files.size).toBe(0);
			expect(fake.history.at(-1)?.playbookReport).toBeUndefined();
			expect(fake.history.at(-1)?.fullResponse?.startsWith('**Auto Run Summary**')).toBe(true);
		});

		it('reports a partial run with the failed task and the stalled document, located', async () => {
			const fake = createFakeDeps({ a: '- [ ] stuck\n', b: '- [ ] fine\n' });
			const base = fake.onTurn;
			fake.onTurn = (request, f) =>
				request.document === 'a' ? { success: false, error: 'boom' } : base(request, f);

			const events = await collect(
				runPlaybook(
					session(),
					playbook({
						documents: [
							{ filename: 'a', resetOnCompletion: false },
							{ filename: 'b', resetOnCompletion: false },
						],
					}),
					'/p',
					{ skipSynopsis: true },
					fake.deps
				)
			);

			const report = reportEvent(events)!.report;
			expect(report.status).toBe('partial');
			expect(report.problems).toEqual([
				{ kind: 'error', document: 'a', taskIndex: 0, message: 'boom' },
				expect.objectContaining({ kind: 'stall', document: 'a', taskIndex: 0 }),
			]);
			expect(renderPlaybookReportMarkdown(report)).toContain('## What did not happen');
		});

		it('reports a halted run as failed with the halt first', async () => {
			const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });
			fake.onTurn = (_request, f) => {
				f.docs.set(
					'tasks',
					`${tickFirstTask(f.docs.get('tasks') ?? '')}\n<!-- maestro:halt: out of credit -->\n`
				);
				return { success: true, response: 'x' };
			};

			const events = await collect(
				runPlaybook(session(), playbook(), '/p', { skipSynopsis: true }, fake.deps)
			);

			const report = reportEvent(events)!.report;
			expect(report.status).toBe('failed');
			expect(report.problems?.[0]).toEqual({
				kind: 'halt',
				document: 'tasks',
				taskIndex: 0,
				message: 'out of credit',
			});
		});

		it('reports a stopped run as stopped', async () => {
			const controller = new AbortController();
			const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });
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

			expect(reportEvent(events)?.status).toBe('stopped');
		});

		describe('the report document (tier C)', () => {
			const withReportDocument = () => {
				const fake = createFakeDeps({
					'pb/tasks': '- [ ] one\n',
					'pb/REPORT': 'Explain the result to {{AGENT_NAME}}.\n',
				});
				fake.deps.prompts.get = async (id) =>
					id === 'playbook-report-document'
						? 'NAME={{PLAYBOOK_NAME}}\nPATH={{REPORT_DOCUMENT_PATH}}\nDOC={{REPORT_DOCUMENT}}'
						: `prompt:${id}`;
				const record = playbook({
					documents: [
						{ filename: 'pb/tasks', resetOnCompletion: false },
						{ filename: 'pb/REPORT', resetOnCompletion: false },
					],
					report: 'REPORT',
				});
				return { fake, record };
			};

			it('runs it once after the other documents, never in the task loop', async () => {
				const { fake, record } = withReportDocument();
				const base = fake.onTurn;
				fake.onTurn = (request, f) =>
					request.purpose === 'report'
						? {
								success: true,
								response: REPORT_ANSWER,
								usageStats: {
									inputTokens: 100,
									outputTokens: 50,
									cacheReadInputTokens: 0,
									cacheCreationInputTokens: 0,
									totalCostUsd: 0.5,
									contextWindow: 0,
								},
							}
						: base(request, f);

				const events = await collect(
					runPlaybook(session(), record, '/p', { skipSynopsis: true }, fake.deps)
				);

				expect(fake.requests.map((r) => [r.purpose, r.document])).toEqual([
					['task', 'pb/tasks'],
					['report', 'pb/REPORT'],
				]);
				const prompt = fake.requests[1].prompt;
				expect(prompt).toContain('NAME=Test Playbook');
				expect(prompt).toContain('PATH=/p/pb/REPORT.md');
				// Template variables are expanded in memory, never written back.
				expect(prompt).toContain('DOC=Explain the result to Test Agent.');
				expect(fake.docs.get('pb/REPORT')).toBe('Explain the result to {{AGENT_NAME}}.\n');

				const report = reportEvent(events)!.report;
				expect(report.facts.documents).toEqual(['pb/tasks']);
				expect(report.narrative).toEqual(NARRATIVE);
				expect(report.howToUse).toBe('Run `make demo`.');
				expect(report.nextSteps).toEqual(['Ship it', 'Tell people']);
				// The report turn's spend counts toward the run.
				expect(events.at(-1)).toMatchObject({ type: 'complete', totalCost: 0.5 });
				expect(report.facts.totalInputTokens).toBe(100);
			});

			it('is skipped on a halted run, and a failed turn only costs the narrative', async () => {
				const halted = withReportDocument();
				halted.fake.onTurn = (_request, f) => {
					f.docs.set('pb/tasks', '- [x] one\n<!-- maestro:halt: no -->\n');
					return { success: true, response: 'x' };
				};
				await collect(
					runPlaybook(session(), halted.record, '/p', { skipSynopsis: true }, halted.fake.deps)
				);
				expect(halted.fake.requests.map((r) => r.purpose)).toEqual(['task']);

				const failing = withReportDocument();
				const base = failing.fake.onTurn;
				failing.fake.onTurn = (request, f) =>
					request.purpose === 'report' ? { success: false, error: 'nope' } : base(request, f);
				const events = await collect(
					runPlaybook(session(), failing.record, '/p', { skipSynopsis: true }, failing.fake.deps)
				);
				const report = reportEvent(events)!.report;
				expect(report.status).toBe('completed');
				expect(report.narrative).toBeUndefined();
				expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
			});
		});
	});
});
