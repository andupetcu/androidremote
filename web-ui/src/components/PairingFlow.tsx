import { useState, useEffect, useCallback, type ReactElement } from 'react';

export interface PairingResult {
  sessionToken: string;
  deviceId: string;
  deviceName: string;
}

export interface PairingFlowProps {
  onPaired?: (result: PairingResult) => void;
}

interface PairingData {
  pairingCode: string;
  qrCodeData: string;
  expiresAt: number;
}

type PairingState =
  | { status: 'loading' }
  | { status: 'qr'; data: PairingData }
  | { status: 'manual'; data: PairingData }
  | { status: 'connecting' }
  | { status: 'success'; result: PairingResult }
  | { status: 'error'; message: string };

export function PairingFlow({ onPaired }: PairingFlowProps): ReactElement {
  const [state, setState] = useState<PairingState>({ status: 'loading' });
  const [manualCode, setManualCode] = useState('');
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

  const initiatePairing = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const response = await fetch('/api/pair/initiate', { method: 'POST' });
      if (!response.ok) {
        throw new Error('Failed to initiate pairing');
      }
      const data: PairingData = await response.json();
      setState({ status: 'qr', data });
    } catch {
      setState({ status: 'error', message: 'Failed to initiate pairing' });
    }
  }, []);

  useEffect(() => {
    initiatePairing();
  }, [initiatePairing]);

  // Timer for expiration countdown
  useEffect(() => {
    if (state.status !== 'qr' && state.status !== 'manual') return;

    const updateTimer = () => {
      const remaining = Math.max(0, Math.floor((state.data.expiresAt - Date.now()) / 1000));
      setTimeRemaining(remaining);
      if (remaining === 0) {
        setState({ status: 'error', message: 'Pairing code expired' });
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [state]);

  const handleConnect = async () => {
    setState({ status: 'connecting' });
    try {
      const response = await fetch('/api/pair/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairingCode: manualCode,
          controllerPublicKey: `controller-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        setState({ status: 'error', message: error.error || 'Invalid code' });
        return;
      }

      const result: PairingResult = await response.json();
      setState({ status: 'success', result });
      onPaired?.(result);
    } catch {
      setState({ status: 'error', message: 'Connection failed' });
    }
  };

  const toggleMode = () => {
    if (state.status === 'qr') {
      setState({ status: 'manual', data: state.data });
    } else if (state.status === 'manual') {
      setState({ status: 'qr', data: state.data });
    }
  };

  const isCodeValid = manualCode.length === 6;

  if (state.status === 'loading') {
    return <div>Loading...</div>;
  }

  if (state.status === 'error') {
    return (
      <div>
        <p>{state.message}</p>
        <button onClick={initiatePairing} aria-label="Retry">
          Retry
        </button>
      </div>
    );
  }

  if (state.status === 'connecting') {
    return <div>Connecting...</div>;
  }

  if (state.status === 'success') {
    return <div>Paired successfully!</div>;
  }

  // QR or Manual mode
  const { data } = state;
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div>
      {state.status === 'qr' ? (
        <>
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(data.qrCodeData)}&size=200x200`}
            alt="Pairing QR code"
            role="img"
          />
          <p>Code: {data.pairingCode}</p>
          <button onClick={toggleMode}>Enter code manually</button>
        </>
      ) : (
        <>
          <label htmlFor="pairing-code">Pairing code</label>
          <input
            id="pairing-code"
            type="text"
            maxLength={6}
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value.replace(/\D/g, ''))}
            placeholder="Enter 6-digit code"
          />
          <button onClick={handleConnect} disabled={!isCodeValid} aria-label="Connect">
            Connect
          </button>
          <button onClick={toggleMode}>Show QR code</button>
        </>
      )}
      {timeRemaining !== null && (
        <p>Expires in {formatTime(timeRemaining)}</p>
      )}
    </div>
  );
}
