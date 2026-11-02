/** Native carriage is not authorship: quoted or pasted agent text is not human evidence. */
// Pasted summaries are rejected through end-of-turn; their internal user headings are not authorship.
const SUMMARY_START =
	/^(?:\s*#{1,6}\s*)?(?:(?:pasted\s+)?(?:agent|assistant|session|handoff|conversation|context|previous.session|continuation)\s+(?:summary|handoff|notes|transcript)|(?:summary|handoff)\s+(?:from|by)\s+(?:the\s+)?(?:agent|assistant)|This session is being continued from a previous conversation|The following is (?:a )?summary of (?:the |a )?(?:previous|prior) conversation|Summary of (?:the |a )?(?:previous|prior) (?:session|conversation))\b/i;
const NARRATION =
	/(?:^(?:assistant|agent|tool|system)\s*:|\b(?:the\s+)?(?:assistant|agent)\s+(?:said|wrote|reported|summari[sz]ed)\s*:|\b(?:pasted|quot(?:e|ed|ing))\s+(?:an?\s+|the\s+)?(?:agent|assistant)\b)/im;
/** An agent's own thinking block, not a human sentence that happens to use the word. */
const THINKING_MARKER =
	/^[ \t]*(?:\*\*agent\*\*|\*\*assistant\*\*|agent|assistant)?[ \t]*:?[ \t]*_thinking\b/im;
/**
 * A speaker label for the agent, in the transcript formats Maestro ingests.
 *
 * Providers render a carried-over agent turn differently, so the label is matched
 * in every shape seen in practice: markdown bold, a plain label, and a quoted JSON
 * form. The label must introduce the line, so a human sentence that mentions the
 * word "agent" is not mistaken for one.
 */
const AGENT_LABEL =
	/^[ \t]*(?:[*"']{0,2}(?:agent|assistant)[*"']{0,2}|["'][*]{0,2}(?:agent|assistant)[*]{0,2}["'])[ \t]*:[ \t]*(?:\n|$)/im;
/**
 * A tool call line, as rendered into a carried-over turn.
 *
 * A tool call is a name followed by its argument list. A bare arrow is not enough:
 * human prose and diagrams use arrows freely, so the call shape is required.
 */
const TOOL_CALL = /^[ \t]*[→⇒][ \t]*[a-zA-Z_][\w.-]*\s*\(/m;

/** Remove indirect spans; never infer that a summary was endorsed by its carrier. */
export function stripIndirectMemoryContent(text: string): string {
	let clean = text
		.replace(
			/<(summary|session[-_]summary|handoff|assistant|agent[-_]message|memories)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
			''
		)
		.replace(/^(?:[ \t]*>[^\n]*(?:\n|$))+/gm, '')
		.replace(
			/(?:^|\n)[ \t]*[\x60]{3}[^\n]*\n([\s\S]*?)(?:\n[ \t]*[\x60]{3}[^\n]*(?=\n|$)|$)/g,
			(block, body: string) =>
				SUMMARY_START.test(body.trim()) || NARRATION.test(body.trim()) ? '\n' : block
		);
	const output: string[] = [];
	let indirect = false;
	for (const line of clean.split('\n')) {
		if (SUMMARY_START.test(line.trim())) indirect = true;
		if (!indirect) output.push(line);
	}
	clean = output.join('\n');
	return clean
		.split(/\n\s*\n/)
		.filter((part) => !NARRATION.test(part.trim()))
		.join('\n\n')
		.trim();
}

/**
 * True when a user-carried turn contains the agent's own output rather than the
 * human's words.
 *
 * A user turn that carries an agent's reasoning trace, an agent-labelled block, or
 * a tool invocation is agent output in a user carrier. It is evidence of what the
 * agent did, not of what the human said, so it must not be stored as human
 * authorship.
 *
 * The signals are structural, not tied to one provider's format: a thinking marker,
 * a speaker label for the agent, and a tool trace. Each must introduce a line or
 * be a tool call marker, so ordinary human prose that mentions an agent, thinks,
 * or quotes a result is not mistaken for narration.
 */
export function containsAgentNarration(text: string): boolean {
	return THINKING_MARKER.test(text) || AGENT_LABEL.test(text) || TOOL_CALL.test(text);
}

/** Conservative evidence scope, not an invented expiration date or a learned preference. */
export function memoryEvidenceDurability(text: string): 'durable' | 'session' | 'time-bound' {
	if (
		/\b(?:just this once|one[- ](?:shot|off)|for (?:this|the) (?:test|run|session|task|turn|response|reply|experiment)|(?:this|the) (?:test|run|session|response|reply) only|progress (?:update|report)|report (?:your )?progress|temporary (?:test|instruction))\b/i.test(
			text
		)
	)
		return 'session';
	if (
		/\b(?:outage|down right now|currently (?:down|unavailable|failing)|temporarily|temporary|for now|right now|today|rate[- ]limit(?:ed|ing)?|(?:service|provider|endpoint|api|server) (?:is |was )?(?:down|unavailable|failing))\b/i.test(
			text
		)
	)
		return 'time-bound';
	return 'durable';
}
