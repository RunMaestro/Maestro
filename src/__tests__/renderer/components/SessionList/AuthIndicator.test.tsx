/**
 * Tests for {@link AuthIndicator} - the Left Bar mark that says "this agent will
 * not run until you deal with an account".
 *
 * Two things matter here and neither is cosmetic. The badge must name the
 * ACCOUNT rather than the agent, because fifteen rows can carry it and only one
 * login is broken. And it must distinguish a login that a sign-in repairs from a
 * credential that one cannot, so Phase 04 never offers a sign-in for a rejected
 * API key.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
	AuthIndicator,
	describeAuthIndicator,
} from '../../../../renderer/components/SessionList/AuthIndicator';
import { THEMES } from '../../../../renderer/constants/themes';
import { hexToRgb } from '../../../../shared/colorContrast';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../../shared/providerAuth';

const theme = THEMES.dracula;

const OAUTH_IDENTITY: CredentialIdentity = {
	key: 'claude-code::oauth::/Users/x/.claude-smash::local',
	provider: 'claude-code',
	kind: 'oauth',
	scope: '/Users/x/.claude-smash',
	host: 'local',
	label: '.claude-smash',
};

const API_KEY_IDENTITY: CredentialIdentity = {
	key: 'claude-code::api-key::ANTHROPIC_API_KEY:abc123::local',
	provider: 'claude-code',
	kind: 'api-key',
	scope: 'ANTHROPIC_API_KEY:abc123',
	host: 'local',
	label: 'ANTHROPIC_API_KEY',
	envVarName: 'ANTHROPIC_API_KEY',
};

const snapshot = (overrides: Partial<ProviderAuthSnapshot> = {}): ProviderAuthSnapshot => ({
	identity: OAUTH_IDENTITY,
	status: 'logged-out',
	checkedAt: 1,
	source: 'probe',
	...overrides,
});

describe('describeAuthIndicator', () => {
	it('returns nothing when there is no snapshot at all', () => {
		expect(describeAuthIndicator(null)).toBeNull();
	});

	it('returns nothing for a healthy credential', () => {
		expect(describeAuthIndicator(snapshot({ status: 'authenticated' }))).toBeNull();
	});

	it('returns nothing for an unknown status, which is "not checked yet", not "broken"', () => {
		expect(describeAuthIndicator(snapshot({ status: 'unknown' }))).toBeNull();
	});

	it('names the account, not the agent, for an expired login', () => {
		expect(describeAuthIndicator(snapshot())).toEqual({
			tooltip: 'Claude Code (.claude-smash) needs re-authentication',
			canSignIn: true,
		});
	});

	it('does not badge an unsupported PROBE, which is a healthy agent with nothing to probe', () => {
		// Factory Droid has no status subcommand. Badging this would pin a
		// permanent warning on a row that has nothing wrong with it.
		expect(describeAuthIndicator(snapshot({ status: 'unsupported', source: 'probe' }))).toBeNull();
	});

	it('badges an unsupported credential that a live failure rejected, without offering a sign-in', () => {
		expect(
			describeAuthIndicator(
				snapshot({
					identity: API_KEY_IDENTITY,
					status: 'unsupported',
					source: 'error-pattern',
					detail: 'ANTHROPIC_API_KEY was rejected.',
				})
			)
		).toEqual({
			tooltip: 'Claude Code (ANTHROPIC_API_KEY) rejected its credential',
			canSignIn: false,
		});
	});

	it('badges an unsupported credential rejected during a login flow', () => {
		expect(
			describeAuthIndicator(snapshot({ status: 'unsupported', source: 'login-flow' }))
		).toEqual({
			tooltip: 'Claude Code (.claude-smash) rejected its credential',
			canSignIn: false,
		});
	});
});

describe('AuthIndicator', () => {
	it('renders nothing when the credential is fine, so callers can mount it unconditionally', () => {
		const { container } = render(
			<AuthIndicator snapshot={snapshot({ status: 'authenticated' })} theme={theme} />
		);
		expect(container.firstChild).toBeNull();
	});

	it('renders nothing when there is no snapshot for this agent yet', () => {
		const { container } = render(<AuthIndicator snapshot={null} theme={theme} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders a repairable-login badge whose tooltip and label name the account', () => {
		render(<AuthIndicator snapshot={snapshot()} theme={theme} />);

		const button = screen.getByRole('button', {
			name: 'Claude Code (.claude-smash) needs re-authentication',
		});
		expect(button.getAttribute('title')).toBe(
			'Claude Code (.claude-smash) needs re-authentication'
		);
		expect(button.getAttribute('data-auth-indicator')).toBe('logged-out');
	});

	it('distinguishes a rejected credential from an expired login in the DOM', () => {
		render(
			<AuthIndicator
				snapshot={snapshot({
					identity: API_KEY_IDENTITY,
					status: 'unsupported',
					source: 'error-pattern',
				})}
				theme={theme}
			/>
		);

		// Phase 04 reads this to decide whether a sign-in is on offer.
		expect(screen.getByRole('button').getAttribute('data-auth-indicator')).toBe('rejected');
	});

	it('uses the theme accent rather than a literal color', () => {
		const { container } = render(<AuthIndicator snapshot={snapshot()} theme={theme} />);

		const accent = hexToRgb(theme.colors.accent);
		const rgb = `${accent?.r}, ${accent?.g}, ${accent?.b}`;
		const button = container.querySelector('button') as HTMLButtonElement;
		const icon = container.querySelector('svg') as SVGElement;
		// Both derived from the active theme, so a theme switch carries the badge
		// with it instead of stranding a hard-coded purple on a light background.
		// jsdom serializes the inline hex to rgb/rgba, hence the channel compare.
		expect(button.getAttribute('style')).toContain(`rgba(${rgb}`);
		expect(icon.getAttribute('style')).toContain(`rgb(${rgb})`);
	});

	it('hands the click the IDENTITY key, because the recovery is per credential', () => {
		const onClick = vi.fn();
		render(<AuthIndicator snapshot={snapshot()} theme={theme} onClick={onClick} />);

		fireEvent.click(screen.getByRole('button'));

		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onClick).toHaveBeenCalledWith(OAUTH_IDENTITY.key);
	});

	it('does not also select the agent when the badge is clicked', () => {
		const onRowClick = vi.fn();
		render(
			<div onClick={onRowClick}>
				<AuthIndicator snapshot={snapshot()} theme={theme} onClick={vi.fn()} />
			</div>
		);

		fireEvent.click(screen.getByRole('button'));

		// The row selects the agent; the badge is about the account behind it.
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it('does not crash when no click handler is supplied', () => {
		render(<AuthIndicator snapshot={snapshot()} theme={theme} />);
		expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow();
	});
});
