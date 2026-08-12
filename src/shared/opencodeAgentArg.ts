/**
 * OpenCode `--agent` custom-arg helpers.
 *
 * OpenCode selects which primary agent handles a run with `opencode run --agent
 * <name>`. That covers built-ins (`build`, `plan`) as well as agents contributed
 * by plugins such as oh-my-opencode, which never appear in `opencode agent list`
 * but are still resolvable at run time.
 *
 * Maestro stores the flag inside the per-agent Custom CLI Args string rather
 * than in the provider-level agent config, because Custom CLI Args are
 * per-agent (`session.customArgs`) while config options are shared by every
 * agent using that provider. These helpers let the UI expose a dedicated
 * "OpenCode Agent" field that reads and rewrites just that one token, leaving
 * everything else in the string untouched.
 */

const AGENT_FLAG = '--agent';

/** Split a custom-args string into tokens, keeping quoted segments intact. */
function tokenize(customArgs: string): string[] {
	return customArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
}

/** Strip one layer of matching surrounding quotes from a token. */
function unquote(token: string): string {
	if (
		(token.startsWith('"') && token.endsWith('"')) ||
		(token.startsWith("'") && token.endsWith("'"))
	) {
		return token.slice(1, -1);
	}
	return token;
}

/** Wrap a value in double quotes when it contains whitespace. */
function quoteIfNeeded(value: string): string {
	return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Read the agent name from a custom-args string.
 * Recognizes both `--agent name` and `--agent=name`. Returns '' when unset.
 */
export function readOpenCodeAgentArg(customArgs: string | undefined): string {
	if (!customArgs) {
		return '';
	}

	const tokens = tokenize(customArgs);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.startsWith(`${AGENT_FLAG}=`)) {
			return unquote(token.slice(AGENT_FLAG.length + 1));
		}
		if (token === AGENT_FLAG && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
			return unquote(tokens[i + 1]);
		}
	}
	return '';
}

/**
 * Return `customArgs` with its agent name set to `agentName`, preserving every
 * other argument and its original spelling. An empty `agentName` removes the
 * flag entirely. When the flag isn't present yet it's appended.
 */
export function writeOpenCodeAgentArg(customArgs: string | undefined, agentName: string): string {
	const trimmedName = agentName.trim();
	const tokens = tokenize(customArgs ?? '');
	const kept: string[] = [];
	let replaced = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const isInlineFlag = token.startsWith(`${AGENT_FLAG}=`);
		const isPairedFlag =
			token === AGENT_FLAG && i + 1 < tokens.length && !tokens[i + 1].startsWith('-');

		if (!isInlineFlag && token !== AGENT_FLAG) {
			kept.push(token);
			continue;
		}

		// Consume the value token of a `--agent name` pair.
		if (isPairedFlag) {
			i++;
		}

		// Keep the first occurrence's position; drop any later duplicates.
		if (trimmedName && !replaced) {
			kept.push(AGENT_FLAG, quoteIfNeeded(trimmedName));
			replaced = true;
		}
	}

	if (trimmedName && !replaced) {
		kept.push(AGENT_FLAG, quoteIfNeeded(trimmedName));
	}

	return kept.join(' ');
}
