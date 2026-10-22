#!/usr/bin/env node
// examples/maestro-lib-tui/tui.mjs

/**
 * A terminal chat with an AI coding agent, built on maestro-lib's public entry
 * and nothing else: Node's own modules plus the built package.
 *
 *   npm run build:maestro-lib
 *   node examples/maestro-lib-tui/tui.mjs [--agent <id>] [--cwd <dir>]
 *                                         [--model <model>] [--command <path>]
 *
 * Type a prompt to start a turn; the reply streams as it arrives. The next
 * prompt resumes the same conversation. Ctrl+C stops a running turn; a second
 * Ctrl+C, or /quit, exits. /help lists the commands.
 */

import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import {
	INTERACTIVE_STOP_GRACE_MS,
	MAESTRO_LIB_VERSION,
	getVisibleAgentDefinitions,
	planSessionTurn,
	runTurn,
} from '../../dist/maestro-lib/index.js';

const USAGE = `Usage: node tui.mjs [--agent <id>] [--cwd <dir>] [--model <model>] [--command <path>]`;

const HELP = `Commands:
  /agent [id]   list providers, or switch to one (starts a new conversation)
  /cwd <dir>    set the working folder (starts a new conversation)
  /model [name] set the model, or clear it to use the provider's default
  /new          start a new conversation
  /quit         exit (stops a running turn first)
Anything else is a prompt. Ctrl+C stops a running turn; a second Ctrl+C exits.`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

function parseArgs(argv) {
	const flags = {
		'--agent': 'agentId',
		'--cwd': 'cwd',
		'--model': 'model',
		'--command': 'command',
	};
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = flags[argv[index]];
		const value = argv[index + 1];
		if (!key) return { error: `Unknown option: ${argv[index]}` };
		if (value === undefined) return { error: `${argv[index]} needs a value` };
		options[key] = value;
	}
	return { options };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
	process.stderr.write(`${parsed.error}\n${USAGE}\n`);
	process.exit(2);
}

const state = {
	agentId: undefined,
	cwd: path.resolve(parsed.options.cwd ?? process.cwd()),
	model: parsed.options.model,
	/** The binary to start for the chosen provider, instead of looking it up. */
	command: parsed.options.command,
	/** The provider session the next prompt continues, as the last turn returned it. */
	sessionId: undefined,
	/** The turn in flight: `{ handle, completed }` from `runTurn`. */
	running: undefined,
	/** A Ctrl+C was pressed and the next one exits. */
	exitArmed: false,
	quitting: false,
};

const out = (text) => process.stdout.write(text);
const line = (text = '') => out(`${text}\n`);

/** Ask the library whether a provider can run a turn here, without starting anything. */
async function availability(agentId, command) {
	const planned = await planSessionTurn({ agentId, cwd: state.cwd, prompt: '', command });
	return planned.ok ? { ok: true } : { ok: false, error: planned.error };
}

async function listProviders() {
	const providers = [];
	for (const definition of getVisibleAgentDefinitions()) {
		const status = await availability(
			definition.id,
			definition.id === state.agentId ? state.command : undefined
		);
		providers.push({ id: definition.id, name: definition.name, ...status });
	}
	for (const provider of providers) {
		const marker = provider.id === state.agentId ? green('*') : ' ';
		const detail = provider.ok ? green('ready') : dim(provider.error);
		line(`${marker} ${provider.id.padEnd(16)} ${detail}`);
	}
	return providers;
}

async function selectAgent(agentId) {
	const status = await availability(agentId, state.command);
	if (!status.ok) {
		line(red(status.error));
		return false;
	}
	state.agentId = agentId;
	state.sessionId = undefined;
	line(`Provider: ${bold(agentId)}`);
	return true;
}

let inputClosed = false;

function showPrompt() {
	if (inputClosed || state.quitting) return;
	rl.setPrompt(promptLabel());
	rl.prompt();
}

function promptLabel() {
	const session = state.sessionId ? dim(` resuming ${state.sessionId}`) : dim(' new');
	return `${cyan(state.agentId ?? 'no provider')}${session} ${bold('>')} `;
}

function showEvent(event, turn) {
	switch (event.type) {
		case 'text':
			if (event.isReasoning || !event.text) return;
			turn.streamed = true;
			out(event.text);
			return;
		case 'result':
			// Providers that stream text repeat it in their result; the others send
			// their answer here only.
			if (turn.streamed || !event.text) return;
			out(`${event.text}\n`);
			return;
		case 'tool_use':
			if (event.toolName) line(dim(`\n[tool ${event.toolName}]`));
			return;
		case 'error':
			if (event.text) line(red(`\n[error] ${event.text}`));
			return;
		default:
			return;
	}
}

function describeUsage(usage) {
	if (!usage) return 'no usage reported';
	const parts = [`${usage.inputTokens} in`, `${usage.outputTokens} out`];
	if (usage.cacheReadInputTokens) parts.push(`${usage.cacheReadInputTokens} cache read`);
	if (usage.totalCostUsd) parts.push(`$${usage.totalCostUsd.toFixed(4)}`);
	return parts.join(', ');
}

async function sendPrompt(prompt) {
	const planned = await planSessionTurn({
		agentId: state.agentId,
		cwd: state.cwd,
		prompt,
		model: state.model,
		command: state.command,
		resumeSessionId: state.sessionId,
	});
	if (!planned.ok) {
		line(red(planned.error));
		return;
	}

	const turn = { streamed: false };
	state.running = runTurn(
		planned.spec,
		{
			agentId: state.agentId,
			sessionId: 'maestro-lib-tui',
			stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
		},
		{
			onStarted: (pid) =>
				line(dim(`[${planned.resuming ? 'resuming' : 'started'}, pid ${pid ?? 'unknown'}]`)),
			onEvent: (event) => showEvent(event, turn),
		}
	);

	const done = await state.running.completed;
	state.running = undefined;
	if (turn.streamed) line();
	if (!turn.streamed && done.answerText === undefined && done.outcome !== 'interrupted') {
		line(dim('(no answer)'));
	}

	const colorFor = { completed: green, 'completed-with-warning': yellow, interrupted: yellow };
	const outcome = (colorFor[done.outcome] ?? red)(done.outcome);
	line(`${dim('[')}${outcome}${dim(`] ${describeUsage(done.usage)}`)}`);
	if (done.error) line(red(done.error.message));
	if (done.sessionId) {
		state.sessionId = done.sessionId;
		line(dim(`[session ${done.sessionId}]`));
	}
}

async function quit() {
	if (state.quitting) return;
	state.quitting = true;
	const running = state.running;
	if (running) {
		// Leaving now: every stop stage at once, and wait for the process tree to go.
		running.handle.terminateNow({ blocking: true });
		await running.completed;
	}
	if (!inputClosed) rl.close();
	process.exit(0);
}

function onInterrupt() {
	const running = state.running;
	if (running && !running.handle.stopRequested()) {
		line(yellow('\n[stopping; Ctrl+C again to exit]'));
		state.exitArmed = true;
		running.handle.interrupt();
		return;
	}
	if (running || state.exitArmed) {
		void quit();
		return;
	}
	state.exitArmed = true;
	line(dim('\n(Ctrl+C again, or /quit, to exit)'));
	showPrompt();
}

async function runCommand(text) {
	const [name, ...rest] = text.split(/\s+/);
	const arg = rest.join(' ');
	switch (name) {
		case '/quit':
		case '/exit':
			await quit();
			return;
		case '/help':
			line(HELP);
			return;
		case '/new':
			state.sessionId = undefined;
			line('New conversation.');
			return;
		case '/agent':
			if (arg) await selectAgent(arg);
			else await listProviders();
			return;
		case '/cwd':
			if (!arg) {
				line(state.cwd);
				return;
			}
			state.cwd = path.resolve(state.cwd, arg);
			state.sessionId = undefined;
			line(`Working folder: ${state.cwd}`);
			return;
		case '/model':
			state.model = arg || undefined;
			line(`Model: ${state.model ?? "the provider's default"}`);
			return;
		default:
			line(red(`Unknown command ${name}. /help lists them.`));
	}
}

async function handleLine(input) {
	const text = input.trim();
	state.exitArmed = false;
	if (state.quitting) return;
	if (text.startsWith('/')) await runCommand(text);
	else if (text && !state.agentId) line(red('Pick a provider first: /agent <id>'));
	else if (text) await sendPrompt(text);
	showPrompt();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', onInterrupt);
process.on('SIGINT', onInterrupt);

async function start() {
	line(bold(`maestro-lib ${MAESTRO_LIB_VERSION} terminal`));
	line(dim(`Working folder: ${state.cwd}`));
	const requested = parsed.options.agentId;
	if (requested) {
		await selectAgent(requested);
	} else {
		const providers = await listProviders();
		const ready = providers.find((provider) => provider.ok);
		if (ready) await selectAgent(ready.id);
		else line(red('No provider can run here. Install one, then /agent <id>.'));
	}
	line(dim('/help lists the commands.'));
	showPrompt();
}

// Lines are handled one at a time, in order, after startup: what is typed
// during a turn runs after it. /quit acts at once, even mid-turn, as Ctrl+C does.
let queue = start();
rl.on('line', (input) => {
	const text = input.trim();
	if (state.running && (text === '/quit' || text === '/exit')) {
		void quit();
		return;
	}
	queue = queue.then(() => handleLine(input));
});
// End of input: finish what was asked, then leave.
rl.on('close', () => {
	inputClosed = true;
	void queue.then(() => quit());
});
