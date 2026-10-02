/**
 * Bundle validator, run against real zips: a synthetic fixture that each test
 * breaks in exactly one way, plus a round trip through the exporter so the two
 * cannot drift on what a valid bundle is.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { zipSync, strToU8 } from 'fflate';
import { validateCueBundle } from '../../../../main/cue/bundle/cue-bundle-validator';
import { exportCueBundle } from '../../../../main/cue/bundle/cue-bundle-exporter';
import { FIXTURE_CUE_PATH, writeCueBundle } from '../../../helpers/cueBundleFixture';

let tmp: string;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundle-validate-')));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const RUNNING = '0.18.6-RC';

function codes(issues: Array<{ code: string }>): string[] {
	return issues.map((i) => i.code);
}

async function validate(options: Parameters<typeof writeCueBundle>[1] = {}, checkEnv?: boolean) {
	const file = writeCueBundle(path.join(tmp, 'b.zip'), options);
	return validateCueBundle(file, { runningVersion: RUNNING, checkEnv, env: {} });
}

describe('validateCueBundle', () => {
	it('passes a well-formed bundle', async () => {
		const result = await validate();
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.valid).toBe(true);
		expect(result.manifest?.name).toBe('Fixture');
	});

	it('passes a bundle the exporter just wrote', async () => {
		const dataDir = path.join(tmp, 'data');
		const root = path.join(tmp, 'projects', 'proj');
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(
			path.join(dataDir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{
						id: 'agent-a',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: root,
						projectRoot: root,
						customEnvVars: { API_KEY: 'x', REGION: 'eu' },
					},
				],
			})
		);
		fs.mkdirSync(path.join(root, '.maestro/prompts'), { recursive: true });
		fs.writeFileSync(path.join(root, '.maestro/prompts/tick.md'), 'Tick.');
		fs.writeFileSync(
			path.join(root, '.maestro/cue.yaml'),
			yaml.dump({
				subscriptions: [
					{
						name: 'tick',
						event: 'time.heartbeat',
						interval_minutes: 5,
						pipeline_name: 'P',
						prompt_file: '.maestro/prompts/tick.md',
					},
				],
			})
		);
		const out = path.join(tmp, 'exported.zip');
		await exportCueBundle({ dataDir, pipeline: 'P', outputPath: out, env: {} });
		const result = await validateCueBundle(out, { runningVersion: RUNNING });
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it('catches a file whose bytes no longer match the manifest', async () => {
		const result = await validate({
			tamper: { 'workspaces/proj/.maestro/prompts/tick.md': 'Tock, tampered.' },
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: 'hash-mismatch',
					file: 'workspaces/proj/.maestro/prompts/tick.md',
				}),
				expect.objectContaining({ code: 'size-mismatch' }),
			])
		);
	});

	it('catches a listed file that is absent from the archive', async () => {
		const result = await validate({
			manifest: (m) => {
				m.files.push({ path: 'agents/ghost.json', sha256: '0'.repeat(64), size: 1 });
			},
		});
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: 'file-missing', file: 'agents/ghost.json' })
		);
	});

	it('rejects an archive entry that manifest.files does not list', async () => {
		const result = await validate({ unlisted: { 'workspaces/proj/payload.sh': 'curl evil' } });
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			expect.objectContaining({ code: 'unlisted-file', file: 'workspaces/proj/payload.sh' }),
		]);
	});

	it('rejects a bundle that needs a newer engine, naming the version', async () => {
		const result = await validate({ manifest: (m) => (m.minEngineVersion = '0.19.0') });
		expect(codes(result.errors)).toEqual(['engine-too-old']);
		expect(result.errors[0].message).toContain('0.19.0');
	});

	it('orders pre-releases below their release', async () => {
		const file = writeCueBundle(path.join(tmp, 'b.zip'), {
			manifest: (m) => (m.minEngineVersion = '0.18.6'),
		});
		const rc = await validateCueBundle(file, { runningVersion: '0.18.6-RC' });
		expect(codes(rc.errors)).toEqual(['engine-too-old']);
		const release = await validateCueBundle(file, { runningVersion: '0.18.6' });
		expect(release.valid).toBe(true);
	});

	it('catches subscription and owner references to agents outside the bundle', async () => {
		const result = await validate({
			cue: (doc) => {
				doc.settings = { owner_agent_id: 'Nobody' };
				doc.subscriptions.push({
					name: 'chain',
					event: 'agent.completed',
					agent_id: 'agent-ghost',
					source_session: ['Alpha', 'Upstream'],
					source_session_ids: ['agent-upstream'],
					fan_out_ids: ['agent-a', 'agent-fan'],
					prompt: 'Continue',
				});
			},
		});
		const messages = result.errors.filter((e) => e.code === 'unknown-agent').map((e) => e.message);
		expect(messages).toHaveLength(5);
		for (const name of ['Nobody', 'agent-ghost', 'Upstream', 'agent-upstream', 'agent-fan']) {
			expect(messages.some((m) => m.includes(`"${name}"`))).toBe(true);
		}
		expect(
			result.errors.every((e) => e.code !== 'unknown-agent' || e.file === FIXTURE_CUE_PATH)
		).toBe(true);
	});

	it('catches a prompt file that is not in the archive', async () => {
		const result = await validate({
			files: (f) => f.delete('workspaces/proj/.maestro/prompts/tick.md'),
		});
		expect(result.errors).toEqual([
			expect.objectContaining({ code: 'prompt-file-missing', file: FIXTURE_CUE_PATH }),
		]);
	});

	it('flags a command.mode cli node as desktop-only', async () => {
		const result = await validate({
			cue: (doc) =>
				doc.subscriptions.push({
					name: 'relay',
					event: 'agent.completed',
					agent_id: 'agent-a',
					source_session: 'Alpha',
					action: 'command',
					command: { mode: 'cli', cli: { command: 'send', target: 'agent-a' } },
				}),
		});
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: 'desktop-only-command', file: FIXTURE_CUE_PATH })
		);
	});

	it('catches a sub-minute heartbeat and a ":" in a subscription name', async () => {
		const result = await validate({
			cue: (doc) => {
				doc.subscriptions[0].interval_minutes = 0.5;
				doc.subscriptions[1].name = 'hook:fast';
			},
		});
		expect(codes(result.errors)).toEqual(
			expect.arrayContaining(['sub-minute-heartbeat', 'name-has-colon'])
		);
	});

	it('tags a cue.yaml schema error with its file', async () => {
		const result = await validate({
			cue: (doc) => {
				delete doc.subscriptions[0].event;
			},
		});
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: 'cue-config-invalid', file: FIXTURE_CUE_PATH })
		);
	});

	it('flags secrets missing from requirements.secrets', async () => {
		const result = await validate({ manifest: (m) => (m.requirements.secrets = []) });
		const missing = result.errors.filter((e) => e.code === 'secret-not-declared');
		expect(missing.map((e) => e.file).sort()).toEqual(['agents/agent-a.json', FIXTURE_CUE_PATH]);
		expect(missing.some((e) => e.message.includes('API_KEY'))).toBe(true);
		expect(missing.some((e) => e.message.includes('HOOK_SECRET'))).toBe(true);
	});

	it('reports unset secrets as warnings with checkEnv', async () => {
		const file = writeCueBundle(path.join(tmp, 'b.zip'));
		const result = await validateCueBundle(file, {
			runningVersion: RUNNING,
			checkEnv: true,
			env: { API_KEY: 'set' },
		});
		expect(result.valid).toBe(true);
		expect(result.warnings).toEqual([
			{ code: 'secret-unset', message: 'HOOK_SECRET is not set in this environment' },
		]);

		const without = await validateCueBundle(file, { runningVersion: RUNNING, env: {} });
		expect(without.warnings).toEqual([]);
	});

	it('reports a missing manifest as an error and throws on a non-zip', async () => {
		const noManifest = path.join(tmp, 'no-manifest.zip');
		fs.writeFileSync(noManifest, zipSync({ 'README.md': strToU8('# hi') }));
		const result = await validateCueBundle(noManifest, { runningVersion: RUNNING });
		expect(result.valid).toBe(false);
		expect(codes(result.errors)).toEqual(['manifest-missing']);

		const notZip = path.join(tmp, 'not.zip');
		fs.writeFileSync(notZip, 'plain text');
		await expect(validateCueBundle(notZip, { runningVersion: RUNNING })).rejects.toThrow();
	});
});

describe('validateCueBundle - chain references', () => {
	/** An `agent.completed` chain on Alpha, waiting on `source` / `sourceSub`. */
	function chain(source: string, sourceSub: string) {
		return (doc: { subscriptions: Array<Record<string, unknown>> }) =>
			doc.subscriptions.push({
				name: 'after-tick',
				event: 'agent.completed',
				agent_id: 'agent-a',
				source_session: source,
				source_sub: sourceSub,
				prompt: 'Continue',
			});
	}

	it('fails a pipeline bundle whose source_sub names no subscription', async () => {
		const result = await validate({ cue: chain('Alpha', 'never-declared') });
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			expect.objectContaining({ code: 'unknown-subscription', file: FIXTURE_CUE_PATH }),
		]);
		expect(result.errors[0].message).toContain('"never-declared"');
	});

	it('passes a pipeline bundle whose source_sub names a bundled subscription', async () => {
		const result = await validate({ cue: chain('Alpha', 'tick') });
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it('warns, rather than fails, on an agent bundle chained to an outside agent', async () => {
		const result = await validate({
			cue: chain('Upstream', 'upstream-build'),
			manifest: (m) => (m.kind = 'maestro-agent'),
		});
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
		expect(codes(result.warnings).sort()).toEqual(['unknown-agent', 'unknown-subscription']);
		expect(result.warnings.every((w) => w.file === FIXTURE_CUE_PATH)).toBe(true);
	});

	it('still fails an agent bundle whose subscription targets an outside agent', async () => {
		const result = await validate({
			cue: (doc) => (doc.subscriptions[0].agent_id = 'agent-ghost'),
			manifest: (m) => (m.kind = 'maestro-agent'),
		});
		expect(codes(result.errors)).toEqual(['unknown-agent']);
	});
});
