// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exitLocalMode: vi.fn(),
  logout: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    dataOwnerId: 'local-v1',
    mode: 'local',
    exitLocalMode: mocks.exitLocalMode,
    logout: mocks.logout,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: mocks.warn,
    error: vi.fn(),
  }),
}));

vi.mock('@/components/error/LocalDbFatalScreen', () => ({
  LocalDbFatalScreen: ({ onBackToLogin, onRetry }: { onBackToLogin?: () => void; onRetry?: () => void }) => (
    <div>
      {onBackToLogin && <button onClick={onBackToLogin}>back to login</button>}
      <button onClick={onRetry}>retry database</button>
    </div>
  ),
}));

import { LocalDbGate } from '../LocalDbGate';

describe('LocalDbGate fatal recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exitLocalMode.mockRejectedValue(new Error('owner teardown failed'));
    mocks.logout.mockResolvedValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      localDb: {
        ensureReady: vi.fn().mockResolvedValue({
          ready: false,
          error: { code: 'DB_INIT_FAILED', message: 'broken database' },
        }),
      },
      appReadyForBot: vi.fn(),
    };
  });

  it('retries the personal database without discarding its local identity', async () => {
    render(
      <MemoryRouter initialEntries={['/app']}>
        <Routes>
          <Route path="/app" element={<LocalDbGate />}>
            <Route index element={<div>main</div>} />
          </Route>
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'retry database' }));
    await waitFor(() => expect(window.electronAPI.localDb.ensureReady).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'back to login' })).toBeNull();
    expect(screen.queryByText('login page')).toBeNull();
    expect(mocks.exitLocalMode).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});
