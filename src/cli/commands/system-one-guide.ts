// `maestro-cli s1 guide` and `maestro-cli s1 examples` - what an agent reads
// before it asks System One anything.
//
//   guide            the playbook: when to reach for it, how to ask, how to read
//   guide --list     the topics
//   guide <topic>    depth on one topic
//   examples         the recipes
//   examples <name>  one recipe, ready to paste; `all` prints every one
//
// The text is core prompts (`SYSTEM_ONE_GUIDE_TOPICS`, `SYSTEM_ONE_EXAMPLES`),
// read through the CLI's prompt loader, so an agent reads what the user edited
// in Settings, Maestro Prompts. Nothing here talks to the desktop or to an
// engine: the guide can be read while System One is off, and the verbs it
// describes then refuse by name.

import {
	DEFAULT_SYSTEM_ONE_GUIDE_TOPIC,
	SYSTEM_ONE_EXAMPLES,
	SYSTEM_ONE_EXAMPLES_ALL,
	SYSTEM_ONE_GUIDE_TOPICS,
	findSystemOneExample,
	findSystemOneGuideTopic,
	systemOneExamplePromptId,
	systemOneGuidePromptId,
	type SystemOneGuideEntry,
} from '../../shared/local-models/system-one-guide';
import { ExitCode } from '../exit-codes';
import { getCliPrompt } from '../services/prompt-loader';
import {} from './system-one';
import { failCommand } from '../services/session-command';

interface GuideOptions {
	list?: boolean;
	json?: boolean;
}

interface ExamplesOptions {
	json?: boolean;
}

/** One topic or recipe with its text, as `--json` prints it. */
interface GuideDocument extends SystemOneGuideEntry {
	promptId: string;
	content: string;
}

/** The text of a guide prompt, or an exit that says which one could not be read. */
async function readGuidePrompt(promptId: string, json: boolean | undefined): Promise<string> {
	try {
		return (await getCliPrompt(promptId)).trimEnd();
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
}

/** `name  title`, one line per entry, the names in one column. */
function listLines(entries: readonly SystemOneGuideEntry[]): string[] {
	const width = Math.max(...entries.map((entry) => entry.name.length));
	return entries.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.title}`);
}

function names(entries: readonly SystemOneGuideEntry[]): string {
	return entries.map((entry) => entry.name).join(', ');
}

export async function systemOneGuide(
	topic: string | undefined,
	options: GuideOptions
): Promise<void> {
	const { json } = options;
	if (options.list) {
		if (json) {
			console.log(
				JSON.stringify({
					success: true,
					default: DEFAULT_SYSTEM_ONE_GUIDE_TOPIC,
					topics: SYSTEM_ONE_GUIDE_TOPICS.map((entry) => ({
						...entry,
						promptId: systemOneGuidePromptId(entry.name),
					})),
				})
			);
			return;
		}
		console.log(
			[
				'System One guide topics. `maestro-cli s1 guide <topic>` prints one; with no topic it prints `when`.',
				'',
				...listLines(SYSTEM_ONE_GUIDE_TOPICS),
				'',
				`Recipes: maestro-cli s1 examples   (${names(SYSTEM_ONE_EXAMPLES)})`,
			].join('\n')
		);
		return;
	}

	const entry = findSystemOneGuideTopic(topic ?? DEFAULT_SYSTEM_ONE_GUIDE_TOPIC);
	if (!entry) {
		failCommand(
			`Unknown guide topic "${topic}". Topics: ${names(SYSTEM_ONE_GUIDE_TOPICS)}.`,
			json,
			ExitCode.InvalidUsage
		);
	}
	const promptId = systemOneGuidePromptId(entry.name);
	const content = await readGuidePrompt(promptId, json);
	if (json) {
		const document: GuideDocument = { ...entry, promptId, content };
		console.log(JSON.stringify({ success: true, ...document }));
		return;
	}
	console.log(content);
}

export async function systemOneExamples(
	name: string | undefined,
	options: ExamplesOptions
): Promise<void> {
	const { json } = options;
	if (name === undefined) {
		if (json) {
			console.log(
				JSON.stringify({
					success: true,
					examples: SYSTEM_ONE_EXAMPLES.map((entry) => ({
						...entry,
						promptId: systemOneExamplePromptId(entry.name),
					})),
				})
			);
			return;
		}
		console.log(
			[
				`System One recipes, ready to paste. \`maestro-cli s1 examples <name>\` prints one; \`${SYSTEM_ONE_EXAMPLES_ALL}\` prints every one.`,
				'',
				...listLines(SYSTEM_ONE_EXAMPLES),
			].join('\n')
		);
		return;
	}

	const all = name.trim().toLowerCase() === SYSTEM_ONE_EXAMPLES_ALL;
	const found = all ? undefined : findSystemOneExample(name);
	if (!all && !found) {
		failCommand(
			`Unknown recipe "${name}". Recipes: ${names(SYSTEM_ONE_EXAMPLES)}, or ${SYSTEM_ONE_EXAMPLES_ALL}.`,
			json,
			ExitCode.InvalidUsage
		);
	}
	const entries = found ? [found] : SYSTEM_ONE_EXAMPLES;
	const documents: GuideDocument[] = [];
	for (const entry of entries) {
		const promptId = systemOneExamplePromptId(entry.name);
		documents.push({ ...entry, promptId, content: await readGuidePrompt(promptId, json) });
	}
	if (json) {
		console.log(JSON.stringify({ success: true, examples: documents }));
		return;
	}
	console.log(documents.map((document) => document.content).join('\n\n'));
}
