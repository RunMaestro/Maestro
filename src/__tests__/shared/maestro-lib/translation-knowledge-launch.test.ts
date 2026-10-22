// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { remapTranslationFs } from '../../helpers/translationFs';
import { generateUUID } from '../../../shared/uuid';
import { canonicalJson } from '../../../shared/canonicalJson';
import type { SshRemoteConfig } from '../../../shared/types';
import { translationHash } from '../../../shared/maestro-lib/translation/identity';
import {
	bindTranslationKnowledge,
	translationKnowledgeRoot,
	TRANSLATION_KNOWLEDGE_ENV_VAR,
	TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR,
} from '../../../shared/maestro-lib/translation/knowledge-binding';
import { buildAgentLaunchPlan } from '../../../shared/maestro-lib/launch/launch-plan';
import { wrapSpawnWithSsh } from '../../../shared/maestro-lib/launch/ssh-spawn-wrapper';
import {
	buildSshCommand,
	buildSshCommandWithStdin,
} from '../../../shared/maestro-lib/launch/ssh-command-builder';
import { setMaestroLibSshTranslationFs } from '../../../shared/maestro-lib/host';
import {
	embedSystemPromptInPrompt,
	stripEmbeddedSystemPrompt,
} from '../../../shared/embeddedSystemPrompt';

vi.mock('../../../shared/maestro-lib/launch/ssh-command-builder', () => ({
	buildSshCommand: vi.fn(),
	buildSshCommandWithStdin: vi.fn(),
}));

describe('host-bound translation knowledge launches', () => {
	const remote: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'example.invalid',
		port: 22,
		username: 'tester',
		privateKeyPath: '',
		enabled: true,
	};
	const sshStore = { getSshRemotes: () => [remote] };
	const sshRemoteConfig = { enabled: true, remoteId: remote.id };
	const identity = {
		remoteHost: translationHash(canonicalJson(remote)),
		remoteHome: '/remote/home',
	};
	const knowledgeRoot = translationKnowledgeRoot('', identity);
	const directory = path.posix.join(knowledgeRoot, translationHash('agent'), generateUUID());
	const env = {
		[TRANSLATION_KNOWLEDGE_ENV_VAR]: directory,
		[TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR]: canonicalJson(identity),
	};
	let temporary: string;
	let port: ReturnType<typeof remapTranslationFs>;
	const index = `Read ${directory}/memory/MEMORY.md and its linked topics.\nLiteral $(touch nope) and 'quoted' text.`;
	beforeEach(async () => {
		vi.clearAllMocks();
		temporary = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'translation-ssh-launch-'))
		);
		port = remapTranslationFs('/remote', temporary);
		port.nativeFs.paths = path.posix;
		const realpath = port.nativeFs.realpath.getMockImplementation()!;
		port.nativeFs.realpath.mockImplementation(async (file) =>
			(await realpath(file === '~' ? identity.remoteHome : file)).split(path.sep).join('/')
		);
		await fs.mkdir(port.backingPath(directory), { recursive: true });
		await fs.writeFile(port.backingPath(`${directory}/knowledge-index.md`), index);
		setMaestroLibSshTranslationFs(() => port.nativeFs);
		vi.mocked(buildSshCommandWithStdin).mockResolvedValue({
			command: 'ssh',
			args: ['remote'],
			stdinScript: 'synthetic script',
			remoteCommandLine: 'claude',
		});
	});
	afterEach(async () => {
		setMaestroLibSshTranslationFs(undefined);
		await fs.rm(temporary, { recursive: true, force: true });
	});

	it.each(['claude-code', 'codex'])(
		'binds the remote index on %s resume and keeps the file payload off SSH argv',
		async (provider) => {
			const prompt = embedSystemPromptInPrompt(
				'Existing system instructions',
				'Recall the earlier fact.'
			);
			const result = buildAgentLaunchPlan({
				surface: 'cli',
				agent: { id: provider },
				command: provider,
				args: ['--resume', 'native'],
				cwd: '/remote/project',
				prompt,
				sessionCustomEnvVars: env,
				sshRemoteConfig,
				sshStore,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.error);
			const plan = result.plan;
			expect(port.nativeFs.readFile).not.toHaveBeenCalled();
			if (provider === 'claude-code') {
				expect(plan.launchArgs).toContain('--add-dir');
				expect(plan.launchArgs).toContain(directory);
				expect(plan.launchArgs).toContain(
					JSON.stringify({ autoMemoryDirectory: `${directory}/memory` })
				);
			} else expect(plan.launchArgs).not.toContain('--add-dir');
			await wrapSpawnWithSsh(
				{
					command: plan.command,
					args: plan.launchArgs,
					cwd: plan.cwd,
					prompt,
					customEnvVars: plan.envVars,
				},
				sshRemoteConfig,
				sshStore
			);
			expect(buildSshCommand).not.toHaveBeenCalled();
			const args = vi.mocked(buildSshCommandWithStdin).mock.calls[0][1].args!;
			const delivered = args[args.length - 1];
			expect(delivered).toContain(index);
			expect(delivered).toContain('Existing system instructions');
			expect(stripEmbeddedSystemPrompt(delivered)).toBe('Recall the earlier fact.');
			expect(port.nativeFs.readFile).toHaveBeenCalledExactlyOnceWith(
				`${directory}/knowledge-index.md`
			);
		}
	);

	it.each(['local', 'missing-binding', 'different-host'] as const)(
		'refuses a %s launch before any file read',
		async (variant) => {
			const customEnvVars =
				variant === 'missing-binding'
					? { [TRANSLATION_KNOWLEDGE_ENV_VAR]: directory }
					: variant === 'different-host'
						? {
								...env,
								[TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR]: canonicalJson({
									...identity,
									remoteHost: 'f'.repeat(64),
								}),
							}
						: env;
			expect(() =>
				buildAgentLaunchPlan({
					surface: 'cli',
					agent: { id: 'claude-code' },
					command: 'claude',
					args: [],
					cwd: '/remote/project',
					prompt: 'Hello',
					sessionCustomEnvVars: customEnvVars,
					...(variant === 'local' ? {} : { sshRemoteConfig, sshStore }),
				})
			).toThrow(/local launch|remote host binding|different SSH host/);
			await expect(
				wrapSpawnWithSsh(
					{
						command: 'claude',
						args: [],
						cwd: '/remote/project',
						prompt: 'Hello',
						customEnvVars,
					},
					variant === 'local' ? undefined : sshRemoteConfig,
					sshStore
				)
			).rejects.toThrow();
			expect(port.nativeFs.readFile).not.toHaveBeenCalled();
			expect(buildSshCommandWithStdin).not.toHaveBeenCalled();
		}
	);

	it('refuses a remote path without its marker on a local launch', () => {
		expect(() =>
			buildAgentLaunchPlan({
				surface: 'cli',
				agent: { id: 'codex' },
				command: 'codex',
				args: [],
				cwd: temporary,
				prompt: 'Hello',
				translationKnowledgeRoot: path.join(temporary, 'data/provider-knowledge'),
				sessionCustomEnvVars: { [TRANSLATION_KNOWLEDGE_ENV_VAR]: directory },
			})
		).toThrow('Unsafe provider knowledge binding');
	});

	it('preserves a large remote index through the existing stdin prompt transport', async () => {
		const largeIndex = index.repeat(100);
		await fs.writeFile(port.backingPath(`${directory}/knowledge-index.md`), largeIndex);
		await wrapSpawnWithSsh(
			{
				command: 'codex',
				args: ['exec', 'resume', 'native'],
				cwd: '/remote/project',
				prompt: 'Recall the earlier fact.',
				customEnvVars: env,
			},
			sshRemoteConfig,
			sshStore
		);
		const invocation = vi.mocked(buildSshCommandWithStdin).mock.calls[0][1];
		expect(invocation.stdinInput).toContain(largeIndex);
		expect(stripEmbeddedSystemPrompt(invocation.stdinInput!)).toBe('Recall the earlier fact.');
		expect(invocation.args).toEqual(['exec', 'resume', 'native']);
		expect(buildSshCommand).not.toHaveBeenCalled();
	});

	it.each([
		'agent-link',
		'operation-link',
		'index-link',
		'different-home',
		'unavailable-port',
		'lost-connection',
	] as const)(
		'refuses %s without spawning the provider or reading local knowledge',
		async (variant) => {
			if (variant.endsWith('-link')) {
				const file =
					variant === 'agent-link'
						? path.posix.dirname(directory)
						: variant === 'operation-link'
							? directory
							: `${directory}/knowledge-index.md`;
				const lstat = port.nativeFs.lstat.getMockImplementation()!;
				port.nativeFs.lstat.mockImplementation(async (candidate) => {
					const stat = await lstat(candidate);
					return candidate === file ? { ...stat, isSymbolicLink: () => true } : stat;
				});
			} else if (variant === 'different-home') {
				port.nativeFs.realpath.mockResolvedValueOnce('/another/home');
			} else if (variant === 'unavailable-port') {
				setMaestroLibSshTranslationFs(undefined);
			} else {
				port.nativeFs.readFile.mockRejectedValue(new Error('SSH connection lost'));
			}
			await expect(
				wrapSpawnWithSsh(
					{
						command: 'claude',
						args: [],
						cwd: '/remote/project',
						prompt: 'Hello',
						customEnvVars: env,
					},
					sshRemoteConfig,
					sshStore
				)
			).rejects.toThrow(/symlink|SSH home|filesystem adapter|connection lost/);
			expect(buildSshCommandWithStdin).not.toHaveBeenCalled();
			expect(buildSshCommand).not.toHaveBeenCalled();
		}
	);

	it('rejects an outside operation directory using the remote port', async () => {
		await expect(
			bindTranslationKnowledge('Hello', '/remote/other', knowledgeRoot, port.nativeFs)
		).rejects.toThrow('Unsafe provider knowledge binding');
		expect(port.nativeFs.readFile).not.toHaveBeenCalled();
	});
});
