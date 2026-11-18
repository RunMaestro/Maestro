import path from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
	buildPromptArgv,
	POSIX_PROMPT_ARGV_MAX_BYTES,
	promptExceedsArgvLimit,
	resolvePromptDelivery,
	resolveSystemPromptDelivery,
	WINDOWS_PROMPT_ARGV_MAX_CHARS,
	windowsCommandLineLength,
	windowsQuotedArgLength,
	type PromptDeliveryAgent,
	type ResolvePromptDeliveryInput,
} from '../../../../shared/maestro-lib/launch/prompt-delivery';
import type { AcpPromptBlock } from '../../../../shared/maestro-lib/launch/image-refs';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import { applySystemPromptDelivery } from '../../../../shared/maestro-lib/turns/args';
import {
	embedSystemPromptInPrompt,
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
	stripEmbeddedSystemPrompt,
} from '../../../../shared/embeddedSystemPrompt';

/** A real provider, as the spawners see it: definition plus capabilities. */
function provider(id: string): PromptDeliveryAgent {
	return { ...getAgentDefinition(id), capabilities: getAgentCapabilities(id) };
}

describe('buildPromptArgv', () => {
	it('uses the provider flag when it has one (Copilot: -p)', () => {
		expect(buildPromptArgv(provider('copilot-cli'), 'hi')).toEqual(['-p', 'hi']);
	});

	it('uses Hermes -q', () => {
		expect(buildPromptArgv(provider('hermes'), 'hi')).toEqual(['-q', 'hi']);
	});

	it('puts a bare positional for a CLI that rejects -- (Pi, Factory Droid)', () => {
		expect(buildPromptArgv(provider('pi'), 'hi')).toEqual(['hi']);
		expect(buildPromptArgv(provider('factory-droid'), 'hi')).toEqual(['hi']);
	});

	it('defaults to -- then the prompt (Claude Code)', () => {
		expect(buildPromptArgv(provider('claude-code'), '---frontmatter')).toEqual([
			'--',
			'---frontmatter',
		]);
	});
});

describe('promptExceedsArgvLimit', () => {
	it('uses the CreateProcess cap on Windows', () => {
		expect(promptExceedsArgvLimit('x'.repeat(WINDOWS_PROMPT_ARGV_MAX_CHARS), true)).toBe(false);
		expect(promptExceedsArgvLimit('x'.repeat(WINDOWS_PROMPT_ARGV_MAX_CHARS + 1), true)).toBe(true);
	});

	it('counts UTF-8 bytes off Windows', () => {
		expect(promptExceedsArgvLimit('x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES), false)).toBe(false);
		expect(promptExceedsArgvLimit('x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1), false)).toBe(true);
		// 40,000 three-byte characters: short in code units, 120,000 bytes on the wire.
		expect(promptExceedsArgvLimit('\u20ac'.repeat(40_000), false)).toBe(true);
		expect(promptExceedsArgvLimit('\u20ac'.repeat(30_000), false)).toBe(false);
	});

	// A prompt is measured as Node quotes it for CreateProcess, not as written:
	// every `"` gains a backslash, so a prompt well under the cap can cross it.
	it('measures a Windows prompt after quoting', () => {
		const over = '"'.repeat(15_000);
		const under = '"'.repeat(14_997);
		expect(over.length).toBeLessThan(WINDOWS_PROMPT_ARGV_MAX_CHARS);
		expect(windowsQuotedArgLength(over)).toBe(30_002);
		expect(windowsQuotedArgLength(under)).toBe(29_996);

		expect(promptExceedsArgvLimit(over, true)).toBe(true);
		expect(promptExceedsArgvLimit(under, true)).toBe(false);
	});
});

describe('windowsQuotedArgLength', () => {
	// Input and output pairs from libuv's quote_cmd_arg (src/win/process.c).
	it.each([
		['hello"world', '"hello\\"world"'],
		['hello""world', '"hello\\"\\"world"'],
		['hello\\world', 'hello\\world'],
		['hello\\\\world', 'hello\\\\world'],
		['hello\\"world', '"hello\\\\\\"world"'],
		['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
		['hello world\\', '"hello world\\\\"'],
		['', '""'],
		['a b', '"a b"'],
		['a\tb', '"a\tb"'],
		['plain', 'plain'],
	])('counts %j as %j', (input, quoted) => {
		expect(windowsQuotedArgLength(input)).toBe(quoted.length);
	});

	it('joins a command line with single spaces', () => {
		// ssh "a b" plain
		expect(windowsCommandLineLength('ssh', ['a b', 'plain'])).toBe(15);
	});
});

describe('resolvePromptDelivery', () => {
	const linux = { isWindowsHost: false, sshRemote: false };
	const windows = { isWindowsHost: true, sshRemote: false };

	it('delivers nothing when there is no prompt', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: '', ...linux })).toEqual({
			via: 'none',
		});
	});

	it('puts the prompt on the command line off Windows', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: 'hi', ...linux })).toEqual({
			via: 'argv',
			args: ['--', 'hi'],
		});
	});

	it('moves it to raw stdin on a Windows host for an agent that reads stdin', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: 'hi', ...windows })).toEqual({
			via: 'stdin',
			format: 'raw',
			args: [],
		});
	});

	it('adds the provider stdin flags on Windows (Hermes: --query-file -)', () => {
		expect(resolvePromptDelivery({ agent: provider('hermes'), prompt: 'hi', ...windows })).toEqual({
			via: 'stdin',
			format: 'raw',
			args: ['--query-file', '-'],
		});
	});

	it('keeps argv on Windows for an agent that does not read stdin (omp)', () => {
		expect(resolvePromptDelivery({ agent: provider('omp'), prompt: 'hi', ...windows }).via).toBe(
			'argv'
		);
	});

	it('uses stream-json stdin on Windows when images ride with the prompt', () => {
		expect(
			resolvePromptDelivery({
				agent: provider('claude-code'),
				prompt: 'hi',
				hasImages: true,
				...windows,
			})
		).toEqual({ via: 'stdin', format: 'stream-json', args: [] });
	});

	// MAESTRO-16C/16P/RM/VR: off Windows every prompt rode argv, so a synthesis
	// or consult carrying a long history failed the spawn with E2BIG (Linux caps
	// ONE argument at 128 KiB).
	it('moves an over-long prompt to stdin off Windows, for an agent that reads stdin', () => {
		const long = 'x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1);
		expect(
			resolvePromptDelivery({ agent: provider('claude-code'), prompt: long, ...linux })
		).toEqual({ via: 'stdin', format: 'raw', args: [] });
		expect(
			resolvePromptDelivery({ agent: provider('codex'), prompt: 'x'.repeat(1000), ...linux }).via
		).toBe('argv');
	});

	it('keeps an over-long prompt in argv for an agent that does not read stdin', () => {
		const long = 'x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1);
		expect(resolvePromptDelivery({ agent: provider('omp'), prompt: long, ...linux }).via).toBe(
			'argv'
		);
	});

	// MAESTRO-16E: Cue keeps a Windows prompt in argv (isWindowsHost: false), so
	// a Codex prompt with the system prompt embedded overran CreateProcess.
	it('applies the Windows cap when the surface keeps short prompts in argv', () => {
		const overWindowsCap = 'x'.repeat(WINDOWS_PROMPT_ARGV_MAX_CHARS + 1);
		expect(
			resolvePromptDelivery({
				agent: provider('codex'),
				prompt: overWindowsCap,
				...linux,
				hostIsWindows: true,
			})
		).toEqual({ via: 'stdin', format: 'raw', args: [] });
		expect(
			resolvePromptDelivery({ agent: provider('codex'), prompt: overWindowsCap, ...linux }).via
		).toBe('argv');
	});

	it('leaves the prompt to the SSH script on a remote, whatever the host OS', () => {
		for (const isWindowsHost of [true, false]) {
			expect(
				resolvePromptDelivery({
					agent: provider('codex'),
					prompt: 'hi',
					isWindowsHost,
					sshRemote: true,
				})
			).toEqual({ via: 'ssh' });
		}
	});
});

describe('resolvePromptDelivery ACP JSON artifacts', () => {
	// Observe the registered builders without replacing their behavior or route declaration.
	const registered = provider('grok');
	const promptArgs = vi.fn(registered.promptArgs);
	const promptFileArgs = vi.fn(registered.promptFileArgs);
	const grok: PromptDeliveryAgent = {
		...registered,
		promptArgs,
		promptFileArgs,
	};
	const base: ResolvePromptDeliveryInput = {
		agent: grok,
		prompt: undefined,
		isWindowsHost: false,
		sshRemote: false,
		promptFileDestination: { path: path.resolve('owned prompt-é.json'), owner: 'local' },
	};
	const image = { type: 'image', mimeType: 'image/png', data: 'AQID' } as const;
	const embeddedImageSupport = {
		mimeTypes: ['image/png'],
		maxCount: 1,
		maxBytesPerImage: 3,
		maxTotalBytes: 3,
	};
	const privateText =
		'  private prompt "雪"\nsecond line\t$(touch sentinel) `id` & | ; < > %PATH% \' ';

	beforeEach(() => vi.clearAllMocks());

	it.each([
		{ name: 'empty', prompt: '' },
		{ name: 'whitespace', prompt: ' \t\r\n ' },
		{ name: 'Unicode and shell metacharacters', prompt: privateText },
		{ name: 'above Windows argv limits', prompt: privateText.repeat(2048) },
	])('preserves exact $name bytes in the native envelope', ({ prompt }) => {
		for (const isWindowsHost of [false, true]) {
			const result = resolvePromptDelivery({ ...base, prompt, isWindowsHost });
			expect(result.via).toBe('file');
			if (result.via !== 'file') throw new Error('Expected prompt artifact');
			expect(JSON.parse(result.artifact.content)).toEqual({
				type: 'acp',
				content: [{ type: 'text', text: prompt }],
			});
			expect(Buffer.from(result.artifact.content, 'utf8')).toEqual(
				Buffer.from(
					JSON.stringify({ type: 'acp', content: [{ type: 'text', text: prompt }] }),
					'utf8'
				)
			);
			expect(result.args).toEqual(['--prompt-file', base.promptFileDestination!.path]);
			expect(promptArgs).not.toHaveBeenCalled();
			if (prompt.length > 32768) {
				expect(result.args.join(' ').length).toBeLessThan(8192);
			}
		}
	});

	it('distinguishes an absent prompt from an explicitly empty file turn', () => {
		expect(resolvePromptDelivery(base)).toEqual({ via: 'none' });
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(resolvePromptDelivery({ ...base, prompt: '' }).via).toBe('file');
		expect(promptArgs).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		'composes one system envelope and skips it on resume (Windows=%s)',
		(isWindowsHost) => {
			for (const sshRemote of [false, true]) {
				for (const isResume of [false, true]) {
					const definition = getAgentDefinition('grok')!;
					const systemPrompt = 'Private Maestro system context\n  preserve spacing 雪';
					const args = isResume ? definition.resumeArgs!('synthetic-session') : [];
					const originalArgs = [...args];
					const placed = applySystemPromptDelivery({
						args,
						prompt: privateText,
						systemPrompt,
						supportsAppendSystemPrompt: getAgentCapabilities('grok').supportsAppendSystemPrompt,
						isResume,
						isWindowsHost,
						sshRemote,
					});
					expect(placed.delivery).toEqual({ via: isResume ? 'skip-on-resume' : 'embed' });
					expect(placed.args).toEqual(originalArgs);
					expect(args).toEqual(originalArgs);
					const expected = isResume
						? privateText
						: embedSystemPromptInPrompt(systemPrompt, privateText);
					expect(placed.prompt).toBe(expected);
					expect(placed.prompt!.split(EMBEDDED_SYSTEM_PROMPT_SEPARATOR)).toHaveLength(
						isResume ? 1 : 2
					);
					expect(stripEmbeddedSystemPrompt(placed.prompt!)).toBe(privateText);
					const destination = sshRemote
						? {
								owner: 'remote' as const,
								path: '/remote/scratch/system.json',
								sshRemoteId: 'selected-host',
							}
						: base.promptFileDestination!;
					const delivered = resolvePromptDelivery({
						...base,
						prompt: placed.prompt,
						args: placed.args,
						isWindowsHost,
						sshRemote,
						sshRemoteId: sshRemote ? 'selected-host' : undefined,
						promptFileDestination: destination,
					});
					if (delivered.via !== 'file') throw new Error('Expected registered Grok file route');
					expect(delivered.args).toEqual(['--prompt-file', destination.path]);
					expect(delivered.artifact.content).toBe(
						JSON.stringify({ type: 'acp', content: [{ type: 'text', text: expected }] })
					);
					expect(promptArgs).not.toHaveBeenCalled();
				}
			}
		}
	);

	describe.each([
		{ name: 'local', isWindowsHost: false, sshRemote: false, owner: 'local' as const },
		{ name: 'Windows', isWindowsHost: true, sshRemote: false, owner: 'local' as const },
		{ name: 'SSH', isWindowsHost: true, sshRemote: true, owner: 'remote' as const },
	])('$name executing host', ({ isWindowsHost, sshRemote, owner }) => {
		it.each([false, true])(
			'keeps content, resume identity and read-only args (resume=%s)',
			(resume) => {
				const definition = getAgentDefinition('grok')!;
				const sessionId = '019aa4fe-0000-7000-8000-000000000001';
				const args = Object.freeze([
					...(definition.readOnlyArgs ?? []),
					...(resume ? definition.resumeArgs!(sessionId) : []),
				]);
				const originalArgs = [...args];
				const promptBlocks: AcpPromptBlock[] = [
					{ type: 'text', text: privateText },
					image,
					{ type: 'text', text: '\n  after image 🧪  ' },
				];
				// Supplied destinations stand in for the host allocator; no files are created.
				const destination = {
					owner,
					path: sshRemote
						? path.posix.join('/remote/scratch', `attempt-${resume}.json`)
						: isWindowsHost
							? path.win32.join('C:\\scratch', `attempt-${resume}.json`)
							: path.resolve(`attempt-${resume}.json`),
				};
				const result = resolvePromptDelivery({
					...base,
					isWindowsHost,
					sshRemote,
					args,
					promptBlocks,
					hasImages: true,
					embeddedImageSupport,
					promptFileDestination: destination,
				});
				expect(result).toEqual({
					via: 'file',
					args: ['--prompt-file', destination.path],
					artifact: {
						...destination,
						content: expect.any(String),
						encoding: 'utf8',
						mode: 0o600,
						flag: 'wx',
						cleanup: 'turn',
					},
				});
				expect(args).toEqual(originalArgs);
				expect(promptArgs).not.toHaveBeenCalled();
				expect(promptFileArgs).toHaveBeenCalledExactlyOnceWith(destination.path);
				if (result.via !== 'file') throw new Error('Expected prompt artifact');
				expect(JSON.parse(result.artifact.content)).toEqual({ type: 'acp', content: promptBlocks });
				expect(result.artifact.content).not.toContain(sessionId);
				expect(result.args).not.toContain(privateText);
			}
		);
	});

	it.each([false, true])(
		'requires image admission for each fresh/resumed turn (resume=%s)',
		(resume) => {
			const args = resume ? getAgentDefinition('grok')!.resumeArgs!('synthetic-session') : [];
			const input = { ...base, args, promptBlocks: [image] };
			expect(resolvePromptDelivery({ ...input, embeddedImageSupport }).via).toBe('file');
			promptFileArgs.mockClear();
			const result = resolvePromptDelivery(input);
			expect(result).toEqual({
				via: 'refused',
				error: 'Embedded images require explicit support and bounded image limits.',
			});
			expect(promptFileArgs).not.toHaveBeenCalled();
			expect(promptArgs).not.toHaveBeenCalled();
		}
	);

	it.each([
		{ prompt: privateText, hasImages: true },
		{ hasImages: true },
		{ hasImages: true, promptBlocks: [{ type: 'text', text: privateText }] as AcpPromptBlock[] },
	])('refuses missing embedded bytes instead of retrying text: %j', (input) => {
		expect(resolvePromptDelivery({ ...base, ...input, embeddedImageSupport })).toEqual({
			via: 'refused',
			error: 'Image content is missing from the ACP prompt file.',
		});
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(promptArgs).not.toHaveBeenCalled();
	});

	it.each([
		{
			images: [{ ...image, mimeType: 'image/webp' }],
			limits: embeddedImageSupport,
			error: 'The embedded image MIME type is not supported for this turn.',
		},
		{
			images: [image, image],
			limits: embeddedImageSupport,
			error: 'The prompt exceeds the admitted image count.',
		},
		{
			images: [{ ...image, data: 'AQIDBA==' }],
			limits: embeddedImageSupport,
			error: 'The prompt exceeds the admitted image byte limits.',
		},
		{
			images: [image, image],
			limits: { ...embeddedImageSupport, maxCount: 2 },
			error: 'The prompt exceeds the admitted image byte limits.',
		},
	])(
		'propagates image refusal $error without Windows stdin or text-only retry',
		({ images, limits, error }) => {
			expect(
				resolvePromptDelivery({
					...base,
					isWindowsHost: true,
					promptBlocks: [{ type: 'text', text: privateText }, ...images],
					embeddedImageSupport: limits,
				})
			).toEqual({ via: 'refused', error });
			expect(promptFileArgs).not.toHaveBeenCalled();
			expect(promptArgs).not.toHaveBeenCalled();
		}
	);

	it.each(['', privateText])('rejects simultaneous text and blocks even for text %j', (prompt) => {
		expect(resolvePromptDelivery({ ...base, prompt, promptBlocks: [image] })).toEqual({
			via: 'refused',
			error: 'Supply either prompt text or ordered content blocks, not both.',
		});
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(promptArgs).not.toHaveBeenCalled();
	});

	it.each([{ promptBlocks: null }, { promptBlocks: [] }])(
		'never replaces invalid blocks $promptBlocks with empty text',
		({ promptBlocks }) => {
			expect(
				resolvePromptDelivery({
					...base,
					promptBlocks: promptBlocks as unknown as AcpPromptBlock[],
				})
			).toEqual({
				via: 'refused',
				error: 'An ACP prompt file requires at least one content block.',
			});
			expect(promptFileArgs).not.toHaveBeenCalled();
		}
	);

	it.each(['claude-code', 'codex', 'omp'])(
		'refuses ordered blocks on unselected %s routes',
		(id) => {
			expect(
				resolvePromptDelivery({ ...base, agent: provider(id), promptBlocks: [image] })
			).toEqual({
				via: 'refused',
				error: 'Ordered content requires an ACP JSON prompt-file route.',
			});
		}
	);

	it.each([
		['-p', privateText],
		['--single', privateText],
		['--single=' + privateText],
		['--prompt-json', privateText],
		['--prompt-json=' + privateText],
		['--prompt-file', 'private-other.json'],
		['--prompt-file=private-other.json'],
		['-p=' + privateText],
		['-p' + privateText],
		['--', privateText],
	])('refuses competing prompt source %s without disclosing its value', (...args) => {
		expect(resolvePromptDelivery({ ...base, prompt: privateText, args })).toEqual({
			via: 'refused',
			error: 'Prompt-file delivery conflicts with another prompt source in the launch arguments.',
		});
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(promptArgs).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		{ owner: 'remote' as const, path: path.posix.join('/remote', 'private.json') },
		{ owner: 'local' as const, path: 'relative-private.json' },
		{ owner: 'local' as const, path: path.resolve('private.txt') },
		{ owner: 'local' as const, path: path.resolve('private.JSON') },
		{ owner: 'local' as const, path: path.resolve('private\0.json') },
	])('refuses invalid destination %j without prompt/path disclosure', (promptFileDestination) => {
		expect(resolvePromptDelivery({ ...base, prompt: privateText, promptFileDestination })).toEqual({
			via: 'refused',
			error:
				'Prompt-file delivery requires a fresh owned .json destination on the executing host and a provider file-argument builder.',
		});
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(promptArgs).not.toHaveBeenCalled();
	});
});

describe('resolveSystemPromptDelivery', () => {
	const base = {
		systemPrompt: 'You are Maestro.',
		isWindowsHost: false,
		sshRemote: false,
		isResume: false,
		hasUserPrompt: true,
	};

	it('passes nothing without a system prompt', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, systemPrompt: '', supportsAppendSystemPrompt: true })
		).toEqual({ via: 'none' });
	});

	it('uses the flag for a provider that has it, every turn including resume', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: true, isResume: true })
		).toEqual({ via: 'flag' });
	});

	it('uses a temp file on a Windows host', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: true,
				isWindowsHost: true,
			})
		).toEqual({ via: 'file' });
	});

	it('keeps the inline flag on an SSH remote from a Windows host', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: true,
				isWindowsHost: true,
				sshRemote: true,
			})
		).toEqual({ via: 'flag' });
	});

	it('embeds it in the first turn for a provider without the flag', () => {
		expect(resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: false })).toEqual({
			via: 'embed',
		});
	});

	it('skips it on resume for a provider without the flag', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: false, isResume: true })
		).toEqual({ via: 'skip-on-resume' });
	});

	it('sends it as the prompt when there is no user prompt', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: false,
				hasUserPrompt: false,
			})
		).toEqual({ via: 'as-prompt' });
	});
});

// Grok fake-platform prompt-delivery plans. These exercise the generated
// plan only; native Windows/macOS/Linux and SSH process smokes are not
// claimed here.
describe('Grok fake-platform prompt plans (generated plans, not a native smoke)', () => {
	const grok = provider('grok');
	const refusedDestination =
		'Prompt-file delivery requires a fresh owned .json destination on the executing host and a provider file-argument builder.';
	const surrogateRefusal =
		'Prompt-file text must be well-formed Unicode; it contains an unpaired surrogate.';
	const hosts = [
		{
			name: 'POSIX',
			isWindowsHost: false,
			sshRemote: false,
			destination: { owner: 'local' as const, path: path.posix.join('/tmp/owned dir', 'p.json') },
		},
		{
			name: 'Windows',
			isWindowsHost: true,
			sshRemote: false,
			destination: {
				owner: 'local' as const,
				path: path.win32.join('C:\\Users\\A B\\100% 雪 & co', 'p.json'),
			},
		},
		{
			name: 'SSH from Windows',
			isWindowsHost: true,
			sshRemote: true,
			sshRemoteId: 'selected-host',
			destination: {
				owner: 'remote' as const,
				path: '/remote/scratch dir/p.json',
				sshRemoteId: 'selected-host',
			},
		},
	];

	it('declares no verified stdin route, so stdin is never chosen for Grok', () => {
		expect(getAgentCapabilities('grok').supportsPromptViaStdin).toBe(false);
		// Even a forged stdin declaration cannot pull the prompt off the file route.
		const forged: PromptDeliveryAgent = {
			...grok,
			capabilities: { supportsPromptViaStdin: true, supportsStreamJsonInput: true },
			stdinPromptArgs: ['--stdin'],
		};
		for (const host of hosts) {
			const result = resolvePromptDelivery({
				agent: forged,
				prompt: 'hi',
				hasImages: false,
				isWindowsHost: host.isWindowsHost,
				sshRemote: host.sshRemote,
				sshRemoteId: host.sshRemoteId,
				promptFileDestination: host.destination,
			});
			expect(result.via).toBe('file');
		}
	});

	describe.each(hosts)('$name host', (host) => {
		const at = {
			agent: grok,
			isWindowsHost: host.isWindowsHost,
			sshRemote: host.sshRemote,
			sshRemoteId: host.sshRemoteId,
			promptFileDestination: host.destination,
		};

		it('keeps a quoted path with spaces, % and & as the only argv value', () => {
			const prompt = 'line 1\r\nline 2 "q" \'s\' `x` $(y) %PATH% ^& | > 🧪 雪\n'.repeat(4096);
			const result = resolvePromptDelivery({ ...at, prompt });
			if (result.via !== 'file') throw new Error('expected file route');
			expect(result.args).toEqual(['--prompt-file', host.destination.path]);
			expect(result.artifact).toMatchObject({ ...host.destination, flag: 'wx', mode: 0o600 });
			expect(JSON.parse(result.artifact.content).content[0].text).toBe(prompt);
		});

		it.each([
			['high surrogate at the end', 'cut emoji \uD83D'],
			['low surrogate alone', '\uDE00 leads'],
			['reversed pair', 'x\uDE00\uD83Dy'],
		])('refuses a %s with a fixed diagnostic', (_label, text) => {
			const inputs: ResolvePromptDeliveryInput[] = [
				{ ...at, prompt: text },
				{ ...at, prompt: undefined, promptBlocks: [{ type: 'text', text }] },
			];
			for (const input of inputs) {
				const result = resolvePromptDelivery(input);
				expect(result).toEqual({ via: 'refused', error: surrogateRefusal });
				expect(JSON.stringify(result)).not.toContain(text);
			}
		});

		it.each(['\r', '\n', '\t', '\u001b', '\u007f', '\u0000'])(
			'refuses a destination holding control character %j',
			(control) => {
				const destination = {
					...host.destination,
					path: host.destination.path.replace('p.json', `p${control}x.json`),
				};
				const result = resolvePromptDelivery({
					...at,
					prompt: 'private-prompt',
					promptFileDestination: destination,
				});
				expect(result).toEqual({ via: 'refused', error: refusedDestination });
				expect(JSON.stringify(result)).not.toContain('private-prompt');
			}
		);
	});

	it.each([
		['home-relative', { owner: 'remote' as const, path: '~/p.json', sshRemoteId: 'h' }],
		['relative', { owner: 'remote' as const, path: 'scratch/p.json', sshRemoteId: 'h' }],
		['Windows drive', { owner: 'remote' as const, path: 'C:\\scratch\\p.json', sshRemoteId: 'h' }],
		['other remote', { owner: 'remote' as const, path: '/scratch/p.json', sshRemoteId: 'other' }],
		['local-owned', { owner: 'local' as const, path: '/scratch/p.json' }],
	])('refuses a %s destination for an SSH launch', (_label, promptFileDestination) => {
		expect(
			resolvePromptDelivery({
				agent: grok,
				prompt: 'hi',
				isWindowsHost: true,
				sshRemote: true,
				sshRemoteId: 'h',
				promptFileDestination,
			})
		).toEqual({ via: 'refused', error: refusedDestination });
	});
});
