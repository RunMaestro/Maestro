/**
 * A Cue run delivers an agent's declared secret (`requiredSecrets`) to that
 * agent's process and leaks it nowhere else: not to the run log, not to the
 * main-process logger, not to any field of the spawn spec other than the
 * environment, and not to an agent that did not declare it.
 *
 * The secret arrives as a systemd credential (`$CREDENTIALS_DIRECTORY/<NAME>`)
 * holding a sentinel value; every captured channel is searched for it.
 * Unlike `cue-spawn-builder.test.ts`, `fs` is real here so the file is read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CueExecutionConfig } from '../../../main/cue/cue-executor';
import type { SessionInfo } from '../../../shared/types';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import { formatJsonLogLine } from '../../../shared/jsonLogLine';

vi.mock('../../../main/agents', () => ({
	getAgentDefinition: (id: string) => getAgentDefinition(id as never),
	getAgentCapabilities: (id: string) => getAgentCapabilities(id as never),
}));
vi.mock('../../../main/agents/claude-usage-startup', () => ({
	getMaestroPBinPath: () => '/bundled/maestro-p.js',
	isMaestroPBinaryPath: () => false,
}));
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn(async () => true),
}));
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	getSnapshot: () => null,
	resolveConfigDirKey: () => 'test-config-key',
}));

import { buildSpawnSpec } from '../../../main/cue/cue-spawn-builder';

const SENTINEL = 'sentinel-c0ffee-91d2-do-not-leak';

let tmp: string;
let savedEnv: NodeJS.ProcessEnv;
let logLines: string[];
let written: string[];

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-spawn-secrets-')));
	const credentials = path.join(tmp, 'credentials');
	fs.mkdirSync(credentials);
	fs.writeFileSync(path.join(credentials, 'DEPLOY_TOKEN'), `${SENTINEL}\n`);
	savedEnv = { ...process.env };
	process.env.CREDENTIALS_DIRECTORY = credentials;
	delete process.env.DEPLOY_TOKEN;
	logLines = [];
	written = [];
	// Everything the process prints, through any logger.
	for (const stream of [process.stdout, process.stderr]) {
		vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
	}
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			written.push(args.map(String).join(' '));
		});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	process.env = savedEnv;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function config(session: Partial<SessionInfo>, requiredSecrets?: string[]): CueExecutionConfig {
	return {
		runId: 'run-1',
		session: {
			id: 'agent-1',
			name: 'Deployer',
			toolType: 'codex',
			cwd: tmp,
			projectRoot: tmp,
			...session,
		} as SessionInfo,
		subscription: { name: 'deploy', event: 'time.heartbeat', enabled: true, prompt: 'deploy' },
		event: {
			id: 'evt-1',
			type: 'time.heartbeat',
			timestamp: new Date().toISOString(),
			triggerName: 'deploy',
			payload: {},
		},
		promptPath: 'deploy',
		toolType: 'codex',
		projectRoot: tmp,
		templateContext: {} as CueExecutionConfig['templateContext'],
		timeoutMs: 60_000,
		customPath: '/usr/local/bin/codex',
		requiredSecrets,
		isServerMode: true,
		onLog: (level, message) => {
			logLines.push(formatJsonLogLine({ level, message }), `[Cue] ${message}`);
		},
	};
}

describe('Cue run with a declared secret', () => {
	it('puts the secret in the agent environment and nowhere else', async () => {
		const result = await buildSpawnSpec(config({}, ['DEPLOY_TOKEN']), 'deploy now');
		if (!result.ok) throw new Error(result.message);
		const { env, ...rest } = result.spec;

		expect(env.DEPLOY_TOKEN).toBe(SENTINEL);
		expect(JSON.stringify(rest)).not.toContain(SENTINEL);
		expect(logLines.join('\n')).not.toContain(SENTINEL);
		expect(written.join('\n')).not.toContain(SENTINEL);
		expect(process.env.DEPLOY_TOKEN).toBeUndefined();
		// The engine's own credentials pointer is not inherited by the agent.
		expect(env.CREDENTIALS_DIRECTORY).toBeUndefined();
	});

	it('does not give the secret to an agent that did not declare it', async () => {
		const result = await buildSpawnSpec(config({ id: 'agent-2', name: 'Reviewer' }), 'review');
		if (!result.ok) throw new Error(result.message);
		expect(result.spec.env.DEPLOY_TOKEN).toBeUndefined();
		expect(JSON.stringify(result.spec)).not.toContain(SENTINEL);
	});

	it('warns by name when a declared secret is missing, and still starts the run', async () => {
		const result = await buildSpawnSpec(config({}, ['DEPLOY_TOKEN', 'NPM_TOKEN']), 'deploy');
		expect(result.ok).toBe(true);
		const warning = logLines.find((line) => line.includes('NPM_TOKEN'));
		expect(warning).toContain('Agent \\"Deployer\\" requires secrets it did not receive');
		expect(logLines.join('\n')).not.toContain(SENTINEL);
	});
});
