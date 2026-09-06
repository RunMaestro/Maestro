/**
 * focusPlacement - who gets to move the Maestro view, and how that is asked for.
 *
 * The rule this module encodes: **focus belongs to the human operator.** An
 * agent may create a surface; it may not decide the human should be looking at
 * it. A tab that opens in the background costs the human one click if they
 * wanted it. A tab that steals the viewport costs them their place mid-keystroke,
 * and they usually cannot tell which of thirty agents took it.
 *
 * `background: true` means exactly this, everywhere:
 *
 *   - the active AGENT does not change, and
 *   - the active TAB inside any agent does not change.
 *
 * The surface is still created and still reachable - it lands in the tab bar the
 * way a browser opens a background tab. "Created but invisible" is a different
 * bug and must never pass as background placement.
 *
 * ## `--background` is ADDITIVE. No verb's default changes.
 *
 * The defect being fixed is that an agent which wants to be polite has no way to
 * ask, on seven of nine verbs. It is NOT that the verbs focus. Every verb keeps
 * the behaviour it has today when the flag is absent, so no existing script,
 * playbook, Cue prompt, or muscle-memory invocation changes.
 *
 * That makes the protocol rule dead simple, and deliberately so: **absent means
 * today's behaviour.** `readBackgroundField` therefore returns true only for a
 * literal `true`. Anything else - absent, null, `'yes'`, `1` - is not an opt-in.
 * Writing `!== false` anywhere in this path would invert that and silently stop
 * a verb from focusing, which is the single most likely way this change breaks.
 *
 * A future major can revisit making background the default. Shipping the flag is
 * the prerequisite either way: a default flip needs the escape hatch to already
 * exist. That is why `--focus` ships on every verb even where it currently
 * describes the default.
 *
 * ## Verbs that are allowed to move the view
 *
 * `select_session` (focus-agent, send --tab), `open_modal` (open) and
 * `open_document_graph` (open-graph) exist TO move the view - the caller named
 * that intent, and the graph is a full-window overlay whose only effect IS being
 * looked at, so "background" there would mean "do nothing". They are deliberately
 * absent from this table and must stay that way.
 *
 * ## Verbs that move nothing already
 *
 * `refresh-files` renders no notice and moves no selection - the panel it
 * refreshes is only drawn for the agent already on screen. It still ACCEPTS
 * `--background` (see `isAlreadyQuietVerb`) so the flag is safe to pass on every
 * verb an agent might reach for, which is what makes "pass --background by
 * default" teachable as one rule instead of a lookup table.
 */

/**
 * The CLI-side default for each verb that can move the view: what `background`
 * resolves to when the caller passes neither flag.
 *
 * Keyed by VERB, not by protocol message, because the two are not one-to-one.
 * `tab new --prompt` and `dispatch --new-tab` both send `new_ai_tab_with_prompt`
 * and disagree: `tab new` focuses today, `dispatch --new-tab` has been
 * background-by-default since it shipped. Keying by message would force one of
 * them to change behaviour, which is the thing this table exists to prevent.
 */
export const CLI_BACKGROUND_DEFAULTS = {
	/** maestro-cli open-file - focuses today. */
	'open-file': false,
	/** maestro-cli open-terminal - focuses today. */
	'open-terminal': false,
	/** maestro-cli open-browser - focuses today; `--background` already existed. */
	'open-browser': false,
	/** maestro-cli tab new [--prompt] - focuses today. */
	'tab-new': false,
	/**
	 * maestro-cli dispatch --new-tab - the one verb that is ALREADY background by
	 * default, with `--focus` to opt out. Leaving it alone is the same
	 * no-default-changes rule as everything else here, not an exception to it.
	 */
	'dispatch-new-tab': true,
	/**
	 * maestro-cli dispatch (no --new-tab) - the `send_command` path, which selects
	 * the target agent today "for visual feedback".
	 *
	 * Keyed apart from `dispatch-new-tab` because the two disagree, which is the
	 * whole reason this table is keyed by verb: the same command name resolves to
	 * background when it creates a tab and to foreground when it writes to one.
	 */
	dispatch: false,
	/** maestro-cli create-agent - selects the new agent today. */
	'create-agent': false,
	/**
	 * maestro-cli create-worktree - selects the new agent today.
	 *
	 * When a message is passed, the follow-on `send_command` carries this SAME
	 * resolved bit rather than re-resolving as `dispatch`. Without that,
	 * `create-worktree --background <msg>` created the agent quietly and was then
	 * yanked to it one message later, which reads as the flag not working.
	 */
	'create-worktree': false,
	/**
	 * maestro-cli refresh-auto-run - switches to the target agent today.
	 *
	 * Like `switch-mode`, it creates nothing, so `--background` means "refresh the
	 * documents where they are rather than moving me to them". The refresh itself
	 * still happens either way.
	 */
	'refresh-auto-run': false,
	/**
	 * maestro-cli switch-mode - proceeds today.
	 *
	 * The one verb here that CREATES nothing: changing the rendered surface of the
	 * target agent IS its entire effect, so there is no background surface to
	 * leave behind. `--background` therefore means "skip it rather than move me",
	 * and only bites when the target is the agent on screen.
	 */
	'switch-mode': false,
} as const;

/** A CLI verb whose placement can be negotiated. */
export type BackgroundCapableVerb = keyof typeof CLI_BACKGROUND_DEFAULTS;

/** How the CLI's two flags arrive from commander. */
export interface BackgroundFlags {
	/** `--background` was passed. */
	background?: boolean;
	/** `--focus` was passed. Wins over `--background`, since it is the narrower ask. */
	focus?: boolean;
}

/**
 * Resolve a verb's flags into the `background` bit to put on the wire.
 *
 * `--focus` wins over `--background` when both are passed rather than erroring:
 * the pair is contradictory, and a script that somehow sends both is better
 * served by the option that asks for something specific than by a hard failure.
 */
export function resolveBackgroundFlag(
	flags: BackgroundFlags,
	verb: BackgroundCapableVerb
): boolean {
	if (flags.focus === true) return false;
	if (flags.background === true) return true;
	return CLI_BACKGROUND_DEFAULTS[verb];
}

/**
 * Read the `background` field off an incoming protocol message.
 *
 * Only a literal `true` is an opt-in. Absent, null, `'yes'`, `1` - none of those
 * are a caller asking for background placement, and every one of them must come
 * back false so the verb behaves exactly as it does today. Do NOT hand-roll
 * `message.background !== false` in a handler: that reads an absent field as an
 * opt-in and silently stops the verb from focusing.
 */
export function readBackgroundField(message: { background?: unknown }): boolean {
	return message.background === true;
}

/**
 * Read the legacy `switchToAgent` field off an `open_file_tab` message.
 *
 * `--no-switch` predates `--background` and is NOT a spelling of it. It
 * suppresses the AGENT switch and still activates the new tab inside the target
 * agent - so if you are already on that agent, your view still changes. It keeps
 * that meaning: folding it into `--background` would silently change behaviour
 * for everyone already passing it.
 *
 * Absent means true (switch), which is the historical default.
 */
export function readSwitchToAgentField(message: { switchToAgent?: unknown }): boolean {
	return message.switchToAgent !== false;
}

/**
 * Verbs that accept `--background` and do nothing with it, because they already
 * behave that way.
 *
 * This is not a placeholder for future behaviour. The guidance an agent is given
 * is "pass `--background` unless the user asked to be taken there", and a rule
 * with exceptions is a rule that gets applied wrong - commander rejects an
 * unknown option, so one verb that refuses the flag turns a polite habit into a
 * failed command. Accepting it here keeps the habit uniform and keeps the CLI
 * honest about which verbs could ever have disturbed the user.
 *
 * A verb belongs here only while it renders NO notice and moves NO selection. The
 * moment one grows either, it moves into `CLI_BACKGROUND_DEFAULTS` and the flag
 * starts meaning something - the surface stays the same, so nothing calling it
 * has to change.
 */
export const ALREADY_QUIET_VERBS = ['refresh-files'] as const;

/** A verb that accepts `--background` purely so the flag is always safe to pass. */
export type AlreadyQuietVerb = (typeof ALREADY_QUIET_VERBS)[number];

/** Whether `verb` accepts `--background` as an accepted no-op. */
export function isAlreadyQuietVerb(verb: string): verb is AlreadyQuietVerb {
	return (ALREADY_QUIET_VERBS as readonly string[]).includes(verb);
}
