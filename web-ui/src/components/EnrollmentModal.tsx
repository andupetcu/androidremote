import { useState, useEffect, useRef } from 'react';
import './EnrollmentModal.css';

const API_BASE_URL = import.meta.env.DEV ? 'http://localhost:7899' : '';

interface EnrollmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface EnrollmentToken {
  id: string;
  token: string;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
  status: string;
}

type Tab = 'enroll' | 'deploy';
type Step = 'generate' | 'waiting' | 'success';

export function EnrollmentModal({ isOpen, onClose, onSuccess }: EnrollmentModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('enroll');
  const [step, setStep] = useState<Step>('generate');
  const [token, setToken] = useState<EnrollmentToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const pollIntervalRef = useRef<number | null>(null);
  const mountIdRef = useRef(Math.random().toString(36).slice(2, 8));

  // Deploy tab state
  const [deployMaxUses, setDeployMaxUses] = useState('1000');
  const [deployExpiryHours, setDeployExpiryHours] = useState('72');
  const [deployToken, setDeployToken] = useState<string | null>(null);
  const [deployServerUrl, setDeployServerUrl] = useState('');
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Track mounts
  useEffect(() => {
    console.log('[Enrollment] Component MOUNTED, id:', mountIdRef.current);
    return () => {
      console.log('[Enrollment] Component UNMOUNTED, id:', mountIdRef.current);
    };
  }, []);

  // Reset state when modal opens/closes
  useEffect(() => {
    console.log('[Enrollment] isOpen changed:', isOpen, 'id:', mountIdRef.current, 'current step:', step);
    if (!isOpen) {
      console.log('[Enrollment] Modal closed, resetting state, id:', mountIdRef.current);
      setActiveTab('enroll');
      setStep('generate');
      setToken(null);
      setError(null);
      setIsLoading(false);
      setDeployToken(null);
      setDeployServerUrl('');
      setCopiedField(null);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
  }, [isOpen, step]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  if (!isOpen) return null;

  const generateToken = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/enroll/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxUses: 1,
          expiresInHours: 24,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to generate enrollment token');
      }

      const newToken: EnrollmentToken = await response.json();
      setToken(newToken);
      setStep('waiting');

      // Start polling for device enrollment
      startPolling(newToken.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setIsLoading(false);
    }
  };

  const startPolling = (tokenCode: string) => {
    // Poll every 2 seconds to check if a device enrolled
    pollIntervalRef.current = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/enroll/tokens`);
        if (response.ok) {
          const data = await response.json();
          const currentToken = data.tokens.find((t: EnrollmentToken) => t.token === tokenCode);

          console.log('[Enrollment] Polling token:', tokenCode, 'Found:', currentToken?.token, 'Status:', currentToken?.status);

          if (currentToken) {
            if (currentToken.usedCount > 0 || currentToken.status === 'exhausted') {
              // Device enrolled successfully
              console.log('[Enrollment] Device enrolled!');
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setStep('success');
              onSuccess();
            } else if (currentToken.status === 'expired' || currentToken.status === 'revoked') {
              // Token is no longer valid
              console.log('[Enrollment] Token expired/revoked:', currentToken.status);
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setError('Enrollment token expired or was revoked');
              setStep('generate');
            }
          } else {
            console.log('[Enrollment] Token not found in response!');
          }
        }
      } catch (err) {
        console.log('[Enrollment] Polling error:', err);
      }
    }, 2000);
  };

  const copyToClipboard = (text: string, field?: string) => {
    navigator.clipboard.writeText(text);
    if (field) {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const formatTimeRemaining = () => {
    if (!token) return '';
    const remaining = token.expiresAt - Date.now();
    if (remaining <= 0) return 'Expired';
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}h ${minutes}m remaining`;
    return `${minutes}m remaining`;
  };

  // Deploy tab: generate a multi-use token and build deployment scripts
  const generateDeployScripts = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const maxUses = parseInt(deployMaxUses, 10) || 1000;
      const expiresInHours = parseInt(deployExpiryHours, 10) || 72;

      const response = await fetch(`${API_BASE_URL}/api/enroll/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxUses, expiresInHours }),
      });

      if (!response.ok) {
        throw new Error('Failed to generate deployment token');
      }

      const newToken: EnrollmentToken = await response.json();
      setDeployToken(newToken.token);

      // Derive server URL for the deployment scripts
      const serverUrl = API_BASE_URL || window.location.origin;
      setDeployServerUrl(serverUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setIsLoading(false);
    }
  };

  const getWindowsScript = () => {
    if (!deployToken || !deployServerUrl) return '';
    return `irm ${deployServerUrl}/api/downloads/agent/windows -OutFile $env:TEMP\\agent.exe; & $env:TEMP\\agent.exe install --server-url "${deployServerUrl}" --enroll-token "${deployToken}"`;
  };

  const getLinuxScript = () => {
    if (!deployToken || !deployServerUrl) return '';
    return `curl -fsSL ${deployServerUrl}/api/downloads/agent/linux -o /tmp/agent && chmod +x /tmp/agent && sudo /tmp/agent install --server-url "${deployServerUrl}" --enroll-token "${deployToken}"`;
  };

  const getInstallerUrl = (platform: string, tokenValue: string) => {
    const base = API_BASE_URL || window.location.origin;
    return `${base}/api/downloads/installer/${platform}?token=${encodeURIComponent(tokenValue)}`;
  };

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setError(null);
  };

  return (
    <div className="enrollment-modal__backdrop" onClick={handleBackdropClick}>
      <div className="enrollment-modal">
        <div className="enrollment-modal__header">
          <h2>Add Devices</h2>
          <button className="enrollment-modal__close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="enrollment-modal__tabs">
          <button
            className={`enrollment-modal__tab ${activeTab === 'enroll' ? 'enrollment-modal__tab--active' : ''}`}
            onClick={() => handleTabChange('enroll')}
          >
            Enroll Device
          </button>
          <button
            className={`enrollment-modal__tab ${activeTab === 'deploy' ? 'enrollment-modal__tab--active' : ''}`}
            onClick={() => handleTabChange('deploy')}
          >
            Deploy Agent
          </button>
        </div>

        <div className="enrollment-modal__body">
          {/* ─── Enroll Device Tab ─── */}
          {activeTab === 'enroll' && (
            <>
              {step === 'generate' && (
                <>
                  <p className="enrollment-modal__instructions">
                    Generate an enrollment token and share it with the device user.
                    They will enter this code in the Android app to enroll.
                  </p>

                  {error && <p className="enrollment-modal__error">{error}</p>}

                  <div className="enrollment-modal__actions">
                    <button
                      type="button"
                      className="enrollment-modal__cancel"
                      onClick={onClose}
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="enrollment-modal__submit"
                      onClick={generateToken}
                      disabled={isLoading}
                    >
                      {isLoading ? 'Generating...' : 'Generate Token'}
                    </button>
                  </div>
                </>
              )}

              {step === 'waiting' && token && (
                <>
                  <p className="enrollment-modal__instructions">
                    Share this enrollment code with the device user:
                  </p>

                  <div className="enrollment-modal__token-display">
                    <span className="enrollment-modal__token">{token.token}</span>
                    <button
                      type="button"
                      className="enrollment-modal__copy"
                      onClick={() => copyToClipboard(token.token)}
                      title="Copy to clipboard"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    </button>
                  </div>

                  <p className="enrollment-modal__timer">{formatTimeRemaining()}</p>

                  <div className="enrollment-modal__installer-downloads">
                    <p className="enrollment-modal__installer-label">Or download a pre-configured installer:</p>
                    <div className="enrollment-modal__installer-buttons">
                      <a
                        href={getInstallerUrl('windows', token.token)}
                        className="enrollment-modal__installer-btn"
                        download
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Windows Installer
                      </a>
                    </div>
                  </div>

                  <div className="enrollment-modal__waiting">
                    <div className="spinner" />
                    <p>Waiting for device to enroll...</p>
                  </div>

                  <div className="enrollment-modal__actions">
                    <button
                      type="button"
                      className="enrollment-modal__cancel"
                      onClick={onClose}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}

              {step === 'success' && (
                <>
                  <div className="enrollment-modal__success">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                    <h3>Device Enrolled!</h3>
                    <p>The device has been successfully enrolled and will appear in your dashboard.</p>
                  </div>

                  <div className="enrollment-modal__actions">
                    <button
                      type="button"
                      className="enrollment-modal__submit"
                      onClick={onClose}
                    >
                      Done
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {/* ─── Deploy Agent Tab ─── */}
          {activeTab === 'deploy' && (
            <>
              {!deployToken ? (
                <>
                  <p className="enrollment-modal__instructions">
                    Generate deployment scripts for mass agent installation. A multi-use enrollment token
                    will be created that can be used across many devices.
                  </p>

                  {error && <p className="enrollment-modal__error">{error}</p>}

                  <div className="enrollment-modal__deploy-fields">
                    <label className="enrollment-modal__field">
                      <span>Max devices</span>
                      <input
                        type="number"
                        value={deployMaxUses}
                        onChange={(e) => setDeployMaxUses(e.target.value)}
                        min="1"
                        max="100000"
                      />
                    </label>
                    <label className="enrollment-modal__field">
                      <span>Token expiry (hours)</span>
                      <input
                        type="number"
                        value={deployExpiryHours}
                        onChange={(e) => setDeployExpiryHours(e.target.value)}
                        min="1"
                        max="8760"
                      />
                    </label>
                  </div>

                  <div className="enrollment-modal__actions">
                    <button
                      type="button"
                      className="enrollment-modal__cancel"
                      onClick={onClose}
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="enrollment-modal__submit"
                      onClick={generateDeployScripts}
                      disabled={isLoading}
                    >
                      {isLoading ? 'Generating...' : 'Generate Deploy Scripts'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="enrollment-modal__instructions">
                    Copy the one-liner for your target platform. Run it on each device to install and enroll the agent.
                  </p>

                  <div className="enrollment-modal__script-block">
                    <div className="enrollment-modal__script-header">
                      <strong>Windows (PowerShell as Admin)</strong>
                      <button
                        type="button"
                        className="enrollment-modal__copy-btn"
                        onClick={() => copyToClipboard(getWindowsScript(), 'windows')}
                      >
                        {copiedField === 'windows' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <pre className="enrollment-modal__script">{getWindowsScript()}</pre>
                  </div>

                  <div className="enrollment-modal__script-block">
                    <div className="enrollment-modal__script-header">
                      <strong>Linux (bash as root)</strong>
                      <button
                        type="button"
                        className="enrollment-modal__copy-btn"
                        onClick={() => copyToClipboard(getLinuxScript(), 'linux')}
                      >
                        {copiedField === 'linux' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <pre className="enrollment-modal__script">{getLinuxScript()}</pre>
                  </div>

                  <div className="enrollment-modal__installer-downloads">
                    <p className="enrollment-modal__installer-label">Download pre-configured installers:</p>
                    <div className="enrollment-modal__installer-buttons">
                      <a
                        href={getInstallerUrl('windows', deployToken)}
                        className="enrollment-modal__installer-btn"
                        download
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Windows Installer
                      </a>
                    </div>
                    <p className="enrollment-modal__installer-hint">
                      These installers have the enrollment token pre-configured. Just run them.
                    </p>
                  </div>

                  <p className="enrollment-modal__deploy-info">
                    Token: <code>{deployToken}</code> &middot; Max uses: {deployMaxUses} &middot; Expires in {deployExpiryHours}h
                  </p>

                  <div className="enrollment-modal__actions">
                    <button
                      type="button"
                      className="enrollment-modal__cancel"
                      onClick={() => { setDeployToken(null); setCopiedField(null); }}
                    >
                      Generate New
                    </button>
                    <button
                      type="button"
                      className="enrollment-modal__submit"
                      onClick={onClose}
                    >
                      Done
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {activeTab === 'enroll' && step === 'waiting' && (
          <div className="enrollment-modal__help">
            <p>
              <strong>Instructions for device user:</strong>
            </p>
            <ol>
              <li>Open the Android Remote app</li>
              <li>Enter the 8-character enrollment code</li>
              <li>Tap "Enroll" to complete setup</li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
