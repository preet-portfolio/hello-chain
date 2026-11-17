import { ImageResponse } from "next/og";

// Share card: paper background, the seal mark, the name, and one sample hello. Original artwork.
export const alt = "Hello, Chain — a guestbook on the blockchain, signed with Face ID or a fingerprint";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#f6f1e7";
const SURFACE = "#fffcf6";
const INK = "#1f1b16";
const MUTED = "#5c554b";
const LINE = "#e2d9c8";
const ACCENT = "#b23a0e";

function Seal({ px }: { px: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="15" fill={ACCENT} />
      <circle cx="16" cy="16" r="12.6" fill="none" stroke={SURFACE} strokeOpacity="0.35" strokeWidth="1" />
      <rect x="6.6" y="12.2" width="11" height="7.6" rx="3.8" fill="none" stroke={SURFACE} strokeWidth="2.4" />
      <rect x="14.4" y="12.2" width="11" height="7.6" rx="3.8" fill="none" stroke={SURFACE} strokeWidth="2.4" />
    </svg>
  );
}

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          color: INK,
          padding: "72px 84px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Seal px={64} />
          <div style={{ fontSize: 26, letterSpacing: 4, color: ACCENT, fontWeight: 700 }}>A PUBLIC GUESTBOOK</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 124, fontWeight: 700, letterSpacing: -4, lineHeight: 1 }}>
            Hello,&nbsp;<span style={{ color: ACCENT }}>Chain</span>
          </div>
          <div style={{ marginTop: 24, fontSize: 36, color: MUTED, maxWidth: 900, lineHeight: 1.35 }}>
            Sign with Face ID or your fingerprint. No wallet, no fees — and no one can edit it.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignSelf: "flex-start",
            background: SURFACE,
            border: `2px solid ${LINE}`,
            borderRadius: 24,
            padding: "22px 28px",
            minWidth: 620,
          }}
        >
          <div style={{ fontSize: 30 }}>gm from the other side of the screen</div>
          <div style={{ marginTop: 10, fontSize: 22, color: MUTED }}>Quiet Otter #7f3a · just now · signed with a passkey</div>
        </div>
      </div>
    ),
    size,
  );
}
