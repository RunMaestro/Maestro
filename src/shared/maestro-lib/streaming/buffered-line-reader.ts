/**
 * Buffered line reader - maestro-lib Part Two's "buffered wrapper".
 *
 * Generalizes the chunk-to-frame buffering that stream-json parsing already
 * does ad hoc per call site. Today's newline-delimited case lives inline in
 * `StdoutHandler.handleStreamJsonData` (`StdoutHandler.ts:431-432`: append
 * the chunk, split on '\n', pop the last (possibly incomplete) segment back
 * as the remainder). This module is that same logic as a standalone,
 * transport-agnostic, unit-testable primitive, plus:
 *
 *  - a pluggable frame extractor, so a provider whose framing is not
 *    newline-delimited (Copilot's concatenated-JSON-object extraction via
 *    `extractConcatenatedJsonObjects`, `StdoutHandler.ts:417-419`) can reuse
 *    this class's buffering/flush/safety-net behavior without this module
 *    reimplementing Copilot's own extraction algorithm; and
 *  - an opt-in max-buffer-length safety net, generalizing the protection
 *    Copilot alone has today (`resetOversizedCopilotJsonBuffer`,
 *    `StdoutHandler.ts:249-268`) to any transport that wants it.
 *
 * Per the turn contract's "one contract, more than one transport" section:
 * this is the piece a raw stdout/PTY stream needs (arbitrary chunk
 * boundaries -> complete parseable frames). A pre-framed transport (SSE)
 * does not need to go through this at all - it can hand parsed events
 * straight to the shared pipeline. Do not route an already-framed transport
 * through this class just because it exists.
 *
 * This module does not decode ANSI escapes, parse JSON, or know anything
 * about a provider's wire format - callers strip control sequences (e.g.
 * `stripAllAnsiCodes`) and parse frames themselves.
 */

export interface FrameExtractionResult {
	/** Complete frames found in `buffer`, in arrival order. */
	frames: string[];
	/** Whatever's left after the last complete frame - fed back in on the next push. */
	remainder: string;
}

export type FrameExtractor = (buffer: string) => FrameExtractionResult;

export interface BufferedLineReaderOptions {
	/**
	 * Maximum buffer length before unparsed content is dropped to avoid
	 * unbounded memory growth from a pathological stream that never produces
	 * a complete frame. Undefined (the default) means no limit, matching
	 * every current transport except Copilot's, which already caps at
	 * `MAX_COPILOT_JSON_BUFFER_LENGTH`. The cap is checked AFTER extracting
	 * whatever complete frames are already available, and applies only to
	 * the leftover remainder - so a push that both completes several frames
	 * and leaves an oversized unparsed tail still returns those frames; only
	 * the stuck remainder is dropped. Matches Copilot's existing behavior
	 * (`resetOversizedCopilotJsonBuffer` runs after `extractConcatenatedJsonObjects`,
	 * on the remainder alone).
	 */
	maxBufferLength?: number;
	/**
	 * Called with the dropped length when `maxBufferLength` trips. Dropping is
	 * silent data loss otherwise, and the desktop handler that this cap mirrors
	 * logs the same event (`resetOversizedCopilotJsonBuffer`). Optional so a
	 * caller with no logger can omit it.
	 */
	onOversized?: (droppedLength: number) => void;
	/**
	 * How to split accumulated text into complete frames plus a remainder.
	 * Defaults to newline-delimited splitting. Pass a custom extractor for
	 * non-newline framing (see the module doc comment).
	 */
	extractFrames?: FrameExtractor;
}

function defaultNewlineFrameExtractor(buffer: string): FrameExtractionResult {
	const lines = buffer.split('\n');
	const remainder = lines.pop() ?? '';
	return { frames: lines, remainder };
}

/**
 * Accumulates chunks from a stream that does not respect frame boundaries
 * and yields complete frames as they become available.
 */
export class BufferedLineReader {
	private buffer = '';
	private readonly maxBufferLength: number | undefined;
	private readonly extractFrames: FrameExtractor;
	private readonly onOversized: ((droppedLength: number) => void) | undefined;

	constructor(options: BufferedLineReaderOptions = {}) {
		this.maxBufferLength = options.maxBufferLength;
		this.extractFrames = options.extractFrames ?? defaultNewlineFrameExtractor;
		this.onOversized = options.onOversized;
	}

	/**
	 * Feed a raw chunk. Returns the complete, non-blank frames it produced,
	 * if any - partial trailing content is retained internally for the next
	 * call. Blank frames (whitespace-only) are dropped, matching
	 * `StdoutHandler.ts:435`'s `if (!line.trim()) continue`.
	 */
	push(chunk: string): string[] {
		this.buffer += chunk;

		// Extract BEFORE checking the length cap, not after. A capped reader
		// that checked the cap on the raw buffer first would drop every frame
		// in a chunk merely because the chunk (frames plus remainder) happened
		// to exceed the cap - a burst containing many small complete frames is
		// exactly the case that shouldn't be punished. The cap exists to bound
		// unparsed, stuck content (a stream that never produces a delimiter),
		// so it only ever applies to what's left AFTER extraction, matching
		// Copilot's existing behavior (`resetOversizedCopilotJsonBuffer` runs
		// after `extractConcatenatedJsonObjects`, on the remainder alone -
		// StdoutHandler.ts:417-419).
		const { frames, remainder } = this.extractFrames(this.buffer);
		this.buffer = remainder;

		if (this.maxBufferLength !== undefined && this.buffer.length > this.maxBufferLength) {
			const droppedLength = this.buffer.length;
			this.buffer = '';
			this.onOversized?.(droppedLength);
		}

		return frames.filter((frame) => frame.trim().length > 0);
	}

	/**
	 * Flush whatever remains in the buffer as a final frame and clear
	 * internal state. Mirrors the exit-time flush of a trailing line with no
	 * newline (`ExitHandler.ts:143-150`). Returns `undefined` when nothing
	 * but whitespace remains, so a caller can skip parsing an empty flush.
	 */
	flush(): string | undefined {
		const remaining = this.buffer.trim();
		this.buffer = '';
		return remaining || undefined;
	}

	/** True when no partial content is pending. */
	get isEmpty(): boolean {
		return this.buffer.length === 0;
	}
}
