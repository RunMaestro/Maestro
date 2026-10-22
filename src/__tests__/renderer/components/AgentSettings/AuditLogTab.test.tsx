/**
 * @fileoverview Tests for AuditLogTab, the panel around AgentCotExportSection.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuditLogTab } from '../../../../renderer/components/AgentSettings/AuditLogTab';
import { createMockTheme } from '../../../helpers/mockTheme';

const renderTab = () =>
	render(
		<AuditLogTab
			theme={createMockTheme()}
			idPrefix="edit-agent"
			agentId="agent-1"
			agentName="Backend"
			supportsReasoning={true}
			usesInteractiveTokenSource={false}
		/>
	);

describe('AuditLogTab', () => {
	afterEach(() => {
		delete (window.maestro as any).cotExport;
	});

	it('is the auditLog tabpanel and holds the section of its agent', async () => {
		const status = vi
			.fn()
			.mockResolvedValue({ enabled: false, folder: null, turnsToday: 0, unencrypted: false });
		(window.maestro as any).cotExport = { status };
		renderTab();

		const panel = screen.getByRole('tabpanel');
		expect(panel).toHaveAttribute('id', 'edit-agent-tabpanel-auditLog');
		expect(panel).toHaveAttribute('aria-labelledby', 'edit-agent-tab-auditLog');
		expect(panel).toContainElement(screen.getByTestId('cot-export-section'));
		expect(status).toHaveBeenCalledWith('agent-1');
		await waitFor(() => expect(screen.getByText('Choose Folder')).not.toBeDisabled());
	});

	it('is an empty panel where the API is not exposed', () => {
		renderTab();

		expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement();
	});
});
