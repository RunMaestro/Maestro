/** Lightweight pub/sub store for streaming text so only the streaming item re-renders. */
export type StreamingStore = {
	get: () => string;
	set: (value: string) => void;
	subscribe: (listener: () => void) => () => void;
};

export function createStreamingStore(): StreamingStore {
	let text = '';
	const listeners = new Set<() => void>();
	return {
		get: () => text,
		set: (value: string) => {
			text = value;
			listeners.forEach((l) => l());
		},
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
