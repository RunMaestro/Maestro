/**
 * Sentry noise filters — drop events we can never fix from our code.
 *
 * Categories suppressed:
 *   1. OS / filesystem environment errors (out of disk, broken pipe, locked files, ...)
 *   2. User-typed paths that don't exist (fs:stat/fs:readFile/shell:trashItem invokes)
 *   3. Native Chromium / Electron crashes (partition_alloc, blink::, rx::ContextGL, ...)
 *   4. External JS injection (antivirus / extensions corrupting our bundle on load)
 *   5. Network failures from the user being offline
 *   6. Shell-detection failures on machines without a usable login shell
 *
 * Anything matching `shouldDropSentryEvent` is noise we can't address from inside
 * the app — filtering it reduces alert fatigue without losing signal on real bugs.
 */

interface MinimalSentryEvent {
	message?: string;
	exception?: {
		values?: Array<{
			value?: string;
			type?: string;
		}>;
	};
}

/**
 * Returns true if the given Sentry event represents noise we cannot fix
 * (OS env issues, native crashes, user-typed bad paths, third-party JS injection).
 */
export function shouldDropSentryEvent(event: MinimalSentryEvent): boolean {
	const firstException = event.exception?.values?.[0];
	const value = firstException?.value ?? '';
	const type = firstException?.type ?? '';
	const message = event.message ?? '';
	const haystack = `${type}: ${value}\n${message}`;

	// ---- 1. OS / filesystem environment ----

	// Out of disk space — user environment, never a Maestro bug.
	if (/ENOSPC: no space left on device/i.test(haystack)) return true;

	// Broken pipe writing to a closed stdout/stderr (process torn down underneath us).
	// Two message shapes reach us: libuv fs-style writes surface as `EPIPE: broken pipe`,
	// while Node stream/socket writes (console.* into a stdout pipe whose reader already
	// exited) surface as `write EPIPE`. Both are the same unfixable teardown race, so
	// match both - the stream form is by far the more common one in the field.
	if (/EPIPE: broken pipe/i.test(haystack)) return true;
	if (/\b(write|read) EPIPE\b/i.test(haystack)) return true;

	// Windows rename races with antivirus / OneDrive holding the tmp file open.
	if (/EPERM: operation not permitted, rename /i.test(haystack)) return true;

	// EBUSY/EPERM lstat on Windows system files (pagefile.sys, hiberfil.sys, ...)
	// when users point watchers at C:\.
	if (
		/^(EBUSY|EPERM): [^,]+, lstat /i.test(value) &&
		/(pagefile\.sys|hiberfil\.sys|swapfile\.sys|DumpStack\.log|System Volume Information)/i.test(
			value
		)
	) {
		return true;
	}

	// Network filesystem (NFS / SMB / WSL mount) timed out during scandir.
	if (/ETIMEDOUT: connection timed out, scandir/i.test(haystack)) return true;

	// User pointed a file watcher at a directory served over WSL / network mount.
	if (/EISDIR: illegal operation on a directory, watch /i.test(haystack)) return true;

	// ---- 2. User-typed paths that don't exist (IPC handler rethrows) ----

	const ipcMatch = haystack.match(/Error invoking remote method '([^']+)'/);
	const ipcMethod = ipcMatch ? ipcMatch[1] : '';
	if (ipcMethod === 'fs:stat' || ipcMethod === 'fs:readFile') {
		if (
			/ENOENT: no such file or directory/i.test(haystack) ||
			/File not found:/i.test(haystack) ||
			/Path not found:/i.test(haystack) ||
			/EISDIR: illegal operation on a directory/i.test(haystack)
		) {
			return true;
		}
	}
	if (ipcMethod === 'shell:trashItem' || ipcMethod === 'shell:showItemInFolder') {
		if (/Path does not exist:/i.test(haystack)) return true;
	}

	// ENOSPC / EPERM / EACCES bubbling up through settings / sessions writes (same as
	// rule 1 but the IPC wrapper changes the message prefix). EACCES means the userData
	// file itself is not writable (broken permissions, security software holding it);
	// the persistence layer already degrades to a recoverable disk error the user sees,
	// and no code change on our side can grant the process write access.
	if (
		/Error invoking remote method '(settings:set|sessions:setActiveSessionId|sessions:setMany|sessions:setAll|history:add|settings:get)'/.test(
			haystack
		) &&
		(/ENOSPC: no space left on device/i.test(haystack) ||
			/EACCES: permission denied/i.test(haystack) ||
			/EPERM: operation not permitted, rename /i.test(haystack))
	) {
		return true;
	}

	// ---- 3. Native Chromium / Electron crashes (not our code) ----

	if (/^partition_alloc::/.test(type) || /^partition_alloc::/.test(value)) return true;
	if (/^crash_reporter::DumpWithoutCrashing/.test(type)) return true;
	if (/^rx::ContextGL::/.test(type)) return true;
	if (/^blink::/.test(type)) return true;
	if (/^base::internal::BindStateHolder::/.test(type)) return true;
	if (/^logging::LogMessage::/.test(type)) return true;
	if (/^electron::.*ElectronPermissionMessageProvider/.test(type)) return true;
	if (type === '__CFCheckCFInfoPACSignature') return true;
	if (/^x11::Connection::/.test(type)) return true;
	if (type === 'RaiseException') return true;
	if (type === '<unknown>' && !value) return true;

	// ---- 4. External JS injection (antivirus / extensions clobbering the bundle) ----
	// These appear as Splash-stage SyntaxErrors or ReferenceErrors in mangled minifier
	// names like `i`, which are not symbols we ship — something injected code into
	// the JS file at load time.
	if (/Renderer error:.*\[Splash\].*ReferenceError: i is not defined/i.test(haystack)) return true;
	if (/Renderer error:.*\[Splash\].*SyntaxError: missing \) after argument list/i.test(haystack))
		return true;
	if (/Renderer error:.*\[Splash\].*SyntaxError: Invalid or unexpected token/i.test(haystack))
		return true;
	if (/Renderer error:.*Uncaught SyntaxError: Invalid or unexpected token/i.test(haystack))
		return true;
	if (/Renderer error:.*Uncaught SyntaxError: missing \) after argument list/i.test(haystack))
		return true;
	if (/Renderer error:.*Uncaught SyntaxError: Unexpected (token|identifier) /i.test(haystack))
		return true;
	if (/Renderer error:.*\[Splash\].*TypeError: Cannot read properties of undefined/i.test(haystack))
		return true;

	// CSP blocks from user-installed proxies / extensions injecting third-party hosts.
	if (/Page failed to load: ERR_BLOCKED_BY_CSP/i.test(haystack)) return true;

	// ---- 5. Network failures (user offline) ----

	if (/MarketplaceFetchError: Network error fetching .*: fetch failed/i.test(haystack)) return true;
	if (
		/error connecting to api\.github\.com/i.test(haystack) ||
		/check your internet connection/i.test(haystack) ||
		/ENOTFOUND api\.github\.com/i.test(haystack)
	) {
		return true;
	}

	// ---- 6. Shell detection failures ----

	if (/Timed out reading shell PATH/i.test(haystack)) return true;
	if (/open terminal failed: not a terminal/i.test(haystack)) return true;

	return false;
}
