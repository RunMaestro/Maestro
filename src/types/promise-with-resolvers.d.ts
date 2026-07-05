// Ambient type for Promise.withResolvers (standardized in ES2024).
//
// The runtime (Electron 41 / Node 22) supports Promise.withResolvers, but the
// project's TypeScript `lib` is pinned to ES2020, so the built-in type isn't
// available. We declare the signature here (picked up via the `src/types/**/*`
// include in tsconfig.main.json / tsconfig.json) instead of bumping the whole
// `lib`, which would surface other unintended newer globals.
//
// Remove this shim once the project's `lib` advances to ES2024 or later.

interface PromiseWithResolvers<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

interface PromiseConstructor {
	withResolvers<T>(): PromiseWithResolvers<T>;
}
