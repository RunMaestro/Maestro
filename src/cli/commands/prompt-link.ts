// Prompt Link commands - create, list and revoke `maestro://run/<token>` links.
// A link opens a new AI tab in one agent and sends one stored prompt there; the
// URL carries only a random token, so a forged link does nothing and a leaked
// one can only run the prompt it was made with. One-shot by default.
//
// Every verb rides the one `prompt_link_command` message and calls the same
// main-process service as the Prompt Links window. Creating a link needs the
// Prompt Links Encore Feature on; listing and revoking always work.

import { readFileSync } from 'fs';
import { withMaestroClient } from '../services/maestro-client';
import { failCommand, resolveAgentOrFail } from '../services/session-command';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { resolveCliPath } from '../utils/parse';
import { formatRelativeTime } from '../../shared/formatters';
import {
	describePromptLinkUses,
	parsePromptLinkExpiry,
	parsePromptLinkUses,
	promptLinkStatus,
	type PromptLinkCommandRequest,
	type PromptLinkCommandResult,
	type PromptLinkOpenMode,
	type PromptLinkPublic,
} from '../../shared/promptLinks';

export interface PromptLinkOutputOptions {
	json?: boolean;
	/** Accepted and ignored: managing links moves nothing on screen. */
	background?: boolean;
	/** Accepted and ignored: managing links moves nothing on screen. */
	focus?: boolean;
}

export interface PromptLinkCreateOptions extends PromptLinkOutputOptions {
	promptFile?: string;
	uses?: string;
	expires?: string;
	label?: string;
	open?: string;
}

export interface PromptLinkListOptions extends PromptLinkOutputOptions {
	all?: boolean;
}

async function sendPromptLinkCommand(
	request: PromptLinkCommandRequest,
	json?: boolean
): Promise<PromptLinkCommandResult> {
	let result: PromptLinkCommandResult;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<PromptLinkCommandResult>(
				{ type: 'prompt_link_command', ...request },
				'prompt_link_command_result'
			)
		);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
	if (!result.success) failCommand(result.error || 'Prompt link command failed', json);
	return result;
}

function oneLine(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function describe(link: PromptLinkPublic, now: number): string {
	const status = promptLinkStatus(link, now);
	const expiry =
		link.expiresAt === undefined
			? 'never expires'
			: status === 'expired'
				? `expired ${formatRelativeTime(link.expiresAt)}`
				: `expires ${new Date(link.expiresAt).toLocaleString()}`;
	const used = link.lastUsedAt ? `, last run ${formatRelativeTime(link.lastUsedAt)}` : '';
	const title = link.label ? `${link.label}  ` : '';
	return [
		`  ${link.id.slice(0, 8)}  ${title}[${status}]`,
		`      agent ${link.agentId}, opens in ${link.open}, ${describePromptLinkUses(link)}, ${expiry}${used}`,
		`      ${oneLine(link.prompt)}`,
	].join('\n');
}

/** `maestro-cli prompt-link create <agent> [prompt]` */
export async function promptLinkCreate(
	agent: string,
	promptArg: string | undefined,
	options: PromptLinkCreateOptions
): Promise<void> {
	const agentId = resolveAgentOrFail(agent, options.json);

	if (promptArg && options.promptFile) {
		failCommand('Pass the prompt as an argument or with --prompt-file, not both.', options.json);
	}
	let prompt = promptArg ?? '';
	if (options.promptFile) {
		try {
			prompt = readFileSync(resolveCliPath(options.promptFile), 'utf8');
		} catch (error) {
			failCommand(
				`Could not read --prompt-file: ${error instanceof Error ? error.message : String(error)}`,
				options.json
			);
		}
	}
	if (!prompt.trim()) failCommand('Give the prompt the link sends.', options.json);

	let maxUses: number | null = 1;
	if (options.uses !== undefined) {
		const parsed = parsePromptLinkUses(options.uses);
		if (parsed === undefined) {
			failCommand('--uses takes a whole number of 1 or more, or "unlimited".', options.json);
		}
		maxUses = parsed;
	}

	let expiresAt: number | undefined;
	if (options.expires !== undefined) {
		const parsed = parsePromptLinkExpiry(options.expires);
		if (parsed === undefined) {
			failCommand('--expires takes a duration like 12h, 7d, 30d, or "never".', options.json);
		}
		expiresAt = parsed ?? undefined;
	}

	let open: PromptLinkOpenMode = 'background';
	if (options.open !== undefined) {
		if (options.open !== 'background' && options.open !== 'foreground') {
			failCommand('--open takes "background" or "foreground".', options.json);
		}
		open = options.open as PromptLinkOpenMode;
	}

	const result = await sendPromptLinkCommand(
		{
			action: 'create',
			input: {
				agentId,
				prompt,
				maxUses,
				open,
				...(expiresAt !== undefined ? { expiresAt } : {}),
				...(options.label?.trim() ? { label: options.label.trim() } : {}),
			},
		},
		options.json
	);

	if (options.json) {
		console.log(JSON.stringify({ success: true, url: result.url, link: result.link }, null, 2));
		return;
	}
	// The URL alone on stdout, so `$(maestro-cli prompt-link create ...)` works.
	console.log(result.url);
	if (!isQuiet() && result.link) {
		console.error(
			formatSuccess(
				`Created prompt link ${result.link.id.slice(0, 8)} (${describePromptLinkUses(result.link)}). ` +
					'Copy the URL now: Maestro keeps only a hash of it.'
			)
		);
	}
}

/** `maestro-cli prompt-link list` */
export async function promptLinkList(options: PromptLinkListOptions): Promise<void> {
	const result = await sendPromptLinkCommand({ action: 'list' }, options.json);
	const now = Date.now();
	const all = result.links ?? [];
	const links = options.all ? all : all.filter((l) => promptLinkStatus(l, now) === 'active');
	if (options.json) {
		console.log(JSON.stringify({ success: true, links }, null, 2));
		return;
	}
	if (links.length === 0) {
		console.log(
			options.all || all.length === 0
				? 'No prompt links.'
				: `No active prompt links (${all.length} used, expired or revoked; --all shows them).`
		);
		return;
	}
	console.log(`${options.all ? 'Prompt links' : 'Active prompt links'} (${links.length}):`);
	for (const link of links) console.log(describe(link, now));
}

/** `maestro-cli prompt-link revoke <id>` - accepts a unique id prefix. */
export async function promptLinkRevoke(
	id: string,
	options: PromptLinkOutputOptions
): Promise<void> {
	const result = await sendPromptLinkCommand({ action: 'revoke', id }, options.json);
	if (options.json) {
		console.log(JSON.stringify({ success: true, link: result.link }, null, 2));
		return;
	}
	if (!isQuiet()) {
		console.log(formatSuccess(`Revoked prompt link ${result.link?.id.slice(0, 8) ?? id}.`));
	}
}
