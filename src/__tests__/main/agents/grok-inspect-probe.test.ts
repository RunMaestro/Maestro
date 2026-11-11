/**
 * Pins the grok inspect probe against a fake `grok` executable.
 *
 * The fake is a real child process that answers `inspect --json` from a
 * recorded grok 1.0.70 report (sanitized: no path under the user's home, see
 * `fixtures/grok/inspect-1.0.70/`) and records the argv, cwd and GROK_*
 * environment it was started with. The probe's runner is the injected one
 * (`runProviderProbe` refuses every Grok exec probe, which is pinned too), so
 * the same parser and read-only decision run over real process output, and
 * the environment reaching the process is the one the launch plan builds.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileNoThrow } from '../../../main/utils/execFile';
import {
	probeGrokInspect,
	parseGrokInspectReport,
	grokReadOnlyIsolationProblem,
	type GrokInspectRunner,
	type GrokInspectProbeResult,
} from '../../../main/agents/grok-inspect-probe';
import {
	buildAgentLaunchPlan,
	type AgentLaunchInput,
} from '../../../shared/maestro-lib/launch/launch-plan';
import {
	getAgentDefinition,
	GROK_COMPAT_ISOLATION_ENV_VARS,
} from '../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';

const FIXTURE_DIR = path.join(__dirname, '../../fixtures/grok/inspect-1.0.70');
const INHERITED = path.join(FIXTURE_DIR, 'inherited.json');
const ISOLATED = path.join(FIXTURE_DIR, 'isolated.json');
const INHERITED_FILE = '/fixture/home/.claude/settings.local.json';

const FAKE_GROK = `import fs from 'node:fs';
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GROK_')));
fs.writeFileSync(process.env.FAKE_GROK_RECORD, JSON.stringify({ args, cwd: process.cwd(), env }));
if (process.env.FAKE_GROK_EXIT) process.exit(Number(process.env.FAKE_GROK_EXIT));
if (args[0] === 'inspect' && args[1] === '--json' && args.length === 2) {
	process.stdout.write(fs.readFileSync(process.env.FAKE_GROK_INSPECT_FIXTURE, 'utf8'));
	process.exit(0);
}
process.stderr.write('fake grok: unexpected arguments');
process.exit(64);
`;

interface FakeRecord {
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

let tmp: string;
let fakeGrok: string;
let project: string;
let record: string;

/** Runs the fake executable through Node so the case holds on every OS. */
const fakeRunner: GrokInspectRunner = (request) =>
	execFileNoThrow(process.execPath, [request.command, ...request.args], request.cwd, {
		env: request.env,
		timeout: request.limits?.timeoutMs,
	});

function readRecord(): FakeRecord {
	return JSON.parse(fs.readFileSync(record, 'utf8')) as FakeRecord;
}

function writeVariant(name: string, edit: (report: Record<string, any>) => void): string {
	const report = JSON.parse(fs.readFileSync(ISOLATED, 'utf8')) as Record<string, any>;
	edit(report);
	const file = path.join(tmp, `${name}.json`);
	fs.writeFileSync(file, JSON.stringify(report));
	return file;
}

function grokPlanEnv(overrides: Partial<AgentLaunchInput> = {}): NodeJS.ProcessEnv {
	const result = buildAgentLaunchPlan({
		surface: 'cli',
		agent: { ...getAgentDefinition('grok'), capabilities: getAgentCapabilities('grok') },
		command: fakeGrok,
		args: [],
		cwd: project,
		prompt: 'inspect',
		isWindowsHost: false,
		...overrides,
	});
	if (!result.ok) throw new Error(result.error);
	if (!result.plan.env) throw new Error('expected a local launch environment');
	return result.plan.env;
}

async function probe(fixture: string, env: NodeJS.ProcessEnv = { ...process.env }) {
	return probeGrokInspect(
		{
			command: fakeGrok,
			cwd: project,
			env: { ...env, FAKE_GROK_RECORD: record, FAKE_GROK_INSPECT_FIXTURE: fixture },
		},
		fakeRunner
	);
}

function observed(result: GrokInspectProbeResult) {
	if (result.status !== 'observed') throw new Error(`expected observed, got ${result.message}`);
	return result;
}

beforeAll(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-inspect-probe-')));
	fakeGrok = path.join(tmp, 'grok.mjs');
	fs.writeFileSync(fakeGrok, FAKE_GROK);
	project = path.join(tmp, 'project');
	fs.mkdirSync(project);
});

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	record = path.join(tmp, `record-${Math.random().toString(36).slice(2)}.json`);
});

describe('grok inspect probe over a fake grok process', () => {
	it('runs exactly `inspect --json` in the launch cwd and parses trust, sources and compat cells', async () => {
		const result = observed(await probe(INHERITED));
		expect(readRecord()).toMatchObject({ args: ['inspect', '--json'], cwd: project });
		expect(result.report).toMatchObject({
			grokVersion: '1.0.70',
			projectRoot: null,
			projectTrusted: false,
			permissionSources: [`${INHERITED_FILE} (settings)`],
			permissionRulesLoaded: 3,
			mcpServers: [],
		});
		expect(result.report.compatCells).toHaveLength(13);
		expect(result.report.compatCells.every((c) => c.enabled && c.source === 'default')).toBe(true);
		expect(result.enabledCompatCells).toContain('claude.skills');
		expect(result.enabledCompatCells).toContain('cursor.rules');
		expect(result.inheritedPermissionSources).toEqual([INHERITED_FILE]);
	});

	it('reads the isolated report: vendor cells off by env, Claude hooks disabled, sessions cells left on', async () => {
		const result = observed(await probe(ISOLATED));
		expect(result.report.projectTrusted).toBe(true);
		const off = result.report.compatCells.filter((c) => !c.enabled);
		expect(off).toHaveLength(10);
		expect(off.every((c) => c.source === 'env' && c.surface !== 'sessions')).toBe(true);
		expect(result.enabledCompatCells).toEqual([
			'cursor.sessions',
			'claude.sessions',
			'codex.sessions',
		]);
		expect(result.report.hooks.length).toBeGreaterThan(0);
		expect(result.report.hooks.every((h) => h.vendor === 'claude' && h.disabled)).toBe(true);
		expect(result.activeForeignHooks).toEqual([]);
	});

	it('refuses read-only by name while a settings.local.json source loads, even with every cell off', async () => {
		for (const fixture of [INHERITED, ISOLATED]) {
			const result = observed(await probe(fixture));
			expect(result.readOnlyProblem).toContain('Grok read-only refused');
			expect(result.readOnlyProblem).toContain(INHERITED_FILE);
		}
	});

	it('lets read-only proceed when the sources list is empty', async () => {
		const empty = writeVariant('no-sources', (r) => {
			r.permissions.sources = [];
			r.permissions.loaded = 0;
		});
		const result = observed(await probe(empty));
		expect(result.inheritedPermissionSources).toEqual([]);
		expect(result.readOnlyProblem).toBeNull();
	});

	it("does not count grok's own (config) layers as inherited", async () => {
		const own = writeVariant('own-config', (r) => {
			r.permissions.sources = ['/fixture/grok-home/config.toml (config)'];
		});
		const result = observed(await probe(own));
		expect(result.readOnlyProblem).toBeNull();
	});

	it('the launch environment carries the isolation control into the grok process', async () => {
		expect(Object.keys(GROK_COMPAT_ISOLATION_ENV_VARS)).toHaveLength(10);
		expect(GROK_COMPAT_ISOLATION_ENV_VARS.GROK_CLAUDE_SKILLS_ENABLED).toBe('false');
		await probe(ISOLATED, grokPlanEnv());
		const { env } = readRecord();
		for (const [key, value] of Object.entries(GROK_COMPAT_ISOLATION_ENV_VARS)) {
			expect(env[key], key).toBe(value);
		}
	});

	it('a per-agent opt-in reopens one cell on a standard turn, never on a read-only turn', async () => {
		const optIn = { GROK_CLAUDE_SKILLS_ENABLED: 'true' };
		await probe(ISOLATED, grokPlanEnv({ sessionCustomEnvVars: optIn }));
		expect(readRecord().env.GROK_CLAUDE_SKILLS_ENABLED).toBe('true');
		expect(readRecord().env.GROK_CLAUDE_HOOKS_ENABLED).toBe('false');

		record = path.join(tmp, 'record-read-only.json');
		await probe(ISOLATED, grokPlanEnv({ sessionCustomEnvVars: optIn, readOnlyMode: true }));
		const { env } = readRecord();
		for (const [key, value] of Object.entries(GROK_COMPAT_ISOLATION_ENV_VARS)) {
			expect(env[key], key).toBe(value);
		}
	});

	it('a failed or unreadable report is unavailable, never an isolated-looking result', async () => {
		const failed = await probeGrokInspect(
			{
				command: fakeGrok,
				cwd: project,
				env: { ...process.env, FAKE_GROK_RECORD: record, FAKE_GROK_EXIT: '3' },
			},
			fakeRunner
		);
		expect(failed).toMatchObject({ status: 'unavailable', reason: 'probe-failed' });

		const garbage = path.join(tmp, 'garbage.txt');
		fs.writeFileSync(garbage, 'not json\n');
		expect(await probe(garbage)).toMatchObject({ status: 'unavailable', reason: 'invalid-report' });

		const renamed = writeVariant('renamed', (r) => {
			delete r.externalCompat;
		});
		expect(await probe(renamed)).toMatchObject({ status: 'unavailable', reason: 'invalid-report' });
	});

	it('the default runner refuses the Grok probe before starting anything', async () => {
		const result = await probeGrokInspect({
			command: fakeGrok,
			cwd: project,
			env: { ...process.env, FAKE_GROK_RECORD: record, FAKE_GROK_INSPECT_FIXTURE: INHERITED },
		});
		expect(result).toMatchObject({ status: 'unavailable', reason: 'probe-refused' });
		expect(fs.existsSync(record)).toBe(false);
	});

	it('the pure decision agrees with the process path on the recorded reports', () => {
		const inherited = parseGrokInspectReport(fs.readFileSync(INHERITED, 'utf8'));
		expect(inherited).not.toBeNull();
		expect(grokReadOnlyIsolationProblem(inherited!)).toContain(INHERITED_FILE);
	});

	it('no fixture contains a real path under the user home', () => {
		const home = os.homedir();
		for (const name of fs.readdirSync(FIXTURE_DIR)) {
			const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
			expect(text.includes(home), name).toBe(false);
			expect(text, name).not.toMatch(/\/Users\/|\/private\/var\/folders|C:\\\\Users/);
		}
	});
});
