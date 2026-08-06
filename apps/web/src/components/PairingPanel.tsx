import { useState } from "react";
import type { PairingStatus } from "@divisio/contracts";

interface Props {
  status: PairingStatus;
  onCreateToken(): Promise<{ url: string; expiresAt: string; fingerprint: string | null }>;
  onRevoke(clientId: string): Promise<void>;
  onRevokeAll(): Promise<void>;
  onClose(): void;
}

export function PairingPanel({ status, onCreateToken, onRevoke, onRevokeAll, onClose }: Props) {
  const [link, setLink] = useState<{ url: string; expiresAt: string; fingerprint: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mint = async () => {
    setError(null);
    try {
      setLink(await onCreateToken());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 100%)" }}>
        <h2>Paired devices</h2>

        {!status.remote ? (
          <span className="hint">
            Remote access is off. The daemon is bound to loopback, so only this machine can reach it. Start it
            with <code>DIVISIO_BIND</code> set to a LAN or Tailscale address to enable pairing.
          </span>
        ) : (
          <>
            <span className="hint">
              Reachable at <code>{status.address}</code>
              {status.tls ? " over TLS" : " over an encrypted overlay"}.
            </span>

            {status.clients.length === 0 ? (
              <span className="hint">No devices paired yet.</span>
            ) : (
              <div className="lane-list">
                {status.clients.map((c) => (
                  <div key={c.id} className="lane-row">
                    <div className="lane-main">
                      <span className="label">{c.label}</span>
                      <span className="lane-meta">
                        <span>paired {new Date(c.createdAt).toLocaleString()}</span>
                        <span>{c.lastSeenAt ? `last seen ${new Date(c.lastSeenAt).toLocaleString()}` : "never connected"}</span>
                      </span>
                    </div>
                    <button className="icon" onClick={() => void onRevoke(c.id)}>
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            )}

            {link ? (
              <>
                {/*
                  Shown once. The token is single-use and short-lived, but it is
                  still a credential — treat the link like a password.
                */}
                <span className="hint">
                  Open this on the device. It works once and expires{" "}
                  {new Date(link.expiresAt).toLocaleTimeString()}.
                </span>
                <code className="pair-url">{link.url}</code>
                {link.fingerprint && (
                  <span className="hint">
                    Certificate is self-signed. Check the device shows this fingerprint before trusting it:
                    <br />
                    <code>{link.fingerprint}</code>
                  </span>
                )}
              </>
            ) : (
              <button className="btn" onClick={() => void mint()}>
                Create pairing link
              </button>
            )}
          </>
        )}

        {error && <span className="hint danger">{error}</span>}

        <div className="actions">
          {status.clients.length > 0 && (
            <button className="btn danger" onClick={() => void onRevokeAll()}>
              Revoke all
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
