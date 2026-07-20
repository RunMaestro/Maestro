// View command - open / update / close cadenza views in the Maestro desktop
// app. Cadenzas are small agent-opened panels that display or track what the
// user is working on (a "Poke" primitive). Rides the same bridge as notify/toast.

import { readFileSync } from 'fs';
import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import {
	CADENZA_COLORS,
	CADENZA_VIEW_TYPES,
	type CadenzaColor,
	type CadenzaViewType,
	type CadenzaPayload,
	type CadenzaDecisionOption,
} from '../../shared/cadenza-types';

interface ViewOpenOptions {
	type?: string;
	title?: string;
	body?: string;
	bodyFile?: string;
	path?: string;
	lang?: string;
	color?: string;
	option?: string[];
	agent?: string;
	json?: boolean;
}

/** Parse repeatable `--option "Label:value"` into decision buttons. Bare strings
 *  (no colon) use the text as both label and reply value. */
function parseDecisionOptions(raw: string[] | undefined): CadenzaDecisionOption[] {
	if (!raw) return [];
	return raw.map((entry) => {
		const idx = entry.indexOf(':');
		if (idx === -1) return { label: entry, value: entry };
		return { label: entry.slice(0, idx), value: entry.slice(idx + 1) };
	});
}

/** Map a file extension to a syntax-highlighter language id (best-effort). */
function extToLang(filePath: string): string | undefined {
	const ext = filePath.split('.').pop()?.toLowerCase();
	const map: Record<string, string> = {
		ts: 'ts',
		tsx: 'tsx',
		js: 'js',
		jsx: 'jsx',
		mjs: 'js',
		cjs: 'js',
		py: 'python',
		rb: 'ruby',
		go: 'go',
		rs: 'rust',
		java: 'java',
		c: 'c',
		h: 'c',
		cpp: 'cpp',
		cc: 'cpp',
		cs: 'csharp',
		json: 'json',
		yaml: 'yaml',
		yml: 'yaml',
		toml: 'toml',
		md: 'markdown',
		sh: 'bash',
		bash: 'bash',
		zsh: 'bash',
		html: 'html',
		css: 'css',
		scss: 'scss',
		sql: 'sql',
		php: 'php',
		swift: 'swift',
		kt: 'kotlin',
	};
	return ext ? map[ext] : undefined;
}

interface ViewUpdateOptions {
	title?: string;
	body?: string;
	bodyFile?: string;
	path?: string;
	color?: string;
	json?: boolean;
}

/** Resolve body content from --body (inline) or --body-file (read a file). */
function resolveBody(body: string | undefined, bodyFile: string | undefined): string | undefined {
	if (bodyFile) {
		try {
			return readFileSync(bodyFile, 'utf8');
		} catch (error) {
			console.error(
				`Error: could not read --body-file: ${error instanceof Error ? error.message : String(error)}`
			);
			process.exit(1);
		}
	}
	return body;
}

interface ViewCloseOptions {
	json?: boolean;
}

/** Send one cadenza operation over the bridge and report the result. */
async function sendCadenza(
	payload: CadenzaPayload,
	json: boolean | undefined,
	successMessage: string
): Promise<void> {
	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'cadenza', ...payload },
				'cadenza_result'
			)
		);

		if (result.success) {
			if (json) console.log(JSON.stringify({ success: true, id: payload.id, op: payload.op }));
			else console.log(successMessage);
		} else {
			const error = result.error || 'Failed to update cadenza view';
			if (json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (json) console.log(JSON.stringify({ success: false, error: msg }));
		else console.error(`Error: ${msg}`);
		process.exit(1);
	}
}

/** Resolve --agent to a session id, exiting on an invalid id. Undefined when omitted. */
function resolveOptionalAgent(agent: string | undefined): string | undefined {
	if (!agent) return undefined;
	try {
		return resolveAgentId(agent);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

export async function cadenzaOpen(id: string, options: ViewOpenOptions): Promise<void> {
	if (!id.trim()) {
		console.error('Error: id cannot be empty');
		process.exit(1);
	}

	const viewType: CadenzaViewType = (options.type ?? 'tracker') as CadenzaViewType;
	if (!CADENZA_VIEW_TYPES.includes(viewType)) {
		console.error(`Error: --type must be one of: ${CADENZA_VIEW_TYPES.join(', ')}`);
		process.exit(1);
	}

	let color: CadenzaColor | undefined;
	if (options.color !== undefined) {
		const candidate = options.color.toLowerCase() as CadenzaColor;
		if (!CADENZA_COLORS.includes(candidate)) {
			console.error(`Error: --color must be one of: ${CADENZA_COLORS.join(', ')}`);
			process.exit(1);
		}
		color = candidate;
	}

	if ((viewType === 'file' || viewType === 'image') && !options.path) {
		console.error(`Error: --path is required for --type ${viewType}`);
		process.exit(1);
	}

	let body = resolveBody(options.body, options.bodyFile);
	if ((viewType === 'markdown' || viewType === 'view' || viewType === 'html') && !body) {
		console.error(`Error: --body or --body-file is required for --type ${viewType}`);
		process.exit(1);
	}

	// `code` renders as a syntax-highlighted snippet: pull from --path (a file) or
	// inline via --body/--body-file, then wrap in a fenced block for the Markdown
	// renderer. Language is explicit (--lang) or inferred from the file extension.
	if (viewType === 'code') {
		let code = body;
		let lang = options.lang;
		if (options.path) {
			try {
				code = readFileSync(options.path, 'utf8');
			} catch (error) {
				console.error(
					`Error: could not read --path: ${error instanceof Error ? error.message : String(error)}`
				);
				process.exit(1);
			}
			if (!lang) lang = extToLang(options.path);
		}
		if (!code) {
			console.error('Error: --type code requires --path, --body, or --body-file');
			process.exit(1);
		}
		// Fence longer than any backtick run inside the code, so displaying a file
		// that itself contains ``` cannot close the fence early.
		const longestRun = code.match(/`+/g)?.reduce((m, r) => Math.max(m, r.length), 0) ?? 0;
		const fence = '`'.repeat(Math.max(3, longestRun + 1));
		body = `${fence}${lang ?? ''}\n${code}\n${fence}`;
	}

	const sessionId = resolveOptionalAgent(options.agent);
	if (viewType === 'file' && !sessionId && !options.json) {
		// A file cadenza without an agent still displays, but can't expand into a
		// tab. Warn rather than fail so trackers-of-files stay easy to open. Kept
		// off stderr in --json mode so scripted callers see clean streams.
		console.error('Note: --agent recommended for --type file so the panel can expand into a tab');
	}

	// `decision` needs at least one option and an agent to reply to; each click
	// injects the option's value as a live prompt into that agent's session.
	let decisionOptions: CadenzaDecisionOption[] | undefined;
	if (viewType === 'decision') {
		decisionOptions = parseDecisionOptions(options.option);
		if (decisionOptions.length === 0) {
			console.error('Error: --type decision requires at least one --option "Label:value"');
			process.exit(1);
		}
		if (!sessionId) {
			console.error('Error: --agent is required for --type decision (the reply target)');
			process.exit(1);
		}
	}

	await sendCadenza(
		{
			op: 'open',
			id,
			viewType,
			title: options.title,
			body,
			path: options.path,
			options: decisionOptions,
			color,
			sessionId,
		},
		options.json,
		`Cadenza '${id}' opened`
	);
}

export async function cadenzaUpdate(id: string, options: ViewUpdateOptions): Promise<void> {
	if (!id.trim()) {
		console.error('Error: id cannot be empty');
		process.exit(1);
	}

	let color: CadenzaColor | undefined;
	if (options.color !== undefined) {
		const candidate = options.color.toLowerCase() as CadenzaColor;
		if (!CADENZA_COLORS.includes(candidate)) {
			console.error(`Error: --color must be one of: ${CADENZA_COLORS.join(', ')}`);
			process.exit(1);
		}
		color = candidate;
	}

	const body = resolveBody(options.body, options.bodyFile);

	await sendCadenza(
		{
			op: 'update',
			id,
			title: options.title,
			body,
			path: options.path,
			color,
		},
		options.json,
		`Cadenza '${id}' updated`
	);
}

export async function cadenzaClose(id: string, options: ViewCloseOptions): Promise<void> {
	if (!id.trim()) {
		console.error('Error: id cannot be empty');
		process.exit(1);
	}

	await sendCadenza({ op: 'close', id }, options.json, `Cadenza '${id}' closed`);
}
