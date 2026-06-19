/**
 * Self-hosted Dexa mascot — a rounded blue gradient "speech blob" with a tail
 * at the bottom-left and two glowing white eyes, recreated as inline SVG so the
 * rebuild has no dependency on the original app's asset.
 * (To use the pixel-exact original instead, drop dexa-mascot.png into /public
 *  and swap this for <img src="/dexa-mascot.png" />.)
 */
export function DexaMascot({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Dexa"
    >
      <defs>
        <linearGradient id="dexaBody" x1="16%" y1="6%" x2="84%" y2="98%">
          <stop offset="0%" stopColor="#a3daff" />
          <stop offset="44%" stopColor="#3f83f8" />
          <stop offset="100%" stopColor="#3a33d6" />
        </linearGradient>
        <radialGradient id="dexaGlow" cx="32%" cy="26%" r="70%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="55%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        d="M55 11 C78 6 101 13 109 33 C116 49 112 69 101 82 C95 90 85 94 74 96 C65 97 59 101 54 109 L40 119 C43 106 40 98 32 93 C20 85 12 73 12 56 C12 33 33 16 55 11 Z"
        fill="url(#dexaBody)"
      />
      <path
        d="M55 11 C78 6 101 13 109 33 C116 49 112 69 101 82 C95 90 85 94 74 96 C65 97 59 101 54 109 L40 119 C43 106 40 98 32 93 C20 85 12 73 12 56 C12 33 33 16 55 11 Z"
        fill="url(#dexaGlow)"
      />
      <rect x="47" y="45" width="11" height="29" rx="5.5" fill="#ffffff" />
      <rect x="68" y="47" width="11" height="29" rx="5.5" fill="#ffffff" />
    </svg>
  );
}
