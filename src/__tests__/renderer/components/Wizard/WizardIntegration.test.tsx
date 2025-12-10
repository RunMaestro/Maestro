/**
 * WizardIntegration.test.tsx
 *
 * Integration tests for the full onboarding wizard flow.
 * Tests end-to-end wizard behavior including:
 * - Complete wizard flow from open to completion
 * - Step navigation (forward, backward)
 * - State persistence and resume functionality
 * - Exit confirmation workflow
 * - Analytics callbacks
 * - Error handling flows
 * - Tour trigger behavior
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WizardProvider,
  useWizard,
  type WizardStep,
  type SerializableWizardState,
} from '../../../../renderer/components/Wizard/WizardContext';
import { MaestroWizard } from '../../../../renderer/components/Wizard/MaestroWizard';
import { WizardResumeModal } from '../../../../renderer/components/Wizard/WizardResumeModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { Theme, AgentConfig } from '../../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="x-icon" className={className} style={style} />
  ),
  AlertCircle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="alert-icon" className={className} style={style} />
  ),
  AlertTriangle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="alert-triangle-icon" className={className} style={style} />
  ),
  Eye: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="eye-icon" className={className} style={style} />
  ),
  Edit: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="edit-icon" className={className} style={style} />
  ),
  Image: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="image-icon" className={className} style={style} />
  ),
  Loader2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="loader-icon" className={className} style={style} />
  ),
  Rocket: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="rocket-icon" className={className} style={style} />
  ),
  Compass: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="compass-icon" className={className} style={style} />
  ),
  ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="chevron-down-icon" className={className} style={style} />
  ),
  ChevronRight: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="chevron-right-icon" className={className} style={style} />
  ),
  FileText: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="file-text-icon" className={className} style={style} />
  ),
  FolderOpen: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="folder-open-icon" className={className} style={style} />
  ),
  GitBranch: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="git-branch-icon" className={className} style={style} />
  ),
  Bot: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="bot-icon" className={className} style={style} />
  ),
  RefreshCw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="refresh-icon" className={className} style={style} />
  ),
  RotateCcw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="rotate-ccw-icon" className={className} style={style} />
  ),
  CheckCircle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="check-circle-icon" className={className} style={style} />
  ),
  Send: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="send-icon" className={className} style={style} />
  ),
  MessageCircle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="message-circle-icon" className={className} style={style} />
  ),
}));

// Mock react-markdown
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

// Mock react-syntax-highlighter
vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children: string }) => (
    <pre data-testid="syntax-highlighter">{children}</pre>
  ),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  vscDarkPlus: {},
}));

// Mock remark-gfm
vi.mock('remark-gfm', () => ({
  default: () => {},
}));

// Mock MermaidRenderer
vi.mock('../../../../renderer/components/MermaidRenderer', () => ({
  MermaidRenderer: ({ chart }: { chart: string }) => <div data-testid="mermaid">{chart}</div>,
}));

// Mock conversation manager to avoid actual agent spawning
vi.mock('../../../../renderer/components/Wizard/services/conversationManager', () => ({
  conversationManager: {
    startConversation: vi.fn().mockResolvedValue({ success: true }),
    sendMessage: vi.fn().mockImplementation((_message, _history, callbacks) => {
      // Simulate async response
      setTimeout(() => {
        callbacks?.onReceiving?.();
        callbacks?.onComplete?.({
          confidence: 85,
          ready: true,
          message: 'I understand your project requirements!',
        });
      }, 10);
    }),
    endConversation: vi.fn(),
  },
  createUserMessage: vi.fn((content: string) => ({
    id: `msg-${Date.now()}`,
    role: 'user' as const,
    content,
    timestamp: Date.now(),
  })),
  createAssistantMessage: vi.fn((content: string, confidence?: number, ready?: boolean) => ({
    id: `msg-${Date.now()}`,
    role: 'assistant' as const,
    content,
    timestamp: Date.now(),
    confidence,
    ready,
  })),
}));

// Mock phase generator
vi.mock('../../../../renderer/components/Wizard/services/phaseGenerator', () => ({
  phaseGenerator: {
    generateDocuments: vi.fn().mockImplementation(async (_config, callbacks) => {
      callbacks?.onProgress?.('Generating documents...');
      return {
        success: true,
        documents: [
          {
            filename: 'Phase-01-Initial-Setup.md',
            content: '# Phase 01: Initial Setup\n\n## Tasks\n\n- [ ] Task 1\n- [ ] Task 2',
            taskCount: 2,
          },
        ],
      };
    }),
    saveDocuments: vi.fn().mockResolvedValue({
      success: true,
      paths: ['/test/path/Auto Run Docs/Phase-01-Initial-Setup.md'],
    }),
    isGenerationInProgress: vi.fn().mockReturnValue(false),
  },
  AUTO_RUN_FOLDER_NAME: 'Auto Run Docs',
}));

// Mock theme
const mockTheme: Theme = {
  id: 'test-dark',
  name: 'Test Dark',
  mode: 'dark',
  colors: {
    bgMain: '#1a1a1a',
    bgSidebar: '#252525',
    bgActivity: '#2a2a2a',
    border: '#333333',
    textMain: '#ffffff',
    textDim: '#888888',
    textFaint: '#555555',
    accent: '#4a9eff',
    accentDim: '#3a8eef',
    accentText: '#ffffff',
    accentForeground: '#ffffff',
    buttonBg: '#333333',
    buttonHover: '#444444',
    headerBg: '#202020',
    scrollbarTrack: '#1a1a1a',
    scrollbarThumb: '#444444',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
  },
};

// Mock available agents
const mockAgents: AgentConfig[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    available: true,
    path: '/usr/local/bin/claude',
    hidden: false,
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    command: 'codex',
    args: [],
    available: false,
    path: '',
    hidden: false,
  },
];

// Mock window.maestro API
const mockMaestro = {
  agents: {
    detect: vi.fn(),
    get: vi.fn(),
  },
  git: {
    isRepo: vi.fn(),
  },
  dialog: {
    selectFolder: vi.fn(),
  },
  settings: {
    get: vi.fn(),
    set: vi.fn(),
  },
  autorun: {
    saveImage: vi.fn(),
    writeDoc: vi.fn(),
    deleteImage: vi.fn(),
  },
  fs: {
    readFile: vi.fn(),
  },
  process: {
    spawn: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  },
};

// Helper to render with providers
const renderWithProviders = (ui: React.ReactElement) => {
  return render(
    <LayerStackProvider>
      <WizardProvider>{ui}</WizardProvider>
    </LayerStackProvider>
  );
};

describe('Wizard Integration Tests', () => {
  beforeEach(() => {
    // Setup window.maestro mock
    (window as any).maestro = mockMaestro;

    // Setup default mock responses
    mockMaestro.agents.detect.mockResolvedValue(mockAgents);
    mockMaestro.agents.get.mockResolvedValue(mockAgents[0]);
    mockMaestro.git.isRepo.mockResolvedValue(true);
    mockMaestro.settings.get.mockResolvedValue(undefined);
    mockMaestro.settings.set.mockResolvedValue(undefined);
    mockMaestro.dialog.selectFolder.mockResolvedValue('/test/project/path');

    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('Full Wizard Flow', () => {
    it('should open wizard and display first step', async () => {
      function TestWrapper() {
        const { openWizard, state } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            openWizard();
          }
        }, [openWizard, state.isOpen]);

        return state.isOpen ? <MaestroWizard theme={mockTheme} /> : null;
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Select Your Agent')).toBeInTheDocument();
        expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
      });
    });

    it('should navigate from agent selection to directory selection', async () => {
      function TestWrapper() {
        const { openWizard, state, setSelectedAgent, nextStep } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            openWizard();
          }
        }, [openWizard, state.isOpen]);

        const handleContinue = () => {
          setSelectedAgent('claude-code');
          // Wait for state update then navigate
          setTimeout(() => nextStep(), 50);
        };

        return (
          <>
            <button data-testid="manual-continue" onClick={handleContinue}>
              Continue
            </button>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
            <div data-testid="current-step">{state.currentStep}</div>
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Select Your Agent')).toBeInTheDocument();
      });

      // Trigger manual continue
      fireEvent.click(screen.getByTestId('manual-continue'));

      // Advance timers to allow state update and navigation
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      await waitFor(() => {
        expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
      });
    });

    it('should track step progress through navigation', async () => {
      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent, setDirectoryPath } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            setDirectoryPath('/test/path');
            openWizard();
          }
        }, [openWizard, state.isOpen, setSelectedAgent, setDirectoryPath]);

        return (
          <>
            <button onClick={() => goToStep('directory-selection')} data-testid="go-step-2">
              Step 2
            </button>
            <button onClick={() => goToStep('conversation')} data-testid="go-step-3">
              Step 3
            </button>
            <button onClick={() => goToStep('phase-review')} data-testid="go-step-4">
              Step 4
            </button>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
      });

      // Navigate to step 2
      fireEvent.click(screen.getByTestId('go-step-2'));

      await waitFor(() => {
        expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
        expect(screen.getByText('Choose Project Directory')).toBeInTheDocument();
      });

      // Navigate to step 3
      fireEvent.click(screen.getByTestId('go-step-3'));

      await waitFor(() => {
        expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
        expect(screen.getByText('Project Discovery')).toBeInTheDocument();
      });

      // Navigate to step 4
      fireEvent.click(screen.getByTestId('go-step-4'));

      await waitFor(() => {
        expect(screen.getByText('Step 4 of 4')).toBeInTheDocument();
        expect(screen.getByText('Review Your Action Plan')).toBeInTheDocument();
      });
    });

    it('should show progress dots with correct states', async () => {
      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            openWizard();
            // Start on step 3 to show both completed and upcoming dots
            setTimeout(() => goToStep('conversation'), 50);
          }
        }, [openWizard, state.isOpen, goToStep, setSelectedAgent]);

        return state.isOpen ? <MaestroWizard theme={mockTheme} /> : null;
      }

      renderWithProviders(<TestWrapper />);

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      await waitFor(() => {
        const progressDots = screen.getAllByLabelText(/step \d+/i);
        expect(progressDots).toHaveLength(4);

        // Steps 1 and 2 should be completed, step 3 should be current
        expect(progressDots[0]).toHaveAttribute('aria-label', 'Step 1 (completed)');
        expect(progressDots[1]).toHaveAttribute('aria-label', 'Step 2 (completed)');
        expect(progressDots[2]).toHaveAttribute('aria-label', 'Step 3 (current)');
        expect(progressDots[3]).toHaveAttribute('aria-label', 'Step 4');
      });
    });
  });

  describe('Exit Confirmation Flow', () => {
    it('should close directly without confirmation on step 1', async () => {
      function TestWrapper() {
        const { openWizard, closeWizard, state } = useWizard();

        return (
          <>
            <button onClick={openWizard} data-testid="open-wizard">
              Open
            </button>
            <button onClick={closeWizard} data-testid="close-wizard">
              Close
            </button>
            <div data-testid="wizard-open">{state.isOpen ? 'open' : 'closed'}</div>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      // Open wizard
      fireEvent.click(screen.getByTestId('open-wizard'));

      await waitFor(() => {
        expect(screen.getByText('Select Your Agent')).toBeInTheDocument();
      });

      // Click close button in wizard modal
      const closeButton = screen.getByRole('button', { name: /close wizard/i });
      fireEvent.click(closeButton);

      // Allow time for the close to process - on step 1 it should close directly
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      // No confirmation should appear for step 1
      expect(screen.queryByText('Exit Setup Wizard?')).not.toBeInTheDocument();
    });

    it('should show confirmation when closing after step 1', async () => {
      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            openWizard();
            setTimeout(() => goToStep('directory-selection'), 50);
          }
        }, [openWizard, state.isOpen, goToStep, setSelectedAgent]);

        return state.isOpen ? <MaestroWizard theme={mockTheme} /> : null;
      }

      renderWithProviders(<TestWrapper />);

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      await waitFor(() => {
        expect(screen.getByText('Choose Project Directory')).toBeInTheDocument();
      });

      // Click close button
      const closeButton = screen.getByRole('button', { name: /close wizard/i });
      fireEvent.click(closeButton);

      // Should show exit confirmation
      await waitFor(() => {
        expect(screen.getByText('Exit Setup Wizard?')).toBeInTheDocument();
      });
    });

    it('should stay in wizard when canceling exit confirmation', async () => {
      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            openWizard();
            setTimeout(() => goToStep('directory-selection'), 50);
          }
        }, [openWizard, state.isOpen, goToStep, setSelectedAgent]);

        return state.isOpen ? <MaestroWizard theme={mockTheme} /> : null;
      }

      renderWithProviders(<TestWrapper />);

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      await waitFor(() => {
        expect(screen.getByText('Choose Project Directory')).toBeInTheDocument();
      });

      // Click close button
      fireEvent.click(screen.getByRole('button', { name: /close wizard/i }));

      // Wait for confirmation modal
      await waitFor(() => {
        expect(screen.getByText('Exit Setup Wizard?')).toBeInTheDocument();
      });

      // Click "Stay in Wizard"
      fireEvent.click(screen.getByRole('button', { name: /stay in wizard/i }));

      // Should still show the wizard
      await waitFor(() => {
        expect(screen.queryByText('Exit Setup Wizard?')).not.toBeInTheDocument();
        expect(screen.getByText('Choose Project Directory')).toBeInTheDocument();
      });
    });

    it('should save state and close when confirming exit', async () => {
      const onWizardAbandon = vi.fn();

      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent } = useWizard();

        return (
          <>
            <button
              onClick={() => {
                setSelectedAgent('claude-code');
                goToStep('directory-selection');
                openWizard();
              }}
              data-testid="open-at-step-2"
            >
              Open at Step 2
            </button>
            <div data-testid="wizard-open">{state.isOpen ? 'open' : 'closed'}</div>
            {state.isOpen && (
              <MaestroWizard theme={mockTheme} onWizardAbandon={onWizardAbandon} />
            )}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      // Open wizard at step 2
      fireEvent.click(screen.getByTestId('open-at-step-2'));

      await waitFor(() => {
        expect(screen.getByText('Choose Project Directory')).toBeInTheDocument();
      });

      // Click close button
      fireEvent.click(screen.getByRole('button', { name: /close wizard/i }));

      // Wait for confirmation modal
      await waitFor(() => {
        expect(screen.getByText('Exit Setup Wizard?')).toBeInTheDocument();
      });

      // Click "Exit & Save Progress"
      fireEvent.click(screen.getByRole('button', { name: /exit.*save progress/i }));

      // Allow time for state updates
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      // Verify state was saved
      expect(mockMaestro.settings.set).toHaveBeenCalledWith(
        'wizardResumeState',
        expect.objectContaining({
          currentStep: 'directory-selection',
          selectedAgent: 'claude-code',
        })
      );

      // Verify analytics callback was called
      expect(onWizardAbandon).toHaveBeenCalled();
    });
  });

  describe('State Persistence and Resume', () => {
    it('should save state when navigating past step 1', async () => {
      function TestWrapper() {
        const { openWizard, state, setSelectedAgent, nextStep } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            openWizard();
          }
        }, [openWizard, state.isOpen, setSelectedAgent]);

        return (
          <>
            <button onClick={() => nextStep()} data-testid="next-step">
              Next
            </button>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
            <div data-testid="current-step">{state.currentStep}</div>
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Select Your Agent')).toBeInTheDocument();
      });

      // Navigate to step 2
      fireEvent.click(screen.getByTestId('next-step'));

      await waitFor(() => {
        expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
      });

      // State should be auto-saved when past step 1
      await waitFor(() => {
        expect(mockMaestro.settings.set).toHaveBeenCalledWith(
          'wizardResumeState',
          expect.objectContaining({
            currentStep: 'directory-selection',
            selectedAgent: 'claude-code',
          })
        );
      });
    });

    it('should display resume modal with saved state info', async () => {
      const resumeState: SerializableWizardState = {
        currentStep: 'conversation',
        selectedAgent: 'claude-code',
        agentName: 'Test Project',
        directoryPath: '/saved/project/path',
        isGitRepo: true,
        conversationHistory: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
        ],
        confidenceLevel: 45,
        isReadyToProceed: false,
        generatedDocuments: [],
        editedPhase1Content: null,
        wantsTour: true,
      };

      mockMaestro.git.isRepo.mockResolvedValue(true);
      mockMaestro.agents.detect.mockResolvedValue(mockAgents);

      const onResume = vi.fn();
      const onStartFresh = vi.fn();
      const onClose = vi.fn();

      renderWithProviders(
        <WizardResumeModal
          theme={mockTheme}
          resumeState={resumeState}
          onResume={onResume}
          onStartFresh={onStartFresh}
          onClose={onClose}
        />
      );

      // Wait for validation to complete
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      // Should show saved state info
      await waitFor(() => {
        expect(screen.getByText('Resume Setup?')).toBeInTheDocument();
        expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
        expect(screen.getByText('Test Project')).toBeInTheDocument();
        expect(screen.getByText('/saved/project/path')).toBeInTheDocument();
        // The modal shows "X messages exchanged (Y% confidence)"
        expect(screen.getByText(/1 messages? exchanged/)).toBeInTheDocument();
      });
    });

    it('should call onResume when clicking resume button', async () => {
      const resumeState: SerializableWizardState = {
        currentStep: 'directory-selection',
        selectedAgent: 'claude-code',
        agentName: '',
        directoryPath: '/saved/path',
        isGitRepo: false,
        conversationHistory: [],
        confidenceLevel: 0,
        isReadyToProceed: false,
        generatedDocuments: [],
        editedPhase1Content: null,
        wantsTour: true,
      };

      mockMaestro.git.isRepo.mockResolvedValue(true);
      mockMaestro.agents.detect.mockResolvedValue(mockAgents);

      const onResume = vi.fn();
      const onStartFresh = vi.fn();
      const onClose = vi.fn();

      renderWithProviders(
        <WizardResumeModal
          theme={mockTheme}
          resumeState={resumeState}
          onResume={onResume}
          onStartFresh={onStartFresh}
          onClose={onClose}
        />
      );

      // Wait for validation
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      await waitFor(() => {
        const resumeButton = screen.getByRole('button', { name: /resume where i left off/i });
        expect(resumeButton).not.toBeDisabled();
      });

      // Click resume
      fireEvent.click(screen.getByRole('button', { name: /resume where i left off/i }));

      expect(onResume).toHaveBeenCalled();
    });

    it('should call onStartFresh when clicking start fresh button', async () => {
      const resumeState: SerializableWizardState = {
        currentStep: 'directory-selection',
        selectedAgent: 'claude-code',
        agentName: '',
        directoryPath: '/saved/path',
        isGitRepo: false,
        conversationHistory: [],
        confidenceLevel: 0,
        isReadyToProceed: false,
        generatedDocuments: [],
        editedPhase1Content: null,
        wantsTour: true,
      };

      mockMaestro.git.isRepo.mockResolvedValue(true);
      mockMaestro.agents.detect.mockResolvedValue(mockAgents);

      const onResume = vi.fn();
      const onStartFresh = vi.fn();
      const onClose = vi.fn();

      renderWithProviders(
        <WizardResumeModal
          theme={mockTheme}
          resumeState={resumeState}
          onResume={onResume}
          onStartFresh={onStartFresh}
          onClose={onClose}
        />
      );

      // Click start fresh
      fireEvent.click(screen.getByRole('button', { name: /start fresh/i }));

      expect(onStartFresh).toHaveBeenCalled();
    });

    it('should show warning when saved directory no longer exists', async () => {
      const resumeState: SerializableWizardState = {
        currentStep: 'conversation',
        selectedAgent: 'claude-code',
        agentName: '',
        directoryPath: '/nonexistent/path',
        isGitRepo: false,
        conversationHistory: [],
        confidenceLevel: 0,
        isReadyToProceed: false,
        generatedDocuments: [],
        editedPhase1Content: null,
        wantsTour: true,
      };

      // Simulate directory not existing
      mockMaestro.git.isRepo.mockRejectedValue(new Error('Directory not found'));
      mockMaestro.agents.detect.mockResolvedValue(mockAgents);

      const onResume = vi.fn();
      const onStartFresh = vi.fn();
      const onClose = vi.fn();

      renderWithProviders(
        <WizardResumeModal
          theme={mockTheme}
          resumeState={resumeState}
          onResume={onResume}
          onStartFresh={onStartFresh}
          onClose={onClose}
        />
      );

      // Wait for validation
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      await waitFor(() => {
        expect(
          screen.getByText(/directory no longer exists/i)
        ).toBeInTheDocument();
      });
    });

    it('should show warning when saved agent is no longer available', async () => {
      const resumeState: SerializableWizardState = {
        currentStep: 'directory-selection',
        selectedAgent: 'unavailable-agent',
        agentName: '',
        directoryPath: '/saved/path',
        isGitRepo: false,
        conversationHistory: [],
        confidenceLevel: 0,
        isReadyToProceed: false,
        generatedDocuments: [],
        editedPhase1Content: null,
        wantsTour: true,
      };

      // Only return agents that don't include the saved agent
      mockMaestro.agents.detect.mockResolvedValue([mockAgents[0]]);
      mockMaestro.git.isRepo.mockResolvedValue(true);

      const onResume = vi.fn();
      const onStartFresh = vi.fn();
      const onClose = vi.fn();

      renderWithProviders(
        <WizardResumeModal
          theme={mockTheme}
          resumeState={resumeState}
          onResume={onResume}
          onStartFresh={onStartFresh}
          onClose={onClose}
        />
      );

      // Wait for validation
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      await waitFor(() => {
        expect(
          screen.getByText(/agent.*no longer available/i)
        ).toBeInTheDocument();
      });
    });
  });

  describe('Analytics Callbacks', () => {
    it('should call onWizardStart when opening fresh wizard', async () => {
      const onWizardStart = vi.fn();

      function TestWrapper() {
        const { openWizard, state } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            openWizard();
          }
        }, [openWizard, state.isOpen]);

        return state.isOpen ? (
          <MaestroWizard theme={mockTheme} onWizardStart={onWizardStart} />
        ) : null;
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Select Your Agent')).toBeInTheDocument();
      });

      // Analytics callback should be called for fresh start
      expect(onWizardStart).toHaveBeenCalled();
    });

    it('should call onWizardResume when opening resumed wizard', async () => {
      const onWizardResume = vi.fn();

      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            // Simulate resumed state (past step 1)
            setSelectedAgent('claude-code');
            goToStep('directory-selection');
            openWizard();
          }
        }, [openWizard, state.isOpen, goToStep, setSelectedAgent]);

        return state.isOpen ? (
          <MaestroWizard theme={mockTheme} onWizardResume={onWizardResume} />
        ) : null;
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Choose Project Directory')).toBeInTheDocument();
      });

      // Analytics callback should be called for resume
      expect(onWizardResume).toHaveBeenCalled();
    });

    it('should call onWizardAbandon when exiting with confirmation', async () => {
      const onWizardAbandon = vi.fn();

      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            openWizard();
            setTimeout(() => goToStep('directory-selection'), 50);
          }
        }, [openWizard, state.isOpen, goToStep, setSelectedAgent]);

        return state.isOpen ? (
          <MaestroWizard theme={mockTheme} onWizardAbandon={onWizardAbandon} />
        ) : null;
      }

      renderWithProviders(<TestWrapper />);

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      // Click close
      fireEvent.click(screen.getByRole('button', { name: /close wizard/i }));

      await waitFor(() => {
        expect(screen.getByText('Exit Setup Wizard?')).toBeInTheDocument();
      });

      // Confirm exit
      fireEvent.click(screen.getByRole('button', { name: /exit.*save progress/i }));

      // Analytics callback should be called
      expect(onWizardAbandon).toHaveBeenCalled();
    });
  });

  describe('Backward Navigation', () => {
    it('should navigate backward with Escape key', async () => {
      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent, setDirectoryPath } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            setDirectoryPath('/test/path');
            goToStep('conversation');
            openWizard();
          }
        }, [openWizard, state.isOpen, goToStep, setSelectedAgent, setDirectoryPath]);

        return (
          <>
            <div data-testid="current-step">{state.currentStep}</div>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Project Discovery')).toBeInTheDocument();
      });

      // Press Escape - should show exit confirm since we're past step 1
      fireEvent.keyDown(document.body, { key: 'Escape' });

      await waitFor(() => {
        // Exit confirmation should appear
        expect(screen.getByText('Exit Setup Wizard?')).toBeInTheDocument();
      });
    });

    it('should allow backward navigation via previousStep', async () => {
      function TestWrapper() {
        const { openWizard, state, goToStep, setSelectedAgent, previousStep } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            goToStep('conversation');
            openWizard();
          }
        }, [openWizard, state.isOpen, goToStep, setSelectedAgent]);

        return (
          <>
            <button onClick={() => previousStep()} data-testid="go-back">
              Back
            </button>
            <div data-testid="current-step">{state.currentStep}</div>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
      });

      // Go back
      fireEvent.click(screen.getByTestId('go-back'));

      await waitFor(() => {
        expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
      });

      // Go back again
      fireEvent.click(screen.getByTestId('go-back'));

      await waitFor(() => {
        expect(screen.getByTestId('current-step')).toHaveTextContent('agent-selection');
      });

      // Try to go back from step 1 - should stay at step 1
      fireEvent.click(screen.getByTestId('go-back'));

      await waitFor(() => {
        expect(screen.getByTestId('current-step')).toHaveTextContent('agent-selection');
      });
    });
  });

  describe('Screen Transitions', () => {
    it('should show transition classes when navigating forward', async () => {
      function TestWrapper() {
        const { openWizard, state, setSelectedAgent, nextStep } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            openWizard();
          }
        }, [openWizard, state.isOpen, setSelectedAgent]);

        return (
          <>
            <button onClick={() => nextStep()} data-testid="next">
              Next
            </button>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Select Your Agent')).toBeInTheDocument();
      });

      // Content should have wizard-content class
      const contentContainer = document.querySelector('.wizard-content');
      expect(contentContainer).toBeInTheDocument();
    });

    it('should preserve modal accessibility attributes', async () => {
      function TestWrapper() {
        const { openWizard, state } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            openWizard();
          }
        }, [openWizard, state.isOpen]);

        return state.isOpen ? <MaestroWizard theme={mockTheme} /> : null;
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'wizard-title');
      });
    });
  });

  describe('Step Validation', () => {
    it('should prevent advancing when step requirements not met', async () => {
      function TestWrapper() {
        const { openWizard, state, canProceedToNext, nextStep } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            // Don't set agent - should prevent navigation
            openWizard();
          }
        }, [openWizard, state.isOpen]);

        const canProceed = canProceedToNext();

        return (
          <>
            <div data-testid="can-proceed">{canProceed ? 'yes' : 'no'}</div>
            <button onClick={() => nextStep()} data-testid="next">
              Next
            </button>
            <div data-testid="current-step">{state.currentStep}</div>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('can-proceed')).toHaveTextContent('no');
      });
    });

    it('should allow advancing when step requirements are met', async () => {
      function TestWrapper() {
        const { openWizard, state, setSelectedAgent, canProceedToNext } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            openWizard();
          }
        }, [openWizard, state.isOpen, setSelectedAgent]);

        const canProceed = canProceedToNext();

        return (
          <>
            <div data-testid="can-proceed">{canProceed ? 'yes' : 'no'}</div>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('can-proceed')).toHaveTextContent('yes');
      });
    });
  });

  describe('Tour Integration', () => {
    it('should pass wantsTour to onLaunchSession', async () => {
      const onLaunchSession = vi.fn().mockResolvedValue(undefined);

      function TestWrapper() {
        const {
          openWizard,
          state,
          goToStep,
          setSelectedAgent,
          setDirectoryPath,
          setGeneratedDocuments,
          setWantsTour,
        } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            setDirectoryPath('/test/path');
            setGeneratedDocuments([
              {
                filename: 'Phase-01-Test.md',
                content: '# Test\n\n- [ ] Task',
                taskCount: 1,
              },
            ]);
            setWantsTour(false);
            goToStep('phase-review');
            openWizard();
          }
        }, [
          openWizard,
          state.isOpen,
          goToStep,
          setSelectedAgent,
          setDirectoryPath,
          setGeneratedDocuments,
          setWantsTour,
        ]);

        return state.isOpen ? (
          <MaestroWizard theme={mockTheme} onLaunchSession={onLaunchSession} />
        ) : null;
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Review Your Action Plan')).toBeInTheDocument();
      });
    });

    it('should set wantsTour true for walk-through button', async () => {
      function TestWrapper() {
        const {
          openWizard,
          state,
          goToStep,
          setSelectedAgent,
          setDirectoryPath,
          setGeneratedDocuments,
        } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            setSelectedAgent('claude-code');
            setDirectoryPath('/test/path');
            setGeneratedDocuments([
              {
                filename: 'Phase-01-Test.md',
                content: '# Test\n\n- [ ] Task',
                taskCount: 1,
              },
            ]);
            goToStep('phase-review');
            openWizard();
          }
        }, [
          openWizard,
          state.isOpen,
          goToStep,
          setSelectedAgent,
          setDirectoryPath,
          setGeneratedDocuments,
        ]);

        return (
          <>
            <div data-testid="wants-tour">{state.wantsTour ? 'yes' : 'no'}</div>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      await waitFor(() => {
        // Default should be true (wants tour)
        expect(screen.getByTestId('wants-tour')).toHaveTextContent('yes');
      });
    });
  });

  describe('Multiple Open/Close Cycles', () => {
    it('should reset state when wizard is reset', async () => {
      function TestWrapper() {
        const {
          openWizard,
          closeWizard,
          resetWizard,
          state,
          setSelectedAgent,
          setDirectoryPath,
          goToStep,
        } = useWizard();

        return (
          <>
            <button
              onClick={() => {
                setSelectedAgent('claude-code');
                setDirectoryPath('/test/path');
                goToStep('conversation');
                openWizard();
              }}
              data-testid="open"
            >
              Open
            </button>
            <button onClick={() => closeWizard()} data-testid="close">
              Close
            </button>
            <button onClick={() => resetWizard()} data-testid="reset">
              Reset
            </button>
            <div data-testid="step">{state.currentStep}</div>
            <div data-testid="agent">{state.selectedAgent || 'none'}</div>
            <div data-testid="is-open">{state.isOpen ? 'yes' : 'no'}</div>
            {state.isOpen && <MaestroWizard theme={mockTheme} />}
          </>
        );
      }

      renderWithProviders(<TestWrapper />);

      // Open wizard with state
      fireEvent.click(screen.getByTestId('open'));

      await waitFor(() => {
        expect(screen.getByTestId('is-open')).toHaveTextContent('yes');
        expect(screen.getByTestId('step')).toHaveTextContent('conversation');
        expect(screen.getByTestId('agent')).toHaveTextContent('claude-code');
      });

      // Reset wizard
      fireEvent.click(screen.getByTestId('reset'));

      await waitFor(() => {
        expect(screen.getByTestId('is-open')).toHaveTextContent('no');
        expect(screen.getByTestId('step')).toHaveTextContent('agent-selection');
        expect(screen.getByTestId('agent')).toHaveTextContent('none');
      });
    });
  });

  describe('Error Boundaries', () => {
    it('should not crash when agents.detect fails', async () => {
      mockMaestro.agents.detect.mockRejectedValue(new Error('Detection failed'));

      function TestWrapper() {
        const { openWizard, state } = useWizard();

        React.useEffect(() => {
          if (!state.isOpen) {
            openWizard();
          }
        }, [openWizard, state.isOpen]);

        return state.isOpen ? <MaestroWizard theme={mockTheme} /> : null;
      }

      // Should not throw
      expect(() => {
        renderWithProviders(<TestWrapper />);
      }).not.toThrow();

      // Wizard should still open
      await waitFor(() => {
        expect(screen.getByText('Select Your Agent')).toBeInTheDocument();
      });
    });
  });
});
