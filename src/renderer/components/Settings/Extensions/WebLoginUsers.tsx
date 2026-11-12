/**
 * Web Login accounts, managed from the Web Login tile in Plugins.
 *
 * This desktop is the administrator and this pane is the only administration
 * surface: the `webLogin:*` channels behind every button here are refused over
 * the web-desktop bridge, so a signed-in browser can never create an account,
 * reset a password, or delete the account it is using.
 *
 * Two things the copy has to keep saying, because both are invisible from the
 * UI and expensive to learn the hard way:
 *
 *  1. Enabling the flag with ZERO accounts locks the web interface out - the
 *     gate is on, and nobody holds a credential that can pass it. That is why
 *     the empty state is a warning rather than a neutral "nothing here yet".
 *  2. The web interface is plain HTTP on the LAN, so a password typed into it
 *     travels in the clear. Login is a second factor on top of the URL token,
 *     not a transport guarantee.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Trash2, UserPlus, Power } from 'lucide-react';
import type { Theme } from '../../../types';
import { MiniBadge } from '../../ui/MiniBadge';
import { notifyToast } from '../../../stores/notificationStore';
import { formatRelativeTime } from '../../../../shared/formatters';
import {
	validateWebPassword,
	validateWebUsername,
	type WebUserPublic,
} from '../../../../shared/webLogin';

interface WebLoginUsersProps {
	theme: Theme;
}

/** The message a rejected IPC call should show, without the `Error:` wrapper. */
function errorText(err: unknown): string {
	if (err instanceof Error && err.message) {
		// Electron wraps a main-process throw as
		// "Error invoking remote method 'webLogin:createUser': Error: <message>".
		const tail = err.message.split(': Error: ').pop();
		return (tail ?? err.message).trim();
	}
	return String(err);
}

export function WebLoginUsers({ theme }: WebLoginUsersProps) {
	const [users, setUsers] = useState<WebUserPublic[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Add-account form.
	const [username, setUsername] = useState('');
	const [displayName, setDisplayName] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [createError, setCreateError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	// Per-row transient state. Only one row can be resetting or awaiting a
	// delete confirmation at a time - two open destructive prompts side by side
	// is how the wrong one gets clicked.
	const [resetId, setResetId] = useState<string | null>(null);
	const [resetPassword, setResetPassword] = useState('');
	const [resetConfirm, setResetConfirm] = useState('');
	const [resetError, setResetError] = useState<string | null>(null);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [rowBusyId, setRowBusyId] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const list = await window.maestro.webLogin.listUsers();
			setUsers(list);
			setLoadError(null);
		} catch (err) {
			setUsers([]);
			setLoadError(errorText(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const closeResetForm = useCallback(() => {
		setResetId(null);
		setResetPassword('');
		setResetConfirm('');
		setResetError(null);
	}, []);

	const createAccount = useCallback(async () => {
		// Validate locally first so the common mistakes answer instantly and in
		// the same words the store would have used.
		const usernameError = validateWebUsername(username);
		if (usernameError) {
			setCreateError(usernameError);
			return;
		}
		const passwordError = validateWebPassword(password);
		if (passwordError) {
			setCreateError(passwordError);
			return;
		}
		if (password !== confirm) {
			setCreateError('The two passwords do not match.');
			return;
		}
		setCreating(true);
		try {
			const created = await window.maestro.webLogin.createUser({
				username,
				password,
				...(displayName.trim() ? { displayName } : {}),
			});
			setUsername('');
			setDisplayName('');
			setPassword('');
			setConfirm('');
			setCreateError(null);
			await refresh();
			notifyToast({
				color: 'green',
				title: 'Web Login',
				message: `Added the account "${created.username}".`,
			});
		} catch (err) {
			setCreateError(errorText(err));
		} finally {
			setCreating(false);
		}
	}, [username, displayName, password, confirm, refresh]);

	const submitReset = useCallback(
		async (user: WebUserPublic) => {
			const passwordError = validateWebPassword(resetPassword);
			if (passwordError) {
				setResetError(passwordError);
				return;
			}
			if (resetPassword !== resetConfirm) {
				setResetError('The two passwords do not match.');
				return;
			}
			setRowBusyId(user.id);
			try {
				await window.maestro.webLogin.setPassword(user.id, resetPassword);
				closeResetForm();
				await refresh();
				notifyToast({
					color: 'green',
					title: 'Web Login',
					message: `Reset the password for "${user.username}". Any browser signed in as that account is signed out.`,
				});
			} catch (err) {
				setResetError(errorText(err));
			} finally {
				setRowBusyId(null);
			}
		},
		[resetPassword, resetConfirm, closeResetForm, refresh]
	);

	const toggleDisabled = useCallback(
		async (user: WebUserPublic) => {
			setRowBusyId(user.id);
			try {
				await window.maestro.webLogin.setDisabled(user.id, !user.disabled);
				await refresh();
				notifyToast({
					color: user.disabled ? 'green' : 'yellow',
					title: 'Web Login',
					message: user.disabled
						? `Enabled "${user.username}".`
						: `Disabled "${user.username}". Its history stays attributed to it.`,
				});
			} catch (err) {
				notifyToast({ color: 'red', title: 'Web Login', message: errorText(err) });
			} finally {
				setRowBusyId(null);
			}
		},
		[refresh]
	);

	const deleteAccount = useCallback(
		async (user: WebUserPublic) => {
			setRowBusyId(user.id);
			try {
				await window.maestro.webLogin.deleteUser(user.id);
				setConfirmDeleteId(null);
				await refresh();
				notifyToast({
					color: 'green',
					title: 'Web Login',
					message: `Deleted the account "${user.username}".`,
				});
			} catch (err) {
				notifyToast({ color: 'red', title: 'Web Login', message: errorText(err) });
			} finally {
				setRowBusyId(null);
			}
		},
		[refresh]
	);

	const inputStyle = {
		backgroundColor: theme.colors.bgActivity,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};
	const inputClass =
		'w-full px-2 py-1.5 rounded-lg border text-xs outline-none focus:border-current';

	return (
		<div data-testid="web-login-users" className="select-text">
			<div
				className="flex items-start gap-1.5 text-xs mb-3"
				data-testid="web-login-warning"
				style={{ color: theme.colors.warning }}
			>
				<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
				<span>
					The web interface is served over plain HTTP on your network. Passwords typed on the LAN
					travel in the clear. Use the Remote Control tunnel or a network you trust. This
					machine&apos;s maestro-cli is never asked to log in; every browser is, including one on
					this machine.
				</span>
			</div>

			<div
				className="text-xs font-bold uppercase opacity-70"
				style={{ color: theme.colors.textMain }}
			>
				Accounts
			</div>

			{loadError && (
				<p
					className="text-xs mt-1"
					data-testid="web-login-load-error"
					style={{ color: theme.colors.error }}
				>
					{loadError}
				</p>
			)}

			{users === null ? (
				<p className="text-xs opacity-70 mt-1">Loading accounts…</p>
			) : users.length === 0 ? (
				<div
					className="text-xs rounded-lg border p-3 mt-2"
					data-testid="web-login-empty"
					style={{ borderColor: theme.colors.warning, color: theme.colors.warning }}
				>
					No accounts yet. Until you add one, nobody can sign in.
				</div>
			) : (
				<div
					className="flex flex-col gap-1 mt-2 rounded-lg border p-1.5"
					style={{ borderColor: theme.colors.border }}
				>
					{users.map((user) => {
						const busy = rowBusyId === user.id;
						return (
							<div
								key={user.id}
								data-testid="web-login-user-row"
								data-username={user.username}
								className="rounded px-2 py-1.5"
							>
								<div className="flex items-center gap-2">
									<div className="min-w-0 flex-1">
										<div
											className="text-xs font-medium truncate flex items-center gap-1.5"
											style={{ color: theme.colors.textMain }}
										>
											{user.displayName}
											{user.disabled && (
												<MiniBadge
													label="Disabled"
													theme={theme}
													color={theme.colors.warning}
													testId="web-login-disabled-badge"
												/>
											)}
										</div>
										<div className="text-2xs font-mono truncate opacity-70">
											{user.username} · added {formatRelativeTime(user.createdAt)} ·{' '}
											{user.lastLoginAt
												? `last signed in ${formatRelativeTime(user.lastLoginAt)}`
												: 'never signed in'}
										</div>
									</div>
									<div className="flex items-center gap-1 flex-shrink-0">
										<button
											type="button"
											data-testid="web-login-reset-toggle"
											disabled={busy}
											onClick={() => (resetId === user.id ? closeResetForm() : setResetId(user.id))}
											className="flex items-center gap-1 px-2 py-1 rounded border text-2xs transition-colors hover:bg-white/5 disabled:opacity-50"
											style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
										>
											<KeyRound className="w-3 h-3" /> Reset password
										</button>
										<button
											type="button"
											data-testid="web-login-toggle-disabled"
											disabled={busy}
											onClick={() => void toggleDisabled(user)}
											className="flex items-center gap-1 px-2 py-1 rounded border text-2xs transition-colors hover:bg-white/5 disabled:opacity-50"
											style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
										>
											<Power className="w-3 h-3" /> {user.disabled ? 'Enable' : 'Disable'}
										</button>
										{confirmDeleteId === user.id ? (
											<>
												<button
													type="button"
													data-testid="web-login-delete-confirm"
													disabled={busy}
													onClick={() => void deleteAccount(user)}
													className="flex items-center gap-1 px-2 py-1 rounded text-2xs font-medium transition-colors disabled:opacity-50"
													style={{
														backgroundColor: theme.colors.error,
														color: theme.colors.bgMain,
													}}
												>
													<Trash2 className="w-3 h-3" /> Confirm delete
												</button>
												<button
													type="button"
													data-testid="web-login-delete-cancel"
													onClick={() => setConfirmDeleteId(null)}
													className="px-2 py-1 rounded border text-2xs transition-colors hover:bg-white/5"
													style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
												>
													Cancel
												</button>
											</>
										) : (
											<button
												type="button"
												data-testid="web-login-delete"
												disabled={busy}
												onClick={() => setConfirmDeleteId(user.id)}
												className="flex items-center gap-1 px-2 py-1 rounded border text-2xs transition-colors hover:bg-white/5 disabled:opacity-50"
												style={{ borderColor: theme.colors.border, color: theme.colors.error }}
											>
												<Trash2 className="w-3 h-3" /> Delete
											</button>
										)}
									</div>
								</div>

								{resetId === user.id && (
									<div className="mt-2 flex flex-col gap-1.5" data-testid="web-login-reset-form">
										<p className="text-2xs opacity-70">
											A reset signs out every browser currently using this account.
										</p>
										<input
											type="password"
											data-testid="web-login-reset-password"
											aria-label="New password"
											placeholder="New password"
											value={resetPassword}
											onChange={(e) => setResetPassword(e.target.value)}
											className={inputClass}
											style={inputStyle}
										/>
										<input
											type="password"
											data-testid="web-login-reset-confirm"
											aria-label="Confirm new password"
											placeholder="Confirm new password"
											value={resetConfirm}
											onChange={(e) => setResetConfirm(e.target.value)}
											className={inputClass}
											style={inputStyle}
										/>
										{resetError && (
											<p
												className="text-2xs"
												data-testid="web-login-reset-error"
												style={{ color: theme.colors.error }}
											>
												{resetError}
											</p>
										)}
										<div className="flex items-center gap-2">
											<button
												type="button"
												data-testid="web-login-reset-submit"
												disabled={busy}
												onClick={() => void submitReset(user)}
												className="px-2.5 py-1 rounded-lg text-2xs font-medium transition-colors disabled:opacity-50"
												style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
											>
												Set password
											</button>
											<button
												type="button"
												data-testid="web-login-reset-cancel"
												onClick={closeResetForm}
												className="px-2.5 py-1 rounded-lg border text-2xs transition-colors hover:bg-white/5"
												style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
											>
												Cancel
											</button>
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			<div
				className="text-xs font-bold uppercase opacity-70 mt-5"
				style={{ color: theme.colors.textMain }}
			>
				Add account
			</div>
			<p className="text-xs opacity-70 mb-2">
				Every account is an equal operator. There are no roles, and nothing created here can
				administer accounts from a browser.
			</p>
			<div className="flex flex-col gap-1.5">
				<input
					type="text"
					data-testid="web-login-new-username"
					aria-label="Username"
					placeholder="Username"
					autoComplete="off"
					value={username}
					onChange={(e) => setUsername(e.target.value)}
					className={inputClass}
					style={inputStyle}
				/>
				<input
					type="text"
					data-testid="web-login-new-display-name"
					aria-label="Display name (optional)"
					placeholder="Display name (optional)"
					autoComplete="off"
					value={displayName}
					onChange={(e) => setDisplayName(e.target.value)}
					className={inputClass}
					style={inputStyle}
				/>
				<input
					type="password"
					data-testid="web-login-new-password"
					aria-label="Password"
					placeholder="Password"
					autoComplete="new-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					className={inputClass}
					style={inputStyle}
				/>
				<input
					type="password"
					data-testid="web-login-new-confirm"
					aria-label="Confirm password"
					placeholder="Confirm password"
					autoComplete="new-password"
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
					className={inputClass}
					style={inputStyle}
				/>
				{createError && (
					<p
						className="text-xs"
						data-testid="web-login-create-error"
						style={{ color: theme.colors.error }}
					>
						{createError}
					</p>
				)}
				<div>
					<button
						type="button"
						data-testid="web-login-create"
						disabled={creating}
						onClick={() => void createAccount()}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						<UserPlus className="w-3.5 h-3.5" /> Add account
					</button>
				</div>
			</div>
		</div>
	);
}
