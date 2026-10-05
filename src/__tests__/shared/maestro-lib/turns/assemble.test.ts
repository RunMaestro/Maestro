/**
 * `assembleTurn`: the rules of `Plans/maestro-tui-prompt-assembly.md` section 8.2, one test
 * each. The byte-for-byte match with the desktop is the parity test; this file pins the
 * decisions (PA1 to PA17) and the refusals.
 */
import { describe, it, expect } from 'vitest';
import {
	assembleTurn,
	type AssembledTurn,
	type TurnAgent,
	type TurnContext,
	type TurnMessage,
	type TurnTab,
} from '../../../../shared/maestro-lib/turns/assemble';
import { READ_ONLY_PLAN_INSTRUCTION } from '../../../../shared/maestro-lib/turns/prompt';
import { embedSystemPromptInPrompt } from '../../../../shared/embeddedSystemPrompt';
import { FIXED_NOW, makeAgent, makeContext, makeTab } from './fixtures';

const SEP = '\n\n---\n\n';

function assemble(
	options: {
		agent?: Partial<TurnAgent>;
		tab?: Partial<TurnTab>;
		message?: Partial<TurnMessage>;
		context?: Partial<TurnContext>;
		toolType?: string;
	} = {}
): AssembledTurn {
	const toolType = options.toolType ?? options.agent?.toolType ?? 'claude-code';
	const result = assembleTurn(
		makeAgent({ toolType, ...options.agent }),
		makeTab(options.tab),
		{ text: 'hello', ...options.message },
		makeContext(toolType, options.context)
	);
	if (!result.ok) throw new Error(`expected a turn: ${result.message}`);
	return result.turn;
}

describe('refusals', () => {
	it('refuses a provider that cannot run a single turn without a terminal', () => {
		const result = assembleTurn(
			makeAgent({ toolType: 'terminal' }),
			makeTab(),
			{ text: 'hi' },
			makeContext('terminal')
		);
		expect(result).toMatchObject({ ok: false, reason: 'no-batch-mode' });
	});

	it('refuses a message with no text, no image and no command', () => {
		const result = assembleTurn(makeAgent(), makeTab(), { text: '  ' }, makeContext());
		expect(result).toMatchObject({ ok: false, reason: 'empty' });
	});

	it('accepts an image with no text', () => {
		const turn = assemble({ message: { text: '', images: ['a.png'] } });
		expect(turn.entry.images).toEqual(['a.png']);
		expect(turn.launch.hasImages).toBe(true);
	});
});

describe('the user prompt (PA1: composer rules for every message)', () => {
	it('appends the nudge and keeps it out of the transcript entry', () => {
		const turn = assemble({ agent: { nudgeMessage: 'be brief' } });
		expect(turn.prompt).toContain(`hello${SEP}be brief`);
		expect(turn.entry.text).toBe('hello');
	});

	it('prefixes the new-session message on the first turn only', () => {
		const first = assemble({ agent: { newSessionMessage: 'rules' } });
		expect(first.prompt).toContain(`rules${SEP}hello`);
		const later = assemble({
			agent: { newSessionMessage: 'rules' },
			tab: { agentSessionId: 'sess-1' },
		});
		expect(later.prompt).not.toContain('rules');
	});

	it('appends the plan instruction when the tab is read-only', () => {
		const turn = assemble({ tab: { readOnlyMode: true } });
		expect(turn.prompt).toContain(`hello${READ_ONLY_PLAN_INSTRUCTION}`);
		expect(turn.entry.readOnly).toBe(true);
	});

	it('uses the image-only default for an image with no text', () => {
		const turn = assemble({ message: { text: '', images: ['a.png'] } });
		expect(turn.prompt).toContain('DESCRIBE THE IMAGE');
	});

	it('folds in the pending merged context and says it was consumed (PA17)', () => {
		const turn = assemble({ tab: { pendingMergedContext: 'EARLIER WORK' } });
		expect(turn.prompt).toContain(`EARLIER WORK${SEP}hello`);
		expect(turn.consumedMergedContext).toBe(true);
		expect(assemble().consumedMergedContext).toBe(false);
	});

	it('puts the merged context ahead of every other layer', () => {
		const turn = assemble({
			agent: { newSessionMessage: 'rules', nudgeMessage: 'nudge' },
			tab: { pendingMergedContext: 'CTX' },
			toolType: 'codex',
			context: { prompts: { imageOnlyDefault: '', maestroSystem: undefined } },
		});
		expect(turn.prompt.startsWith(`CTX${SEP}rules${SEP}hello${SEP}nudge`)).toBe(true);
	});
});

describe('a Maestro command', () => {
	const command = {
		command: '/review',
		description: 'Review',
		prompt: 'Review $ARGUMENTS',
		args: 'a.ts',
	};

	it('expands its arguments and template variables', () => {
		const turn = assemble({
			message: { text: '/review a.ts', command: { ...command, prompt: 'In {{CWD}}: $ARGUMENTS' } },
		});
		expect(turn.prompt).toContain('In /work/project: a.ts');
	});

	it('records the expanded prompt with the command, not the typed line', () => {
		const turn = assemble({ message: { text: '/review a.ts', command } });
		expect(turn.entry).toEqual({
			text: 'Review a.ts',
			aiCommand: { command: '/review', description: 'Review' },
		});
	});

	it('applies no nudge, no new-session message, no merged context, no read-only instruction', () => {
		const turn = assemble({
			agent: { nudgeMessage: 'nudge', newSessionMessage: 'rules' },
			tab: { pendingMergedContext: 'CTX', readOnlyMode: true },
			message: { text: '/review a.ts', command },
			toolType: 'codex',
			context: { prompts: { imageOnlyDefault: '', maestroSystem: undefined } },
		});
		expect(turn.prompt).toBe('Review a.ts');
		expect(turn.consumedMergedContext).toBe(false);
	});

	it('leaves the history path empty inside a command (F13)', () => {
		const turn = assemble({
			message: {
				text: '/h',
				command: { command: '/h', prompt: '[{{AGENT_HISTORY_PATH}}]', args: '' },
			},
			context: { historyFilePath: '/h/agent-1.jsonl' },
		});
		expect(turn.prompt).toContain('[]');
	});

	it('uses the injected clock for date variables', () => {
		const turn = assemble({
			message: {
				text: '/d',
				command: { command: '/d', prompt: '{{YEAR}}-{{MONTH}}-{{DAY}}', args: '' },
			},
		});
		expect(turn.prompt).toContain(
			`${FIXED_NOW.getFullYear()}-${String(FIXED_NOW.getMonth() + 1).padStart(2, '0')}-${String(FIXED_NOW.getDate()).padStart(2, '0')}`
		);
	});
});

describe('read-only and permission mode', () => {
	it('is read-only for the message, the tab, a readonly permission mode, or an Auto Run on the tree', () => {
		expect(assemble({ message: { readOnly: true } }).readOnly).toBe(true);
		expect(assemble({ tab: { readOnlyMode: true } }).readOnly).toBe(true);
		expect(assemble({ tab: { permissionMode: 'readonly' } }).readOnly).toBe(true);
		expect(assemble({ context: { autoRunHoldsTree: true } }).readOnly).toBe(true);
	});

	it('lets Force Send past an Auto Run, but not past the tab own setting', () => {
		expect(assemble({ context: { autoRunHoldsTree: true, forceParallel: true } }).readOnly).toBe(
			false
		);
		expect(
			assemble({
				tab: { readOnlyMode: true },
				context: { autoRunHoldsTree: true, forceParallel: true },
			}).readOnly
		).toBe(true);
	});

	it('forces the readonly permission mode when read-only, else the tab mode, else full', () => {
		expect(
			assemble({ tab: { readOnlyMode: true, permissionMode: 'standard' } }).permissionMode
		).toBe('readonly');
		expect(assemble({ tab: { permissionMode: 'standard' } }).permissionMode).toBe('standard');
		expect(assemble().permissionMode).toBe('full');
	});

	it('drops bypass flags from the base arguments and adds the provider read-only arguments', () => {
		const turn = assemble({ tab: { readOnlyMode: true } });
		expect(turn.launch.args).not.toContain('--dangerously-skip-permissions');
		expect(turn.launch.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
		expect(turn.launch.readOnlyMode).toBe(true);
	});

	it('keeps the full-access flag when not read-only', () => {
		expect(assemble().launch.args).toContain('--dangerously-skip-permissions');
	});
});

describe('model and effort', () => {
	it('reads the live tab, then the agent', () => {
		expect(
			assemble({ agent: { customModel: 'sonnet' }, tab: { customModel: 'opus' } }).settings.model
		).toBe('opus');
		expect(assemble({ agent: { customModel: 'sonnet' } }).settings.model).toBe('sonnet');
		expect(
			assemble({ agent: { customEffort: 'low' }, tab: { customEffort: 'max' } }).settings.effort
		).toBe('max');
	});

	it('uses what a queued message froze, even where a field in it is undefined', () => {
		const turn = assemble({
			agent: { customModel: 'sonnet', customEffort: 'low' },
			tab: { customModel: 'opus' },
			message: { turnSettings: { effort: 'high' } },
		});
		expect(turn.settings).toEqual({ provider: 'claude-code', model: undefined, effort: 'high' });
		expect(turn.launch.args).not.toContain('--model');
		expect(turn.launch.args).toEqual(expect.arrayContaining(['--effort', 'high']));
	});

	it('runs a queued message on the live provider', () => {
		expect(assemble({ message: { turnSettings: {} } }).settings.provider).toBe('claude-code');
	});

	it('puts the model and effort into the arguments', () => {
		const turn = assemble({ agent: { customModel: 'sonnet', customEffort: 'low' } });
		expect(turn.launch.args).toEqual(
			expect.arrayContaining(['--model', 'sonnet', '--effort', 'low'])
		);
	});
});

describe('resume', () => {
	it('resumes the tab provider session', () => {
		const turn = assemble({ tab: { agentSessionId: 'sess-7' } });
		expect(turn.resumeSessionId).toBe('sess-7');
		expect(turn.launch.args).toEqual(expect.arrayContaining(['--resume', 'sess-7']));
		expect(turn.launch.isResuming).toBe(true);
	});

	it('starts a new session for a tab with none', () => {
		const turn = assemble({ tab: { agentSessionId: '' } });
		expect(turn.resumeSessionId).toBeUndefined();
		expect(turn.launch.args).not.toContain('--resume');
		expect(turn.launch.isResuming).toBe(false);
	});
});

describe('the system prompt', () => {
	it('substitutes template variables, with the tab id', () => {
		const turn = assemble({ tab: { id: 'tab-9' } });
		expect(turn.systemPrompt).toBe('SYSTEM for Test Agent (agent-1) tab tab-9');
	});

	it('goes out inline for Claude, as a flag, on every turn', () => {
		const turn = assemble({ tab: { agentSessionId: 'sess-1' } });
		expect(turn.systemPromptDelivery).toEqual({ via: 'flag' });
		const args = turn.launch.args;
		expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(turn.systemPrompt);
	});

	it('is embedded in the first turn of a provider with no flag', () => {
		const turn = assemble({ toolType: 'codex' });
		expect(turn.systemPromptDelivery).toEqual({ via: 'embed' });
		expect(turn.prompt).toBe(embedSystemPromptInPrompt(turn.systemPrompt!, 'hello'));
	});

	it('is skipped on a resume of a provider with no flag', () => {
		const turn = assemble({ toolType: 'codex', tab: { agentSessionId: 'th-1' } });
		expect(turn.systemPromptDelivery).toEqual({ via: 'skip-on-resume' });
		expect(turn.prompt).toBe('hello');
	});

	it('is left to the caller as a file on a Windows host', () => {
		const turn = assemble({ context: { isWindowsHost: true } });
		expect(turn.systemPromptDelivery).toEqual({ via: 'file' });
		expect(turn.launch.args).not.toContain('--append-system-prompt');
		expect(turn.launch.args).not.toContain('--append-system-prompt-file');
	});

	it('goes without when the template did not load', () => {
		const turn = assemble({ context: { prompts: { imageOnlyDefault: '' } } });
		expect(turn.systemPrompt).toBeUndefined();
		expect(turn.systemPromptDelivery).toEqual({ via: 'none' });
		expect(turn.launch.args).not.toContain('--append-system-prompt');
	});

	it('fills git branch, history path, conductor profile and the CLI path', () => {
		const turn = assemble({
			context: {
				gitBranch: 'feature/x',
				historyFilePath: '/h/agent-1.jsonl',
				conductorProfile: 'Pedram',
				maestroCliPath: '/opt/maestro-cli.js',
				prompts: {
					imageOnlyDefault: '',
					maestroSystem:
						'{{GIT_BRANCH}}|{{AGENT_HISTORY_PATH}}|{{CONDUCTOR_PROFILE}}|{{MAESTRO_CLI_PATH}}',
				},
			},
		});
		expect(turn.systemPrompt).toBe('feature/x|/h/agent-1.jsonl|Pedram|node "/opt/maestro-cli.js"');
	});

	it('appends the Pianola instructions for the manager agent only', () => {
		const prompts = {
			imageOnlyDefault: '',
			maestroSystem: 'BASE',
			pianolaSystem: 'MANAGER',
		};
		expect(assemble({ agent: { isPianola: true }, context: { prompts } }).systemPrompt).toBe(
			`BASE${SEP}MANAGER`
		);
		expect(assemble({ context: { prompts } }).systemPrompt).toBe('BASE');
	});

	it('drops the git branch and history path for an SSH agent (PA5)', () => {
		const turn = assemble({
			agent: { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } },
			context: {
				gitBranch: 'main',
				historyFilePath: '/h/agent-1.jsonl',
				prompts: {
					imageOnlyDefault: '',
					maestroSystem: '[{{GIT_BRANCH}}][{{AGENT_HISTORY_PATH}}]',
				},
			},
		});
		expect(turn.systemPrompt).toBe('[][]');
	});

	it('names the deprecated agent-level session id, not the tab one (F6)', () => {
		const turn = assemble({
			agent: { agentSessionId: 'legacy' },
			tab: { agentSessionId: 'tab-sess' },
			context: { prompts: { imageOnlyDefault: '', maestroSystem: '[{{AGENT_SESSION_ID}}]' } },
		});
		expect(turn.systemPrompt).toBe('[legacy]');
	});
});

describe('the Copilot preamble', () => {
	it('is prepended to a Copilot prompt on every turn, after the system prompt is embedded', () => {
		const turn = assemble({
			toolType: 'copilot-cli',
			context: { prompts: { imageOnlyDefault: '', maestroSystem: 'SYS', copilotPreamble: 'PRE' } },
		});
		expect(turn.prompt).toBe(`PRE\n\n${embedSystemPromptInPrompt('SYS', 'hello')}`);
	});
});

describe('arguments', () => {
	it('appends custom args after the provider options', () => {
		const turn = assemble({ agent: { customArgs: '--foo "a b"' } });
		expect(turn.launch.args).toEqual(expect.arrayContaining(['--foo', 'a b']));
		expect(turn.launch.args.indexOf('--foo')).toBeGreaterThan(turn.launch.args.indexOf('--print'));
	});

	it('grants additional directories through the provider flag', () => {
		const turn = assemble({
			agent: { additionalDirectories: [{ path: '/extra', read: true, write: true }] },
		});
		expect(turn.launch.args).toEqual(expect.arrayContaining(['--add-dir', '/extra']));
	});

	it('prepends a Codex working directory before the exec subcommand', () => {
		const turn = assemble({ toolType: 'codex' });
		expect(turn.launch.args.slice(0, 3)).toEqual(['-C', '/work/project', 'exec']);
	});

	it('takes the provider config options', () => {
		const turn = assemble({ context: { providerConfig: { model: 'haiku' } } });
		expect(turn.launch.args).toContain('haiku');
	});
});

describe('the launch request (PA2, PA8, PA9)', () => {
	it('launches on the desktop surface for a user turn', () => {
		const { launch } = assemble();
		expect(launch.surface).toBe('desktop');
		expect(launch.querySource).toBe('user');
		expect(launch.cwd).toBe('/work/project');
		expect(launch.command).toBe('/usr/local/bin/claude');
		expect(launch.remoteCommand).toBe('claude');
		expect(launch.prompt).toBe(assemble().prompt);
	});

	it('stamps the caller identity with the tab, and the data dir it serves', () => {
		const { launch } = assemble({ context: { userDataDir: '/data/maestro' } });
		expect(launch.maestroEnvVars).toEqual({
			MAESTRO_CALLER_AGENT_ID: 'agent-1',
			MAESTRO_CALLER_TAB_ID: 'tab-1',
			MAESTRO_USER_DATA: '/data/maestro',
		});
	});

	it('gives the Pianola manager the CLI script and its own id', () => {
		const { launch } = assemble({
			agent: { isPianola: true },
			context: { maestroCliPath: '/opt/maestro-cli.js' },
		});
		expect(launch.maestroEnvVars).toMatchObject({
			MAESTRO_CLI_JS: '/opt/maestro-cli.js',
			MAESTRO_AGENT_ID: 'agent-1',
		});
	});

	it('layers environment: global settings, provider config, the agent own vars', () => {
		const { launch } = assemble({
			agent: { customEnvVars: { A: 'agent' } },
			context: {
				globalEnvVars: { G: 'global' },
				providerConfig: { customEnvVars: { P: 'provider', A: 'provider' } },
			},
		});
		expect(launch.globalShellEnvVars).toEqual({ G: 'global' });
		expect(launch.agentCustomEnvVars).toEqual({ P: 'provider', A: 'provider' });
		expect(launch.sessionCustomEnvVars).toEqual({ A: 'agent' });
	});

	it('puts the directory of the binary in front of PATH for a local turn only', () => {
		expect(assemble().launch.extraPathDirs).toEqual(['/usr/local/bin']);
		expect(
			assemble({ agent: { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } } }).launch
				.extraPathDirs
		).toBeUndefined();
	});

	it('carries the SSH config and the remote command: the agent custom path, else the binary name', () => {
		const ssh = { enabled: true, remoteId: 'r1' };
		expect(assemble({ agent: { sessionSshRemoteConfig: ssh } }).launch).toMatchObject({
			sshRemoteConfig: ssh,
			remoteCommand: 'claude',
		});
		expect(
			assemble({ agent: { sessionSshRemoteConfig: ssh, customPath: '/remote/bin/claude' } }).launch
				.remoteCommand
		).toBe('/remote/bin/claude');
	});

	it('reports the context window for usage: the agent override, then the provider config', () => {
		expect(assemble({ agent: { customContextWindow: 123456 } }).contextWindow).toBe(123456);
		expect(assemble({ context: { providerConfig: { contextWindow: 5000 } } }).contextWindow).toBe(
			5000
		);
		expect(
			assemble({
				agent: { customContextWindow: 123456 },
				context: { providerConfig: { contextWindow: 5000 } },
			}).contextWindow
		).toBe(123456);
	});
});
