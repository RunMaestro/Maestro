/**
 * Conversation buffer - what has been said while a task takes shape.
 *
 * A Cappella used to treat every utterance as a command: you spoke, an agent was
 * chosen, a prompt was sent. That works for "run the tests" and fails for the way
 * people actually arrive at a request, which is a couple of sentences of thinking
 * out loud before anything is actually asked for.
 *
 * So the Conductor can now reply instead of dispatching, and this is the memory
 * that makes those replies coherent: each turn, both halves of the exchange, fed
 * back to the Brain so it can see the shape of the thing being worked out rather
 * than one sentence in isolation.
 *
 * Three properties, each of which was a way to get this wrong:
 *
 *   - **It is CLEARED on dispatch.** Once the task has been sent, the discussion
 *     that produced it is finished. Carrying it forward would make the next
 *     request arrive wearing the last one's context, which is how "now do the
 *     same for the other repo" becomes a second copy of the first job.
 *   - **It is capped by turns AND by characters.** A conversation feeds a model
 *     on every routing turn, so an uncapped one is a prompt that grows without
 *     limit and a routing latency that grows with it.
 *   - **It holds text, not decisions.** What the Brain needs is what was said. A
 *     buffer of `RouteDecision`s would tempt a later reader into re-dispatching
 *     one, which is exactly the bug the clearing rule above exists to prevent.
 */

/** Who said one line. */
export type ConversationRole = 'user' | 'conductor';

export interface ConversationTurn {
	role: ConversationRole;
	text: string;
}

export interface ConversationBufferConfig {
	/**
	 * Turns retained, counting both halves. Ten is about five exchanges, which is
	 * far more than the two or three it usually takes to land on a request.
	 */
	maxTurns: number;
	/**
	 * Total characters retained. The real guard: `maxTurns` alone lets ten
	 * rambling paragraphs through, and this is a prompt that a model reads on
	 * every routing turn.
	 */
	maxChars: number;
}

export const DEFAULT_CONVERSATION_BUFFER_CONFIG: ConversationBufferConfig = {
	maxTurns: 10,
	maxChars: 4_000,
};

export class ConversationBuffer {
	private readonly config: ConversationBufferConfig;
	private turns: ConversationTurn[] = [];

	constructor(config: Partial<ConversationBufferConfig> = {}) {
		this.config = {
			maxTurns: Math.max(0, config.maxTurns ?? DEFAULT_CONVERSATION_BUFFER_CONFIG.maxTurns),
			maxChars: Math.max(0, config.maxChars ?? DEFAULT_CONVERSATION_BUFFER_CONFIG.maxChars),
		};
	}

	/** True while something has been said that no agent has been told about. */
	get active(): boolean {
		return this.turns.length > 0;
	}

	/** The exchange so far, oldest first. A copy: callers must not mutate it. */
	get history(): ConversationTurn[] {
		return [...this.turns];
	}

	/** Record one half of the exchange. Empty text is ignored. */
	add(role: ConversationRole, text: string): void {
		const line = text.trim();
		if (!line) return;
		this.turns.push({ role, text: line });
		this.trim();
	}

	/**
	 * Forget the conversation.
	 *
	 * Called on dispatch, and whenever the floor closes. Both are the same fact:
	 * the discussion that was building toward a request is over.
	 */
	clear(): void {
		this.turns = [];
	}

	/** Oldest turns fall off first, by count and then by total size. */
	private trim(): void {
		if (this.turns.length > this.config.maxTurns) {
			this.turns = this.turns.slice(this.turns.length - this.config.maxTurns);
		}
		let total = this.turns.reduce((sum, turn) => sum + turn.text.length, 0);
		while (total > this.config.maxChars && this.turns.length > 1) {
			// Never below one turn: the thing just said is the least droppable part
			// of the context, even when it is long enough to blow the budget alone.
			total -= this.turns[0].text.length;
			this.turns.shift();
		}
	}
}
