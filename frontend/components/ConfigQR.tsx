"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

/**
 * The WireGuard config as a scannable QR code.
 *
 * Every WireGuard mobile app imports a tunnel by scanning one of these. The
 * alternative we shipped with was a .conf download, which on a phone means
 * either emailing yourself a file or typing a 44-character base64 private key
 * by hand. That is the difference between one tap and giving up.
 *
 * Rendered entirely in the browser, from the config text that is already here.
 * The private key is in that text, so it must not be sent anywhere to be drawn
 * — no image service, no server round-trip. That rules out every hosted QR API
 * and is the reason this renders to a local canvas.
 */
export function ConfigQR({ text }: { text: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<"drawing" | "ready" | "error">("drawing");
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    QRCode.toCanvas(canvas, text, {
      width: 208,
      margin: 1,
      errorCorrectionLevel: "L", // a config is long; L keeps the modules big enough to scan
      color: { dark: "#0b0f1a", light: "#f5f3ea" },
    })
      .then(() => !cancelled && setState("ready"))
      .catch(() => !cancelled && setState("error"));

    return () => {
      cancelled = true;
    };
  }, [text]);

  if (state === "error") {
    return (
      <div className="qr-panel">
        <div className="qr-fallback">
          This config is too long to fit in a QR code. Use <strong>Download .conf</strong> and
          import the file instead.
        </div>
      </div>
    );
  }

  return (
    <div className="qr-panel">
      <div className={`qr-frame${revealed ? " revealed" : ""}`}>
        <canvas ref={canvasRef} aria-label="WireGuard configuration QR code" />
        {!revealed && (
          <button className="qr-cover" onClick={() => setRevealed(true)}>
            <span className="qr-cover-label">Tap to reveal</span>
            <span className="qr-cover-sub">contains your private key</span>
          </button>
        )}
      </div>
      <div className="qr-help">
        <strong>Scan from your phone</strong>
        <ol>
          <li>Install WireGuard from the App Store or Play Store.</li>
          <li>
            Tap <span className="mono">+</span> then <span className="mono">Scan from QR code</span>.
          </li>
          <li>Point it at this code and give the tunnel a name.</li>
        </ol>
        <p>
          Anyone who photographs this code can use your VPN time. It is covered until you ask for
          it, and it is shown only once.
        </p>
      </div>
    </div>
  );
}
