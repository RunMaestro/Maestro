/**
 * projectExploration.ts
 *
 * The canned turn behind the conversation screen's "Explore this project" chip.
 *
 * The wizard system prompt already tells the agent to examine the working
 * directory before its first response, but the conversation screen never sends
 * a first turn: the opening bubble is a canned question picked in the renderer,
 * so nothing runs until the user types. That left someone with an established
 * repo hand-writing a description of code the agent is sitting on top of (see
 * issue #1225). This is the one-click way to hand that work back.
 *
 * It stays an explicit chip rather than an automatic first turn because an
 * agent turn costs the user tokens, and a greenfield directory has nothing to
 * read - the chip makes the spend a choice.
 */

export const PROJECT_EXPLORATION_REQUEST =
	'Explore this project yourself instead of asking me to describe it. Read the README, ' +
	'any docs or planning files, the package/build manifests, and enough of the source to ' +
	'tell what this is. Then summarize back to me: what the project is, the stack it uses, ' +
	'how it is organized, and any planning or task-tracking system it already has. Name the ' +
	'files you actually read. Finish with whatever you still need from me that the repo ' +
	'could not tell you.';
