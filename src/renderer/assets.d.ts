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

// Vite-injected build-time constants
declare const __APP_VERSION__: string;

// Splash screen global functions (defined in index.html)
interface Window {
	__hideSplash?: () => void;
	__splashProgress?: () => number;
	__splashInterval?: ReturnType<typeof setInterval>;
}
