import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleRequestError } from '../commercial/consoleClient.js';
import { failureOf } from '../commercial/PartnerConsole.js';
import { REAUTHENTICATION_REQUIRED, SignInAgain } from './SignInAgain.js';

const signOut = vi.fn();
vi.mock('./AuthProvider.js', () => ({ useAuth: () => ({ signOut }) }));

afterEach(() => {
  cleanup();
  signOut.mockClear();
});

describe('signing in again for sensitive administration (ADR-0138)', () => {
  it('says why the change was refused and signs out so the person signs in again', () => {
    render(
      <I18nProvider locale="es">
        <SignInAgain />
      </I18nProvider>,
    );
    expect(
      screen.getByText('Por tu seguridad, vuelve a iniciar sesión para hacer este cambio.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a iniciar sesión' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('is what the partner console shows for that refusal', () => {
    expect(failureOf(new ConsoleRequestError(403, REAUTHENTICATION_REQUIRED))).toEqual({
      id: 'identity.signInAgain.message',
    });
  });
});
