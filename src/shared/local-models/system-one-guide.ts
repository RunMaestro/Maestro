// The System One guide an agent reads: its topics and its copy-paste recipes.
//
// This is the second of three levels an agent learns System One through. The
// Maestro system prompt says in a few lines that it exists and points here;
// `maestro-cli s1 guide` prints the playbook (the `when` topic), `s1 guide
// <topic>` goes deeper on one thing, and `s1 examples <name>` prints a recipe.
// The full reference is the third level.
//
// Each topic and each recipe is a core prompt, one file under `src/prompts/`,
// so a user can edit what their agents are taught in Settings, Maestro Prompts.
// This list is the ONE place a topic is declared: `CORE_PROMPTS` registers its
// prompt from here (`systemOneGuidePromptDefinitions`), and the CLI lists and
// resolves it from here. Adding a topic is a row here and a file there.

/** One guide topic, or one recipe: the word an agent types, and a line that says what it holds. */
export interface SystemOneGuideEntry {
	name: string;
	title: string;
}

/** The topic `maestro-cli s1 guide` prints when none is named: the playbook. */
export const DEFAULT_SYSTEM_ONE_GUIDE_TOPIC = 'when';

/** The guide's topics, in the order `s1 guide --list` prints them. */
export const SYSTEM_ONE_GUIDE_TOPICS: readonly SystemOneGuideEntry[] = [
	{
		name: 'when',
		title: 'The playbook: when to reach for System One, how to ask, how to read the answer',
	},
	{ name: 'questions', title: 'Writing instructions and criteria that work' },
	{ name: 'noul', title: 'noul (s1 yes): the probability that a yes or no statement is true' },
	{ name: 'choice', title: 'choice (s1 pick): one option from a set you define' },
	{ name: 'score', title: 'score (s1 rate): a position on a rubric you define' },
	{ name: 'state', title: 'State: what you hand the engine, and how to name its parts' },
	{ name: 'confidence', title: 'Probabilities, confidence, and when to act on them' },
	{ name: 'patterns', title: 'Patterns that turn single judgments into a workflow' },
	{ name: 'pitfalls', title: 'What System One gets wrong, and what to do instead' },
	{
		name: 'limits',
		title: 'Engines and calibration, request limits, the budget, the cache, exit codes',
	},
];

/** The recipes, in the order `s1 examples` lists them. */
export const SYSTEM_ONE_EXAMPLES: readonly SystemOneGuideEntry[] = [
	{ name: 'gutcheck', title: 'One yes or no, usable in a shell if' },
	{ name: 'triage', title: 'Classify one item and ask every follow-up in the same request' },
	{ name: 'rank', title: 'Rank or filter many candidates against a query' },
	{ name: 'verify', title: 'Check a claim against its source, or a draft against a rule' },
	{ name: 'screen', title: 'Screen untrusted text before you act on it' },
	{ name: 'dedupe', title: 'Find the items that say the same thing' },
];

/** What `s1 examples all` prints: every recipe. No recipe may take this name. */
export const SYSTEM_ONE_EXAMPLES_ALL = 'all';

/** The id of the core prompt that holds a guide topic. */
export function systemOneGuidePromptId(topic: string): string {
	return `system-one-guide-${topic}`;
}

/** The id of the core prompt that holds a recipe. */
export function systemOneExamplePromptId(name: string): string {
	return `system-one-example-${name}`;
}

/** The topic an agent named, or `undefined`. Case and surrounding space are forgiven. */
export function findSystemOneGuideTopic(topic: string): SystemOneGuideEntry | undefined {
	const wanted = topic.trim().toLowerCase();
	return SYSTEM_ONE_GUIDE_TOPICS.find((entry) => entry.name === wanted);
}

/** The recipe an agent named, or `undefined`. */
export function findSystemOneExample(name: string): SystemOneGuideEntry | undefined {
	const wanted = name.trim().toLowerCase();
	return SYSTEM_ONE_EXAMPLES.find((entry) => entry.name === wanted);
}

/** The category the guide's prompts are filed under in Settings, Maestro Prompts. */
export const SYSTEM_ONE_GUIDE_PROMPT_CATEGORY = 'system-one';

/**
 * The guide's prompts as `CORE_PROMPTS` registers them: one per topic, then one
 * per recipe. The shape is `PromptDefinition`'s, spelled here so this module
 * stays free of imports.
 */
export function systemOneGuidePromptDefinitions(): Array<{
	id: string;
	filename: string;
	description: string;
	category: string;
}> {
	const define = (id: string, description: string) => ({
		id,
		filename: `${id}.md`,
		description,
		category: SYSTEM_ONE_GUIDE_PROMPT_CATEGORY,
	});
	return [
		...SYSTEM_ONE_GUIDE_TOPICS.map((entry) =>
			define(
				systemOneGuidePromptId(entry.name),
				`System One guide for agents, printed by \`maestro-cli s1 guide${entry.name === DEFAULT_SYSTEM_ONE_GUIDE_TOPIC ? '' : ` ${entry.name}`}\`. ${entry.title}`
			)
		),
		...SYSTEM_ONE_EXAMPLES.map((entry) =>
			define(
				systemOneExamplePromptId(entry.name),
				`System One recipe for agents, printed by \`maestro-cli s1 examples ${entry.name}\`. ${entry.title}`
			)
		),
	];
}
