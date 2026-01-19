/**
 * Tests for DeleteAgentConfirmModal component
 *
 * Tests the core behavior of the delete agent confirmation dialog:
 * - Rendering with agent name, working directory, and three buttons
 * - Button click handlers (Cancel, Agent Only, Agent + Work Directory)
 * - Focus management
 * - Layer stack integration
 * - Accessibility
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeleteAgentConfirmModal } from '../../../renderer/components/DeleteAgentConfirmModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
  X: () => <svg data-testid="x-icon" />,
  Trash2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="trash2-icon" className={className} style={style} />
  ),
  AlertTriangle: ({
    className,
    style,
  }: {
    className?: string;
    style?: React.CSSProperties;
  }) => <svg data-testid="alert-triangle-icon" className={className} style={style} />,
}));

// Create a test theme
const testTheme: Theme = {
  id: 'test-theme',
  name: 'Test Theme',
  mode: 'dark',
  colors: {
    bgMain: '#1e1e1e',
    bgSidebar: '#252526',
    bgActivity: '#333333',
    textMain: '#d4d4d4',
    textDim: '#808080',
    accent: '#007acc',
    accentDim: '#007acc80',
    accentText: '#ffffff',
    accentForeground: '#ffffff',
    border: '#404040',
    error: '#f14c4c',
    warning: '#cca700',
    success: '#89d185',
  },
};

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
  return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('DeleteAgentConfirmModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders with agent name, confirmation input, and three action buttons', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText(/TestAgent/)).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(
          'Type the agent name here to confirm directory deletion.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent Only' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Agent + Work Directory' })
      ).toBeInTheDocument();
    });

    it('renders working directory path', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('/home/user/project')).toBeInTheDocument();
    });

    it('renders danger warning text about Agent + Work Directory', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const dangerText =
        'Danger: Deleting the agent "TestAgent" cannot be undone. "Agent + Work Directory" will also move the working directory to the trash:';

      expect(
        screen.getByText(
          (_, element) => {
            const text = element?.textContent?.replace(/\s+/g, ' ').trim();
            return text === dangerText;
          },
          { selector: 'p' }
        )
      ).toBeInTheDocument();
    });

    it('styles warning icon and text to match the mockup', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const warningIcon = screen.getByTestId('alert-triangle-icon');
      const warningIconWrapper = warningIcon.parentElement;
      expect(warningIconWrapper).toHaveStyle({
        backgroundColor: 'rgba(255, 165, 0, 0.2)',
      });
      expect(warningIcon).toHaveStyle({ color: '#ffa500' });

      const dangerLabel = screen.getByText('Danger:');
      expect(dangerLabel).toHaveStyle({ color: '#ffd700' });

      const warningParagraph = screen.getByText(/Deleting the agent/);
      expect(warningParagraph).toHaveStyle({ color: '#ffffff' });
    });

    it('applies spacing between the warning, path, and confirmation input', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const pathElement = screen.getByText('/home/user/project');
      expect(pathElement).toHaveClass('mt-4');

      const confirmationInput = screen.getByPlaceholderText(
        'Type the agent name here to confirm directory deletion.'
      );
      expect(confirmationInput).toHaveClass('mt-2.5');
    });

    it('renders header with title and close button', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('Confirm Delete')).toBeInTheDocument();
      expect(screen.getByTestId('x-icon')).toBeInTheDocument();
    });

    it('has correct ARIA attributes', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-label', 'Confirm Delete');
    });
  });

  describe('focus management', () => {
    it('focuses Agent Only button on mount (not Agent + Work Directory)', async () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Agent Only' })
        );
      });
    });
  });

  describe('button handlers', () => {
    it('disables Agent + Work Directory by default', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(
        screen.getByRole('button', { name: 'Agent + Work Directory' })
      ).toBeDisabled();
    });

    it('calls onClose when X button is clicked', () => {
      const onClose = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={onClose}
        />
      );

      const closeButton = screen.getByTestId('x-icon').closest('button');
      fireEvent.click(closeButton!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when Cancel is clicked', () => {
      const onClose = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={onClose}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onConfirm then onClose when Agent Only is clicked', () => {
      const callOrder: string[] = [];
      const onClose = vi.fn(() => callOrder.push('close'));
      const onConfirm = vi.fn(() => callOrder.push('confirm'));
      const onConfirmAndErase = vi.fn();

      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={onConfirm}
          onConfirmAndErase={onConfirmAndErase}
          onClose={onClose}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Agent Only' }));
      expect(callOrder).toEqual(['confirm', 'close']);
      expect(onConfirmAndErase).not.toHaveBeenCalled();
    });

    it('calls onConfirmAndErase then onClose when Agent + Work Directory is clicked', () => {
      const callOrder: string[] = [];
      const onClose = vi.fn(() => callOrder.push('close'));
      const onConfirm = vi.fn();
      const onConfirmAndErase = vi.fn(() => callOrder.push('confirmAndErase'));

      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={onConfirm}
          onConfirmAndErase={onConfirmAndErase}
          onClose={onClose}
        />
      );

      fireEvent.change(
        screen.getByPlaceholderText(
          'Type the agent name here to confirm directory deletion.'
        ),
        { target: { value: 'TestAgent' } }
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Agent + Work Directory' })
      );
      expect(callOrder).toEqual(['confirmAndErase', 'close']);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('does not call onConfirmAndErase when Agent + Work Directory is disabled', () => {
      const onConfirmAndErase = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={onConfirmAndErase}
          onClose={vi.fn()}
        />
      );

      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });
      expect(eraseButton).toBeDisabled();
      fireEvent.click(eraseButton);
      expect(onConfirmAndErase).not.toHaveBeenCalled();
    });

    it('Cancel does not call onConfirm or onConfirmAndErase', () => {
      const onConfirm = vi.fn();
      const onConfirmAndErase = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={onConfirm}
          onConfirmAndErase={onConfirmAndErase}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onConfirmAndErase).not.toHaveBeenCalled();
    });
  });

  describe('confirmation input', () => {
    it('keeps Agent + Work Directory disabled with partial or wrong input', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText(
        'Type the agent name here to confirm directory deletion.'
      );
      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });

      fireEvent.change(input, { target: { value: 'Test' } });
      expect(eraseButton).toBeDisabled();

      fireEvent.change(input, { target: { value: 'AnotherAgent' } });
      expect(eraseButton).toBeDisabled();
    });

    it('enables Agent + Work Directory when the agent name matches (case-insensitive)', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText(
        'Type the agent name here to confirm directory deletion.'
      );
      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });

      fireEvent.change(input, { target: { value: ' testagent ' } });
      expect(eraseButton).toBeEnabled();
    });

    it('updates the input value on change', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText(
        'Type the agent name here to confirm directory deletion.'
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'TestAgent' } });
      expect(input.value).toBe('TestAgent');
    });
  });

  describe('edge cases', () => {
    it('renders long agent names with wrapping support', () => {
      const longAgentName = `Agent-${'A'.repeat(60)}`;
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName={longAgentName}
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const warningParagraph = screen.getByText(/Deleting the agent/);
      expect(warningParagraph).toHaveClass('break-words');
      expect(warningParagraph.textContent).toContain(longAgentName);
    });

    it('renders long working directory paths with break-all', () => {
      const longWorkingDirectory = `/var/${'a'.repeat(120)}/workspace`;
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory={longWorkingDirectory}
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const pathElement = screen.getByText(longWorkingDirectory);
      expect(pathElement).toHaveClass('break-all');
    });

    it('supports special characters in the agent name', () => {
      const specialAgentName = 'Agent "Alpha" & Co <Test>';
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName={specialAgentName}
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const warningParagraph = screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          Boolean(element?.textContent?.includes(specialAgentName))
      );
      expect(warningParagraph).toBeInTheDocument();

      const input = screen.getByPlaceholderText(
        'Type the agent name here to confirm directory deletion.'
      );
      fireEvent.change(input, { target: { value: specialAgentName } });
      expect(
        screen.getByRole('button', { name: 'Agent + Work Directory' })
      ).toBeEnabled();
    });

    it('trims the agent name before comparing confirmation input', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="  TestAgent  "
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText(
        'Type the agent name here to confirm directory deletion.'
      );
      fireEvent.change(input, { target: { value: 'TestAgent' } });
      expect(
        screen.getByRole('button', { name: 'Agent + Work Directory' })
      ).toBeEnabled();
    });

    it('sets a maxLength on the confirmation input', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText(
        'Type the agent name here to confirm directory deletion.'
      );
      expect(input).toHaveAttribute('maxlength', '256');
    });
  });

  describe('keyboard interaction', () => {
    it('stops propagation of keydown events', () => {
      const parentHandler = vi.fn();

      render(
        <div onKeyDown={parentHandler}>
          <LayerStackProvider>
            <DeleteAgentConfirmModal
              theme={testTheme}
              agentName="TestAgent"
              workingDirectory="/home/user/project"
              onConfirm={vi.fn()}
              onConfirmAndErase={vi.fn()}
              onClose={vi.fn()}
            />
          </LayerStackProvider>
        </div>
      );

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });
      expect(parentHandler).not.toHaveBeenCalled();
    });
  });

  describe('layer stack integration', () => {
    it('registers and unregisters without errors', () => {
      const { unmount } = renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('accessibility', () => {
    it('adds aria-label and aria-describedby to the confirmation input', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByRole('textbox');
      expect(input).toHaveAttribute(
        'aria-label',
        'Type TestAgent to confirm directory deletion'
      );
      expect(input).toHaveAttribute('aria-describedby', 'delete-agent-warning');

      const warning = document.getElementById('delete-agent-warning');
      expect(warning).toBeInTheDocument();
      expect(warning?.textContent).toContain('Deleting the agent');
    });

    it('reflects the erase button disabled state with aria-disabled', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByRole('textbox');
      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });
      expect(eraseButton).toHaveAttribute('aria-disabled', 'true');

      fireEvent.change(input, { target: { value: 'TestAgent' } });
      expect(eraseButton).toHaveAttribute('aria-disabled', 'false');
    });

    it('has tabIndex on dialog for focus', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole('dialog')).toHaveAttribute('tabIndex', '-1');
    });

    it('has semantic button elements', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      // X, Cancel, Agent Only, Agent + Work Directory, text input
      const buttons = screen.getAllByRole('button');
      const textbox = screen.getByRole('textbox');
      expect(buttons).toHaveLength(4);
      expect(textbox).toBeInTheDocument();
    });

    it('has heading for modal title', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole('heading', { name: 'Confirm Delete' })).toBeInTheDocument();
    });

    it('assigns tab order for actions', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      const agentOnlyButton = screen.getByRole('button', { name: 'Agent Only' });
      const input = screen.getByRole('textbox');
      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });

      expect(cancelButton).toHaveAttribute('tabindex', '1');
      expect(agentOnlyButton).toHaveAttribute('tabindex', '2');
      expect(input).toHaveAttribute('tabindex', '3');
      expect(eraseButton).toHaveAttribute('tabindex', '4');
    });
  });

  describe('confirmation input keyboard handling', () => {
    it('activates Agent + Work Directory when Enter is pressed with a matching name', () => {
      const onConfirmAndErase = vi.fn();
      const onClose = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={onConfirmAndErase}
          onClose={onClose}
        />
      );

      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'TestAgent' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onConfirmAndErase).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not activate Agent + Work Directory when Enter is pressed without a match', () => {
      const onConfirmAndErase = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={onConfirmAndErase}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'Nope' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onConfirmAndErase).not.toHaveBeenCalled();
    });
  });
});
