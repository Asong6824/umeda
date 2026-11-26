// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  current: {
    mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
    isInitializing: false,
    ownerBoundaryPending: false,
    dataOwnerId: 'user-1' as string | null,
    canEnterApp: true,
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

vi.mock('@/components/error/AppCrashScreen', () => ({
  AppCrashScreen: () => <div data-testid="startup-recovery" />,
}));

import { ProtectedRoute } from '../ProtectedRoute';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div data-testid="login-page" />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<div data-testid="app-shell" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  afterEach(() => {
    cleanup();
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
      ownerBoundaryPending: false,
      dataOwnerId: 'user-1',
      canEnterApp: true,
    };
  });

  it('keeps the shell mounted while same-owner refresh still allows entry', () => {
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
      ownerBoundaryPending: false,
      dataOwnerId: 'user-1',
      canEnterApp: true,
    };
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(screen.queryByTestId('login-page')).toBeNull();
  });

  it('leaves the shell during a real owner-change window', () => {
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
      ownerBoundaryPending: true,
      dataOwnerId: 'user-1',
      canEnterApp: false,
    };
    renderAt('/');
    expect(screen.queryByTestId('login-page')).toBeNull();
    expect(screen.queryByTestId('startup-recovery')).toBeNull();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('shows recovery instead of the retired login for a failed local startup', () => {
    authState.current = {
      mode: 'signed-out',
      isInitializing: false,
      ownerBoundaryPending: false,
      dataOwnerId: null,
      canEnterApp: false,
    };
    renderAt('/');
    expect(screen.queryByTestId('login-page')).toBeNull();
    expect(screen.getByTestId('startup-recovery')).toBeTruthy();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('lets local mode enter the app without a Cindy account', () => {
    authState.current = {
      mode: 'local',
      isInitializing: false,
      ownerBoundaryPending: false,
      dataOwnerId: 'local-v1',
      canEnterApp: true,
    };
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });
});
