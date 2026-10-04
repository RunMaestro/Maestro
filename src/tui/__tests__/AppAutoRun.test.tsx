import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord } from '../../shared/maestro-lib';
import { App } from '../App';
import type { EditorResult } from '../autorun/editor';
import { createFakeClient } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/** The App waits this long after drawing its "editing" frame before it starts the editor. */
const EDITOR_WAIT = 220;
const ENTER = '\r';
const ESC = '\u001B';
const CTRL_K = '\u000b';

describe('Auto Run documents in the TUI (AR-1, AR-2)', () => {
	let dir: string;
	let project: string;
	let folder: string;

	const agents = (extra: Partial<AgentRecord> = {}): AgentRecord[] => [
		{
			id: 'a1',
			name: 'Alpha',
			toolType: 'codex',
			state: 'idle',
			cwd: project,
			aiTabs: [{ id: 't1', name: 'one' }],
			...extra,
		},
	];

	const mount = async (
		options: { agents?: AgentRecord[]; edit?: (file: string) => Promise<EditorResult> } = {}
	) => {
		const fake = createFakeClient({ agents: options.agents ?? agents() });
		const edited: string[] = [];
		const instance = render(
			<App
				paths={{
					userDataDir: dir,
					sessionsFile: path.join(dir, 'maestro-sessions.json'),
					groupsFile: path.join(dir, 'maestro-groups.json'),
					settingsFile: path.join(dir, 'maestro-settings.json'),
					agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
					historyDir: path.join(dir, 'history'),
				}}
				client={fake.client}
				editFile={async (file) => {
					edited.push(file);
					return options.edit ? options.edit(file) : { ok: true };
				}}
			/>
		);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 140, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 36, configurable: true });
		stdout.emit('resize');
		await tick();
		const press = async (...keys: string[]) => {
			for (const key of keys) {
				instance.stdin.write(key);
				await tick();
			}
		};
		return { ...instance, press, edited, frame: () => instance.lastFrame() ?? '' };
	};

	const write = (name: string, content: string) => {
		const file = path.join(folder, `${name}.md`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return file;
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-autorun-'));
		project = path.join(dir, 'project');
		folder = path.join(project, '.maestro', 'playbooks');
		fs.mkdirSync(folder, { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('lists the folder with done and total counts, and the problems in the highlighted document', async () => {
		write('alpha', '- [x] one\n- [ ] two\n- [ ] three\n');
		write('beta', '- [ ] good\n[ ] no dash\n');
		const { press, frame, unmount } = await mount();
		await press('j', 'a');
		expect(frame()).toContain('Auto Run: Alpha');
		expect(frame()).toContain(folder);
		expect(frame()).toContain('Last run: never');
		expect(frame()).toContain('1/3');
		expect(frame()).toContain('0/1');
		expect(frame()).toContain('alpha: no problems');
		await press('j');
		expect(frame()).toContain('beta: 1 to look at');
		expect(frame()).toContain('line 2:');
		unmount();
	});

	it('shows when the agent last ran Auto Run, from its history', async () => {
		write('alpha', '- [ ] one\n');
		fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'history', 'a1.jsonl'),
			`${JSON.stringify({ id: 'h1', type: 'AUTO', timestamp: Date.now() - 1000, summary: 's', projectPath: project, success: true })}\n`
		);
		const { press, frame, unmount } = await mount();
		await press('j', 'a');
		expect(frame()).toContain('Last run: finished');
		unmount();
	});

	it('n names a document, writes the template, opens it in the editor, then lists what is wrong', async () => {
		const { press, frame, edited, unmount } = await mount({
			edit: async (file) => {
				// The person adds a mistake while the editor is open.
				fs.appendFileSync(file, '1. [ ] numbered\n');
				return { ok: true };
			},
		});
		await press('j', 'a', 'n');
		expect(frame()).toContain('New document');
		await press(...'phase-1/setup'.split(''));
		expect(frame()).toContain('phase-1/setup');
		await press(ENTER);
		await tick(EDITOR_WAIT);
		const file = path.join(folder, 'phase-1', 'setup.md');
		expect(edited).toEqual([file]);
		expect(fs.readFileSync(file, 'utf8')).toContain('- [ ] First task');
		expect(frame()).toContain('phase-1/setup');
		expect(frame()).toContain('Edited phase-1/setup: 1 warning.');
		expect(frame()).toContain('line');
		expect(frame()).toContain('numbered checkbox');
		unmount();
	});

	it('draws one fixed line and ignores keys while the editor is open', async () => {
		write('alpha', '- [ ] one\n');
		let finish: (result: EditorResult) => void = () => undefined;
		const { press, frame, edited, unmount } = await mount({
			edit: () => new Promise<EditorResult>((resolve) => (finish = resolve)),
		});
		await press('j', 'a', ENTER);
		await tick(EDITOR_WAIT);
		expect(edited).toHaveLength(1);
		expect(frame()).toContain('Editing');
		expect(frame()).not.toContain('Auto Run: Alpha');
		// Keys go to the editor, not to the TUI: q would quit it.
		await press('q', 'j');
		expect(frame()).toContain('Editing');
		finish({ ok: true });
		await tick();
		expect(frame()).toContain('Auto Run: Alpha');
		expect(frame()).toContain('Edited alpha: no problems.');
		unmount();
	});

	it('says why the editor did not run, and keeps the list', async () => {
		write('alpha', '- [ ] one\n');
		const { press, frame, unmount } = await mount({
			edit: async () => ({ ok: false, message: 'The editor (vi) exited with code 1.' }),
		});
		await press('j', 'a', ENTER);
		await tick(EDITOR_WAIT);
		expect(frame()).toContain('Auto Run: Alpha');
		expect(frame()).toContain('The editor (vi) exited with code 1.');
		unmount();
	});

	it('Esc in the name box keeps the list; a second Esc closes it', async () => {
		write('alpha', '- [ ] one\n');
		const { press, frame, edited, unmount } = await mount();
		await press('j', 'a', 'n', 'x', ESC);
		await tick();
		expect(frame()).toContain('Auto Run: Alpha');
		expect(frame()).not.toContain('New document');
		expect(fs.existsSync(path.join(folder, 'x.md'))).toBe(false);
		await press(ESC);
		await tick();
		expect(frame()).not.toContain('Auto Run: Alpha');
		expect(edited).toEqual([]);
		unmount();
	});

	it('keeps the name box open with the reason when the name cannot be used', async () => {
		write('alpha', 'mine\n');
		const { press, frame, edited, unmount } = await mount();
		await press('j', 'a', 'n', ...'alpha'.split(''), ENTER);
		expect(frame()).toContain('alpha.md already exists.');
		expect(frame()).toContain('New document');
		expect(fs.readFileSync(path.join(folder, 'alpha.md'), 'utf8')).toBe('mine\n');
		await press(...'/../x'.split(''));
		expect(edited).toEqual([]);
		unmount();
	});

	it('flags a halt marker standing alone as an error', async () => {
		write('alpha', '- [ ] one\n<!-- maestro:halt: broken -->\n');
		const { press, frame, unmount } = await mount();
		await press('j', 'a');
		expect(frame()).toContain('alpha: 1 to look at');
		expect(frame()).toContain('line 2: A halt marker stands alone (broken)');
		unmount();
	});

	it('r reloads documents an agent added while the view was open', async () => {
		write('alpha', '- [ ] one\n');
		const { press, frame, unmount } = await mount();
		await press('j', 'a');
		expect(frame()).not.toContain('gamma');
		write('gamma', '- [x] done\n');
		await press('r');
		expect(frame()).toContain('gamma');
		unmount();
	});

	it('says the folder does not exist yet, and a new document creates it', async () => {
		fs.rmSync(folder, { recursive: true });
		const { press, frame, unmount } = await mount();
		await press('j', 'a');
		expect(frame()).toContain('The folder does not exist yet');
		await press('n', ...'first'.split(''), ENTER);
		await tick(EDITOR_WAIT);
		expect(fs.existsSync(path.join(folder, 'first.md'))).toBe(true);
		unmount();
	});

	it('lists an agent that runs on an SSH remote as local-only and creates nothing', async () => {
		const { press, frame, edited, unmount } = await mount({
			agents: agents({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } }),
		});
		await press('j', 'a');
		expect(frame()).toContain('runs on an SSH remote');
		await press('n');
		expect(frame()).not.toContain('New document');
		expect(edited).toEqual([]);
		unmount();
	});

	it('is reachable from the command palette, with the name box up for a new document', async () => {
		const { press, frame, unmount } = await mount();
		await press('j', CTRL_K, ...'new auto run'.split(''));
		expect(frame()).toContain('New Auto Run document');
		await press(ENTER);
		expect(frame()).toContain('Auto Run: Alpha');
		expect(frame()).toContain('New document');
		unmount();
	});
});
