declare module '*.png' {
	const src: string;
	export default src;
}

declare module '*.jpg' {
	const src: string;
	export default src;
}

declare module '*.jpeg' {
	const src: string;
	export default src;
}

declare module '*.svg' {
	const src: string;
	export default src;
}

declare module '*.gif' {
	const src: string;
	export default src;
}

declare module '*.webp' {
	const src: string;
	export default src;
}

// Vite emits the referenced module as its own self-contained chunk and resolves
// the import to that chunk's URL. Used for AudioWorklet modules, which have to
// be fetched by URL rather than linked into the renderer bundle.
declare module '*?worker&url' {
	const src: string;
	export default src;
}

// Vite-injected build-time constants
declare const __APP_VERSION__: string;
declare const __COMMIT_HASH__: string;

// Splash screen global functions (defined in splash.js)
interface Window {
	__hideSplash?: () => void;
	__updateSplash?: (progress: number, text?: string) => void;
	__splashProgress?: () => number;
	__splashInterval?: ReturnType<typeof setInterval>;
}
