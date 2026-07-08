import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteCommandOptions } from '../../main/utils/ssh-command-builder';
import type { SshRemoteConfig } from '../../shared/types';

const mocks = vi.hoisted(() => ({
	resolveSshPath: vi.fn(async () => '/mock/bin/ssh'),
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../main/utils/cliDetection', () => ({
	resolveSshPath: mocks.resolveSshPath,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

import {
	buildRemoteCommand,
	buildSshCommand,
	buildSshCommandWithStdin,
	buildSshScriptPreview,
	getRemoteImageExtension,
} from '../../main/utils/ssh-command-builder';

function sshConfig(overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig {
	return {
		id: 'remote-1',
		name: 'Remote One',
		host: 'dev.example.test',
		port: 22,
		username: 'agent',
		privateKeyPath: '',
		enabled: true,
		useSshConfig: false,
		...overrides,
	};
}

function lastArg(args: string[]): string {
	return args[args.length - 1] ?? '';
}

describe('ssh-command-builder integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.resolveSshPath.mockResolvedValue('/mock/bin/ssh');
	});

	it('builds escaped remote commands and utility fallbacks', () => {
		expect(getRemoteImageExtension('image/jpeg')).toBe('jpeg');
		expect(getRemoteImageExtension('image')).toBe('png');
		expect(buildSshScriptPreview('a'.repeat(500))).toHaveLength(500);
		expect(buildSshScriptPreview('b'.repeat(501))).toBe(`${'b'.repeat(500)}...`);

		const command = buildRemoteCommand({
			command: 'claude',
			args: ['--print', "hello 'quoted' $USER"],
			cwd: '/repo with spaces',
			env: {
				ANTHROPIC_API_KEY: "sk 'secret'",
				'1INVALID': 'skip-me',
				ALSO_OK: 'two words',
			},
		});

		expect(command).toContain("cd '/repo with spaces' &&");
		expect(command).toContain("ANTHROPIC_API_KEY='sk '\\''secret'\\'''");
		expect(command).toContain("ALSO_OK='two words'");
		expect(command).not.toContain('1INVALID');
		expect(command).toContain("claude '--print' 'hello '\\''quoted'\\'' $USER'");

		expect(
			buildRemoteCommand({
				command: 'codex',
				args: ['--input-format', 'stream-json'],
				useStdin: true,
			})
		).toBe("exec codex '--input-format' 'stream-json'");

		expect(
			buildRemoteCommand({
				command: 'opencode',
				args: ['run'],
				useStdin: true,
			})
		).toBe("opencode 'run'");
	});

	it('builds SSH argv with TTY decisions, config/env merging, and PATH setup', async () => {
		const forcedTty = await buildSshCommand(
			sshConfig({
				port: 2222,
				privateKeyPath: '~/.ssh/id_ed25519',
				remoteEnv: {
					REMOTE_ONLY: 'from config',
					SHARED: 'from config',
					'BAD-NAME': 'ignored',
				},
			}),
			{
				command: 'claude',
				args: ['--print', 'summarize'],
				cwd: "/srv/project's root",
				env: {
					SHARED: 'from command',
					COMMAND_ONLY: 'with spaces',
				},
			}
		);

		expect(forcedTty.command).toBe('/mock/bin/ssh');
		expect(forcedTty.args[0]).toBe('-tt');
		expect(forcedTty.args).toContain('-i');
		expect(forcedTty.args[forcedTty.args.indexOf('-i') + 1]).toMatch(/\.ssh\/id_ed25519$/);
		expect(forcedTty.args).toContain('-p');
		expect(forcedTty.args[forcedTty.args.indexOf('-p') + 1]).toBe('2222');
		expect(forcedTty.args).toContain('RequestTTY=force');
		expect(forcedTty.args).toContain('agent@dev.example.test');

		const wrapped = lastArg(forcedTty.args);
		expect(wrapped).toContain('/bin/bash --norc --noprofile -c');
		expect(wrapped).toContain('$HOME/.local/bin');
		expect(wrapped).toContain('_nvm_dir=');
		expect(wrapped).toContain('/srv/project');
		expect(wrapped).toContain('REMOTE_ONLY=');
		expect(wrapped).toContain('SHARED=');
		expect(wrapped).toContain('COMMAND_ONLY=');
		expect(wrapped).not.toContain('BAD-NAME');

		const buildLog = mocks.logger.info.mock.calls.find(
			([message]) => message === 'SSH command built for remote execution'
		);
		const remoteCommand = (buildLog?.[2] as { remoteCommand?: string })?.remoteCommand ?? '';
		expect(remoteCommand).toContain("cd '/srv/project'\\''s root'");
		expect(remoteCommand).toContain("REMOTE_ONLY='from config'");
		expect(remoteCommand).toContain("SHARED='from command'");
		expect(remoteCommand).toContain("COMMAND_ONLY='with spaces'");
		expect(remoteCommand).toContain("claude '--print' 'summarize'");

		const configBacked = await buildSshCommand(
			sshConfig({
				host: 'dev-host-alias',
				port: 22,
				username: '',
				privateKeyPath: '   ',
				useSshConfig: true,
			}),
			{
				command: 'codex',
				args: ['--print', '--input-format', 'stream-json'],
			}
		);

		expect(configBacked.args).not.toContain('-tt');
		expect(configBacked.args).not.toContain('-i');
		expect(configBacked.args).not.toContain('-p');
		expect(configBacked.args).toContain('RequestTTY=no');
		expect(configBacked.args).toContain('dev-host-alias');
		expect(lastArg(configBacked.args)).toContain('codex');
		expect(lastArg(configBacked.args)).toContain('stream-json');

		const stdinFlag = await buildSshCommand(sshConfig(), {
			command: 'claude',
			args: ['--print'],
			useStdin: true,
		});
		expect(stdinFlag.args).not.toContain('-tt');
		expect(lastArg(stdinFlag.args)).toContain('claude');
		expect(lastArg(stdinFlag.args)).toContain('--print');
		expect(mocks.logger.debug).toHaveBeenCalledWith(
			'SSH TTY decision',
			'[ssh-command-builder]',
			expect.objectContaining({ forceTty: false, useStdinFlag: true })
		);

		const argsFallback = await buildSshCommand(sshConfig({ host: 'args-fallback.example.test' }), {
			command: 'env',
		} as RemoteCommandOptions);
		expect(argsFallback.args).not.toContain('-tt');
		expect(lastArg(argsFallback.args)).toContain('env');
	});

	it('builds stdin SSH scripts with cwd, env exports, and raw prompt passthrough', async () => {
		const command = await buildSshCommandWithStdin(
			sshConfig({
				host: 'configured-host',
				username: '',
				privateKeyPath: '~/.ssh/stdin_id',
				useSshConfig: true,
				remoteEnv: {
					REMOTE_ONLY: 'remote value',
					SHARED: 'remote value',
					'BAD-NAME': 'ignored',
				},
			}),
			{
				command: 'opencode',
				args: ['run', '--format', 'json'],
				cwd: '/workspace/project',
				env: {
					SHARED: 'command value',
					COMMAND_ONLY: 'command value',
				},
				prompt: 'do not pass as argv',
				stdinInput: 'Line 1\nLine 2',
			}
		);

		expect(command.command).toBe('/mock/bin/ssh');
		expect(command.args).toContain('-i');
		expect(command.args[command.args.indexOf('-i') + 1]).toMatch(/\.ssh\/stdin_id$/);
		expect(command.args).toEqual(
			expect.arrayContaining(['configured-host', '/bin/bash', '--norc', '--noprofile', '-s'])
		);
		expect(command.args).not.toContain('-p');
		expect(command.stdinScript).toContain('export PATH="$HOME/.local/bin');
		expect(command.stdinScript).toContain('for _fnm_dir in');
		expect(command.stdinScript).toContain("cd '/workspace/project' || exit 1");
		expect(command.stdinScript).toContain("export REMOTE_ONLY='remote value'");
		expect(command.stdinScript).toContain("export SHARED='command value'");
		expect(command.stdinScript).toContain("export COMMAND_ONLY='command value'");
		expect(command.stdinScript).not.toContain('BAD-NAME');
		expect(command.stdinScript).toContain("exec opencode 'run' '--format' 'json'");
		expect(command.stdinScript).toContain('\nLine 1\nLine 2');
		expect(command.stdinScript).not.toContain('do not pass as argv');
		expect(command.remoteTempImagePaths).toBeUndefined();
	});

	it('decodes remote images into temp files, passes image argv, and schedules cleanup', async () => {
		const command = await buildSshCommandWithStdin(sshConfig({ port: 2200 }), {
			command: 'codex',
			args: ['exec'],
			prompt: "what's in image",
			images: ['data:image/png;base64,aGVsbG8=', 'not-a-data-url'],
			imageArgs: (imagePath) => ['-i', imagePath],
		});

		expect(command.args).toContain('-p');
		expect(command.args[command.args.indexOf('-p') + 1]).toBe('2200');
		expect(command.remoteTempImagePaths).toHaveLength(1);
		expect(command.remoteTempImagePaths?.[0]).toMatch(/^\/tmp\/maestro-image-\d+-0\.png$/);
		expect(command.stdinScript).toContain("base64 -d > '/tmp/maestro-image-");
		expect(command.stdinScript).toContain("<<'MAESTRO_IMG_0_EOF'");
		expect(command.stdinScript).toContain('aGVsbG8=');
		expect(command.stdinScript).toContain("codex 'exec' '-i' '/tmp/maestro-image-");
		expect(command.stdinScript).toContain("'what'\\''s in image'; rm -f '/tmp/maestro-image-");
		expect(command.stdinScript).not.toContain('exec codex');
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'SSH: embedded remote image decode commands',
			'[ssh-command-builder]',
			expect.objectContaining({ imageCount: 2, decodedCount: 1, imageResumeMode: 'default' })
		);
	});

	it('embeds remote image paths into resumed stdin prompts', async () => {
		const command = await buildSshCommandWithStdin(sshConfig(), {
			command: 'codex',
			args: ['exec', 'resume'],
			stdinInput: 'continue the prior task',
			images: ['data:image/jpeg;base64,/9j='],
			imageArgs: (imagePath) => ['-i', imagePath],
			imageResumeMode: 'prompt-embed',
		});

		expect(command.remoteTempImagePaths?.[0]).toMatch(/^\/tmp\/maestro-image-\d+-0\.jpeg$/);
		expect(command.stdinScript).toContain('[Attached images: /tmp/maestro-image-');
		expect(command.stdinScript).toContain('.jpeg]\n\ncontinue the prior task');
		expect(command.stdinScript).not.toContain("'-i'");
		expect(command.stdinScript).toContain("codex 'exec' 'resume'; rm -f");
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'SSH: embedded remote image decode commands',
			'[ssh-command-builder]',
			expect.objectContaining({
				imageCount: 1,
				decodedCount: 1,
				imageResumeMode: 'prompt-embed',
			})
		);

		const promptEmbedded = await buildSshCommandWithStdin(sshConfig(), {
			command: 'codex',
			args: ['exec', 'resume'],
			prompt: 'continue from prompt',
			images: ['data:image/png;base64,aGk='],
			imageArgs: (imagePath) => ['-i', imagePath],
			imageResumeMode: 'prompt-embed',
		});
		expect(promptEmbedded.stdinScript).toContain('[Attached images: /tmp/maestro-image-');
		expect(promptEmbedded.stdinScript).toContain('.png]\n\ncontinue from prompt');
		expect(promptEmbedded.stdinScript).not.toContain("'-i'");

		const noPromptToEmbed = await buildSshCommandWithStdin(sshConfig(), {
			command: 'codex',
			args: ['exec', 'resume'],
			images: ['data:image/png;base64,aGk='],
			imageArgs: (imagePath) => ['-i', imagePath],
			imageResumeMode: 'prompt-embed',
		});
		expect(noPromptToEmbed.stdinScript).not.toContain('[Attached images:');
		expect(noPromptToEmbed.stdinScript).toContain("codex 'exec' 'resume'; rm -f");
	});
});
