/**
 * Shared data model for Did You Know? discovery tips.
 *
 * Tip ids are permanent: renaming one re-shows a tip everyone already dismissed.
 * The pinned list is a deliberate editorial choice, not an accident of array order.
 */
import type { UiSurfaceEncoreFlag } from './uiSurfaces';
import { shuffleWithSeed } from './shuffle';

export interface DidYouKnowTip {
	/** Stable kebab-case id persisted in the seen list. Never rename once shipped. */
	id: string;
	/** Feature name as spelled in the app. */
	title: string;
	/** One-sentence hook that works even if the body is never read. */
	headline: string;
	/** Two to four short paragraphs of plain text, without markdown. */
	body: string[];
	/** lucide-react export name, resolved by the card. */
	icon: string;
	/** Screenshot filename under src/renderer/assets/did-you-know/, cropped to the frame aperture aspect. Omit for an icon plate. */
	art?: string;
	/** Live element CSS selector, reusing data-tour attributes when a static image is less helpful. */
	spotlightSelector?: string;
	/** UiSurface.id used by the primary button. */
	surface?: string;
	/** Key in DEFAULT_SHORTCUTS / TAB_SHORTCUTS / FIXED_SHORTCUTS for the keystroke chip. */
	shortcutId?: string;
	/** Page under docs/ without .md, opened by the in-app Read more action. */
	docsSlug?: string;
	/** Example maestro-cli invocation displayed as a copyable code chip. */
	cli?: string;
	/** When disabled, the card offers Turn it on instead of Open it. */
	encore?: UiSurfaceEncoreFlag;
}

export const DID_YOU_KNOW_TIPS: readonly DidYouKnowTip[] = [
	{
		id: 'maestro-cue',
		title: 'Maestro Cue',
		headline: 'Your agents can start their own work.',
		body: [
			'Cue watches for things that happen (a file changing, a schedule firing, a GitHub PR opening, a task going unchecked) and dispatches a prompt to the agent you choose.',
			"Pipelines chain agents together, so one agent's finished work becomes another's trigger.",
			'It is configured per project in .maestro/cue.yaml, and the Pipeline Graph draws the whole topology.',
		],
		icon: 'Zap',
		surface: 'cue',
		shortcutId: 'openCue',
		docsSlug: 'maestro-cue',
		encore: 'maestroCue',
	},
	{
		id: 'auto-run',
		title: 'Auto Run',
		headline: 'Hand an agent a checklist and walk away.',
		body: [
			'Spec-driven Auto Run works a Markdown document of - [ ] tasks to completion, one fresh agent context per task, so nothing drifts.',
			'Goal-driven Auto Run takes a single sentence instead ("get coverage above 90%") and iterates until it is done or genuinely stuck.',
			'Both launch from the Auto Run panel or the CLI, and the Playbook Exchange has ready-made ones.',
		],
		icon: 'Play',
		docsSlug: 'autorun-playbooks',
		cli: 'maestro-cli auto-run <doc.md> --launch --agent <id>',
	},
	{
		id: 'cross-agent-mentions',
		title: 'Cross-Agent Mentions',
		headline: 'Ask another agent a question without leaving this one.',
		body: [
			'Type @ in the composer and pick another agent. It answers once, in the background, with no tab of its own and no unread badge.',
			'Use it when the agent in front of you needs something another agent already knows: a schema, a convention, what broke last night.',
		],
		icon: 'AtSign',
		spotlightSelector: '[data-tour="input-area"]',
	},
	{
		id: 'group-chat',
		title: 'Group Chat',
		headline: 'Let a moderator agent run the meeting.',
		body: [
			'A mention gets you one answer. A Group Chat appoints a moderator that keeps working on its own: routing the question, judging the replies, pushing back when one is thin.',
			"It threads one agent's answer into another's prompt, and goes as many rounds as the problem needs before handing you a synthesis.",
			'You stop being the router.',
		],
		icon: 'MessagesSquare',
		docsSlug: 'group-chat',
	},
	{
		id: 'remote-agents',
		title: 'Remote Agents',
		headline: 'An agent does not have to run on this machine.',
		body: [
			'Point an agent at an SSH remote and its process, its shell, and its file tree all live on that host, while the transcript stays here.',
			'Big builds run on the big machine and you keep the keyboard. Maestro wraps the spawn, so the agent behaves exactly as it does locally.',
		],
		icon: 'Server',
		docsSlug: 'ssh-remote-execution',
	},
	{
		id: 'remote-control',
		title: 'Remote Control',
		headline: 'You can take Maestro with you.',
		body: [
			'Click the OFFLINE button in the Left Bar header. It flips to LIVE and shows a QR code you can scan from your phone.',
			'You can read transcripts, send prompts, and switch tabs from a mobile browser.',
			'Add a Cloudflare tunnel to reach your agents from outside your network, not just the same WiFi.',
		],
		icon: 'TowerControl',
		docsSlug: 'remote-control',
		spotlightSelector: '[data-tour="remote-control"]',
	},
	{
		id: 'maestro-cli',
		title: 'Maestro CLI',
		headline: 'Your agents can drive Maestro itself.',
		body: [
			'Your agents know about maestro-cli and can use it to open files, browser tabs, or terminals, dispatch work to another agent, create an agent, or launch an Auto Run.',
			'You can let one agent hand a job to the fleet without copying anything between windows.',
		],
		icon: 'Terminal',
		docsSlug: 'cli',
		cli: 'maestro-cli dispatch <agent> "..." --background',
	},
	{
		id: 'git-worktrees',
		title: 'Git Worktrees',
		headline: 'Give every agent its own branch and its own checkout.',
		body: [
			'You can give each worktree agent an isolated checkout on its own branch, so two agents can work in the same repository at once without stepping on each other.',
			"When the work is done, ask your agent to commit it. Use the agent's git pill to review the diff or open a pull request.",
		],
		icon: 'GitBranch',
		docsSlug: 'git-worktrees',
	},
	{
		id: 'command-modes',
		title: 'Command Mode',
		headline: 'The composer is a shell too.',
		body: [
			"Type ! in an empty composer to run a shell command in your agent's working directory without leaving the conversation.",
			'Press ! again on an empty command line for AI command mode: describe what you want and get a command back to review before it runs.',
			'You can complete paths with Tab, exactly like a terminal.',
		],
		icon: 'ChevronRightSquare',
		docsSlug: 'general-usage',
		spotlightSelector: '[data-tour="input-area"]',
	},
	{
		id: 'execution-queue',
		title: 'Execution Queue',
		headline: 'Do not wait for the agent to finish before you type.',
		body: [
			'Send while an agent is busy and your message queues instead of bouncing. Queue several and they run in order, each into the tab you aimed it at.',
			'You can use the queue browser to reorder, hold, or edit queued messages before they reach the model.',
		],
		icon: 'ListOrdered',
		surface: 'queue-browser',
		shortcutId: 'executionQueue',
	},
];

export const PINNED_TIP_IDS: readonly string[] = [
	'maestro-cue',
	'auto-run',
	'cross-agent-mentions',
	'group-chat',
	'remote-agents',
];

/** Keep the editorial pins first, then shuffle the remaining tips reproducibly. */
export function buildTipOrder(
	seed: number,
	tips: readonly DidYouKnowTip[] = DID_YOU_KNOW_TIPS
): DidYouKnowTip[] {
	const pinned = PINNED_TIP_IDS.flatMap((id) => {
		const tip = getTipById(id, tips);
		return tip ? [tip] : [];
	});
	const rest = tips.filter((tip) => !PINNED_TIP_IDS.includes(tip.id));
	return [...pinned, ...shuffleWithSeed(rest, seed)];
}

/** Prefer the first unseen tip; after a full rotation, continue after the last tip. */
export function pickNextTip(
	order: readonly DidYouKnowTip[],
	seenIds: readonly string[],
	afterId?: string
): DidYouKnowTip | null {
	if (order.length === 0) return null;
	const seen = new Set(seenIds);
	const unseen = order.find((tip) => !seen.has(tip.id));
	if (unseen) return unseen;
	const afterIndex = order.findIndex((tip) => tip.id === afterId);
	return order[(afterIndex + 1) % order.length];
}

/** Pick uniformly from unseen tips, or all tips when none remain unseen. */
export function pickRandomTip(
	order: readonly DidYouKnowTip[],
	seenIds: readonly string[],
	random: () => number = Math.random
): DidYouKnowTip | null {
	if (order.length === 0) return null;
	const seen = new Set(seenIds);
	const unseen = order.filter((tip) => !seen.has(tip.id));
	const candidates = unseen.length > 0 ? unseen : order;
	return candidates[Math.floor(random() * candidates.length)];
}

/** Resolve a permanent tip id in the registry or an explicitly supplied catalog. */
export function getTipById(
	id: string,
	tips: readonly DidYouKnowTip[] = DID_YOU_KNOW_TIPS
): DidYouKnowTip | undefined {
	return tips.find((tip) => tip.id === id);
}
