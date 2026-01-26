import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, vi } from 'vitest';
import { server } from './mocks/server';
import { PairingFlow } from '../components/PairingFlow';

describe('PairingFlow', () => {
  describe('QR Code Display', () => {
    it('displays QR code for pairing', async () => {
      render(<PairingFlow />);

      // Wait for QR code to load
      await waitFor(() => {
        expect(screen.getByRole('img', { name: /pairing qr code/i })).toBeInTheDocument();
      });
    });

    it('shows pairing code alongside QR', async () => {
      render(<PairingFlow />);

      await waitFor(() => {
        expect(screen.getByText(/123456/)).toBeInTheDocument();
      });
    });

    it('shows expiration timer', async () => {
      render(<PairingFlow />);

      await waitFor(() => {
        expect(screen.getByText(/expires in/i)).toBeInTheDocument();
      });
    });
  });

  describe('Manual Code Entry', () => {
    it('accepts manual code entry', async () => {
      const user = userEvent.setup();
      render(<PairingFlow />);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText(/enter code manually/i)).toBeInTheDocument();
      });

      // Switch to manual entry
      await user.click(screen.getByText(/enter code manually/i));

      // Enter code
      const codeInput = screen.getByLabelText(/pairing code/i);
      await user.type(codeInput, '123456');

      // Click connect
      await user.click(screen.getByRole('button', { name: /connect/i }));

      // Should show connecting or success state (connection may complete instantly in tests)
      await waitFor(() => {
        const connecting = screen.queryByText(/connecting/i);
        const success = screen.queryByText(/paired successfully/i);
        expect(connecting || success).toBeTruthy();
      });
    });

    it('shows error on invalid code', async () => {
      const user = userEvent.setup();

      // Override the handler for this test
      server.use(
        http.post('/api/pair/complete', () => {
          return HttpResponse.json({ error: 'Invalid code' }, { status: 401 });
        })
      );

      render(<PairingFlow />);

      // Switch to manual entry
      await waitFor(() => {
        expect(screen.getByText(/enter code manually/i)).toBeInTheDocument();
      });
      await user.click(screen.getByText(/enter code manually/i));

      // Enter invalid code
      const codeInput = screen.getByLabelText(/pairing code/i);
      await user.type(codeInput, '000000');

      // Click connect
      await user.click(screen.getByRole('button', { name: /connect/i }));

      // Should show error message
      await waitFor(() => {
        expect(screen.getByText(/invalid code/i)).toBeInTheDocument();
      });
    });

    it('validates code format before submission', async () => {
      const user = userEvent.setup();
      render(<PairingFlow />);

      await waitFor(() => {
        expect(screen.getByText(/enter code manually/i)).toBeInTheDocument();
      });
      await user.click(screen.getByText(/enter code manually/i));

      // Enter invalid format (too short)
      const codeInput = screen.getByLabelText(/pairing code/i);
      await user.type(codeInput, '123');

      // Connect button should be disabled
      expect(screen.getByRole('button', { name: /connect/i })).toBeDisabled();
    });
  });

  describe('Pairing Success', () => {
    it('calls onPaired callback on successful pairing', async () => {
      const user = userEvent.setup();
      const onPaired = vi.fn();
      render(<PairingFlow onPaired={onPaired} />);

      // Switch to manual entry and enter valid code
      await waitFor(() => {
        expect(screen.getByText(/enter code manually/i)).toBeInTheDocument();
      });
      await user.click(screen.getByText(/enter code manually/i));

      const codeInput = screen.getByLabelText(/pairing code/i);
      await user.type(codeInput, '123456');
      await user.click(screen.getByRole('button', { name: /connect/i }));

      // Wait for callback
      await waitFor(() => {
        expect(onPaired).toHaveBeenCalledWith({
          sessionToken: 'valid-session-token',
          deviceId: 'device-123',
          deviceName: 'Test Device',
        });
      });
    });

    it('shows success message before transitioning', async () => {
      const user = userEvent.setup();
      render(<PairingFlow />);

      await waitFor(() => {
        expect(screen.getByText(/enter code manually/i)).toBeInTheDocument();
      });
      await user.click(screen.getByText(/enter code manually/i));

      const codeInput = screen.getByLabelText(/pairing code/i);
      await user.type(codeInput, '123456');
      await user.click(screen.getByRole('button', { name: /connect/i }));

      await waitFor(() => {
        expect(screen.getByText(/paired successfully/i)).toBeInTheDocument();
      });
    });
  });

  describe('Loading and Error States', () => {
    it('shows loading state while fetching QR code', () => {
      render(<PairingFlow />);

      // Initially should show loading
      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });

    it('handles API error when initiating pairing', async () => {
      server.use(
        http.post('/api/pair/initiate', () => {
          return HttpResponse.json({ error: 'Server error' }, { status: 500 });
        })
      );

      render(<PairingFlow />);

      await waitFor(() => {
        expect(screen.getByText(/failed to initiate pairing/i)).toBeInTheDocument();
      });
    });

    it('allows retry after error', async () => {
      const user = userEvent.setup();

      // First request fails
      server.use(
        http.post('/api/pair/initiate', () => {
          return HttpResponse.json({ error: 'Server error' }, { status: 500 });
        }, { once: true })
      );

      render(<PairingFlow />);

      // Wait for error
      await waitFor(() => {
        expect(screen.getByText(/failed to initiate pairing/i)).toBeInTheDocument();
      });

      // Click retry
      await user.click(screen.getByRole('button', { name: /retry/i }));

      // Should now show QR code
      await waitFor(() => {
        expect(screen.getByRole('img', { name: /pairing qr code/i })).toBeInTheDocument();
      });
    });
  });

  describe('Mode Toggle', () => {
    it('can switch between QR and manual entry modes', async () => {
      const user = userEvent.setup();
      render(<PairingFlow />);

      await waitFor(() => {
        expect(screen.getByRole('img', { name: /pairing qr code/i })).toBeInTheDocument();
      });

      // Switch to manual
      await user.click(screen.getByText(/enter code manually/i));
      expect(screen.getByLabelText(/pairing code/i)).toBeInTheDocument();

      // Switch back to QR
      await user.click(screen.getByText(/show qr code/i));
      expect(screen.getByRole('img', { name: /pairing qr code/i })).toBeInTheDocument();
    });
  });
});
