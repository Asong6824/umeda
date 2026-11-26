// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const signInMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useSignInToCindy', () => ({
  useSignInToCindy: () => signInMock,
}));

import { HomeZeroModelAction } from '../HomeZeroModelAction';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderCard(authMode: 'signed-out' | 'local' | 'cloud') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <HomeZeroModelAction authMode={authMode} narrow={false} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/settings" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  signInMock.mockReset();
});

describe('HomeZeroModelAction', () => {
  // Personal startup opens the provider wizard in every persisted account mode (unit).
  it.each(['signed-out', 'local', 'cloud'] as const)('%s: connects a provider without Cindy sign-in', (mode) => {
    renderCard(mode);
    expect(screen.getByText('onboarding.connectProvider.title')).toBeTruthy();
    fireEvent.click(screen.getByTestId('home-zero-model-cta'));
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('loc').textContent).toBe('/settings?tab=providers&wizard=1');
  });
});
