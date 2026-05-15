// Tails a JSONL file by polling for size growth and emitting parsed entries
// as they arrive. Used by the maestro-p wrapper's run mode to read claude's
// canonical session log instead of screen-scraping the TUI (which produces
// unreliable text and breaks on every TUI redesign).
//
// Why polling instead of chokidar's `change` events: claude appends to the
// jsonl in many small writes during a generation cycle. chokidar coalesces
// rapid changes and can fire `change` once for several writes, which would
// be fine if we read the whole file each time, but we want incremental reads
// keyed off the byte offset. Polling stat for size growth gives us a
// deterministic "is there new content?" check at a known cadence. 75ms is
// fast enough to feel snappy without burning CPU.
//
// Partial-line handling: a poll cycle can land in the middle of an entry
// claude is still flushing. The trailing fragment after the last newline is
// buffered until the next poll completes it. Without this, a chunk split
// mid-entry would emit a parse-error event for valid data.

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';

const DEFAULT_POLL_MS = 75;

export interface JsonlTailerOptions {
	filePath: string;
	pollMs?: number;
	// When true, the tailer skips whatever is already in the file at start()
	// and only emits entries written afterwards. Used by --resume so we don't
	// replay the entire prior conversation through stdout.
	skipExisting?: boolean;
}

// Emitted events (untyped on EventEmitter, documented here):
//   'entry'        (entry: unknown)            — parsed JSON object from a complete line
//   'parse-error'  (details: { line, error })  — line was non-empty but JSON.parse failed
//   'error'        (err: unknown)              — fs operation failed in an unrecoverable way
export class JsonlTailer extends EventEmitter {
	private readonly filePath: string;
	private readonly pollMs: number;
	private readonly skipExisting: boolean;
	private lastSize = 0;
	private buffer = '';
	private timer: NodeJS.Timeout | null = null;
	private stopped = false;
	private polling = false;
	private baselineApplied = false;

	constructor(options: JsonlTailerOptions) {
		super();
		this.filePath = options.filePath;
		this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		this.skipExisting = options.skipExisting ?? false;
	}

	start(): void {
		if (this.timer || this.stopped) return;
		// First poll runs immediately rather than waiting one interval — for
		// --resume this is where we set the size baseline, and for fresh
		// sessions any content already flushed gets picked up without delay.
		void this.poll();
		this.timer = setInterval(() => void this.poll(), this.pollMs);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async poll(): Promise<void> {
		// Re-entrancy guard: if a previous poll is still in flight (e.g., disk
		// is slow), skip this tick. The next interval will pick up where we
		// left off.
		if (this.stopped || this.polling) return;
		this.polling = true;
		try {
			let stat: Awaited<ReturnType<typeof fs.stat>>;
			try {
				stat = await fs.stat(this.filePath);
			} catch {
				// File doesn't exist yet — claude hasn't written its first
				// entry. Try again next tick.
				return;
			}

			// One-shot: on the very first successful stat under skipExisting,
			// jump the offset past whatever's already there.
			if (this.skipExisting && !this.baselineApplied) {
				this.lastSize = stat.size;
				this.baselineApplied = true;
				return;
			}

			if (stat.size <= this.lastSize) return;

			const fh = await fs.open(this.filePath, 'r');
			try {
				const len = stat.size - this.lastSize;
				const buf = Buffer.alloc(len);
				await fh.read(buf, 0, len, this.lastSize);
				this.lastSize = stat.size;
				this.buffer += buf.toString('utf-8');
			} finally {
				await fh.close();
			}

			const segments = this.buffer.split('\n');
			// The last segment is either the trailing partial line (no \n yet)
			// or an empty string if the buffer ended on a newline. Either way
			// it stays in the buffer for the next poll.
			this.buffer = segments.pop() ?? '';

			for (const line of segments) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					this.emit('entry', entry);
				} catch (err) {
					this.emit('parse-error', { line, error: err });
				}
			}
		} catch (err) {
			this.emit('error', err);
		} finally {
			this.polling = false;
		}
	}
}
