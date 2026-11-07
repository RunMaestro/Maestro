/**
 * The labeled prompts the embedding router ships with: real-looking coding
 * requests, each with the tier and effort a careful person would pick.
 *
 * The rubric (the same one a judge model is asked to score against):
 *
 *   - **low**: a lookup, a rename, a one-line fix, a question about code
 *     already in context.
 *   - **medium**: a change to a few files, or a bounded investigation.
 *   - **high**: a design decision, a multi-file refactor, a hard bug, or
 *     anything where a wrong answer is costly.
 *
 * Effort is how hard the model should think, and it does not always follow the
 * tier: a mechanical change across a few files is medium tier at low effort,
 * and a flaky test in one file is medium tier at high effort.
 *
 * These are the TUNE half of the routing set. The report half, which the
 * routing eval measures agreement on, is the test fixture
 * `src/__tests__/fixtures/model-routing-prompts.json`. A prompt belongs to one
 * half only: an example added here must never also be in the fixture, or the
 * eval reports on prompts the router has memorized.
 *
 * It is a typed module, not a JSON file read at run time, so the labels are
 * checked by the compiler and the list ships inside the main bundle with no
 * packaging step.
 */

import type { ModelRoutingExample } from './model-routing';

export const MODEL_ROUTING_EXAMPLES: readonly ModelRoutingExample[] = Object.freeze([
	// Low: lookups, renames, one-line fixes, questions about code in context.
	{ text: 'Rename the variable userList to users in this file.', tier: 'low', effort: 'low' },
	{
		text: 'What does this function return when the input array is empty?',
		tier: 'low',
		effort: 'low',
	},
	{ text: 'Fix the typo in the README heading.', tier: 'low', effort: 'low' },
	{ text: 'Which file defines the SessionStore interface?', tier: 'low', effort: 'low' },
	{ text: 'Bump the version in package.json to 2.4.1.', tier: 'low', effort: 'low' },
	{ text: "What's the difference between these two imports?", tier: 'low', effort: 'low' },
	{ text: 'Change the button label from Submit to Save.', tier: 'low', effort: 'low' },
	{
		text: 'Run the linter and tell me how many warnings there are.',
		tier: 'low',
		effort: 'low',
	},
	{
		text: 'Add a console.log before the return so I can see the value.',
		tier: 'low',
		effort: 'low',
	},
	{ text: 'Remove the unused import at the top of utils.ts.', tier: 'low', effort: 'low' },
	{ text: 'Show me the git log for the last five commits.', tier: 'low', effort: 'low' },
	{ text: 'Update the copyright year in the license header.', tier: 'low', effort: 'low' },
	{ text: 'Convert this arrow function to a named function.', tier: 'low', effort: 'low' },
	{
		text: 'Is there already a helper for formatting file sizes in this repo?',
		tier: 'low',
		effort: 'low',
	},
	{ text: "Commit what's staged with a short message and push.", tier: 'low', effort: 'low' },
	{
		text: 'Add a one-line comment explaining why this timeout is 30 seconds.',
		tier: 'low',
		effort: 'low',
	},
	{
		text: 'Explain what this regular expression matches, step by step.',
		tier: 'low',
		effort: 'medium',
	},
	{ text: 'Write unit tests for this small pure function.', tier: 'low', effort: 'medium' },
	{ text: 'Summarize what changed in this diff.', tier: 'low', effort: 'medium' },

	// Medium: a change to a few files, or a bounded investigation.
	{
		text: 'Add a --json flag to the export command and cover it with a test.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: "The settings modal doesn't close on Escape. Find out why and fix it.",
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'Add pagination to the users table: 25 rows per page with next and previous buttons.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'Thread a new optional timeout prop from the page component down to the fetch hook.',
		tier: 'medium',
		effort: 'low',
	},
	{
		text: 'Write tests for the date parsing module, including the edge cases around time zones.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'Why is this endpoint returning a 500 when the body is missing a name? Trace it and fix it.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'Add input validation to the signup form and show the errors inline.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'Extract the duplicated retry logic in these two services into a shared helper.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'This test is flaky about one run in ten. Work out why and make it deterministic.',
		tier: 'medium',
		effort: 'high',
	},
	{
		text: 'Add a dark mode toggle to the settings page and persist the choice.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'Update all the call sites of fetchUser to pass the new options object.',
		tier: 'medium',
		effort: 'low',
	},
	{
		text: 'Add a debounce to the search box and cancel stale requests.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'Upgrade the date library to the latest minor version and fix whatever breaks.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: "Add an endpoint that returns the current user's notification preferences.",
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'The CSV export drops rows with commas in the name. Fix the escaping and add a regression test.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: 'Add logging around the payment webhook handler so we can see failed signatures.',
		tier: 'medium',
		effort: 'low',
	},
	{
		text: 'Review this pull request and list anything that looks wrong.',
		tier: 'medium',
		effort: 'medium',
	},
	{
		text: "Figure out why the build got slower after last week's dependency changes.",
		tier: 'medium',
		effort: 'high',
	},
	{
		text: 'Replace the hand-rolled modal in the profile page with the shared Modal component.',
		tier: 'medium',
		effort: 'medium',
	},

	// High: design decisions, multi-file refactors, hard bugs, costly mistakes.
	{
		text: 'Design a plugin system for this app: how plugins are loaded, sandboxed and versioned.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Migrate the whole state layer from Redux to Zustand without breaking any feature.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'We lose messages when two clients reconnect at the same time. Find the race and fix it.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Plan the migration of our Postgres schema to multi-tenant with zero downtime.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Refactor the authentication flow to support SSO, and keep existing sessions valid.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Audit this service for security vulnerabilities and fix what you find.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: "The app's memory grows until it crashes after a few hours. Find the leak.",
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Should we split this monolith into services? Lay out the options and recommend one.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Rewrite the sync engine so it handles offline edits and conflict resolution.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: "Production data got corrupted by last night's migration. Work out what happened and how to repair it safely.",
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Design the caching strategy for the API: what to cache, where, and how to invalidate it.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Split this 3,000 line module into cohesive pieces and update every importer.',
		tier: 'high',
		effort: 'medium',
	},
	{
		text: 'Port the rendering pipeline from the main thread to a web worker.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Review the architecture of the billing system and tell me where it will break at ten times the load.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: "There's a deadlock somewhere in the job scheduler under heavy load. Track it down.",
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Implement end-to-end encryption for direct messages, including key rotation.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Convert the codebase from JavaScript to TypeScript in strict mode.',
		tier: 'high',
		effort: 'medium',
	},
	{
		text: 'Write the technical design document for real-time collaborative editing.',
		tier: 'high',
		effort: 'high',
	},
	{
		text: 'Rename the Session concept to Agent across the whole codebase, including persisted data and migrations.',
		tier: 'high',
		effort: 'medium',
	},
]);
