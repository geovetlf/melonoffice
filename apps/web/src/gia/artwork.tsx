/**
 * GIA's portrait, v1 (ADR-0050): a vector illustration of a professional, warm woman with
 * glasses, in MelonOffice's warm palette (amber and coral, never green). It is only artwork: no
 * text, no state and no behaviour live here, so a new illustration replaces this file and nothing
 * else changes. It draws in a 120 × 120 box; `idPrefix` keeps its gradient ids unique on a page.
 */
export function GiaArtwork({ idPrefix }: { readonly idPrefix: string }) {
  const bg = `${idPrefix}-bg`;
  const clip = `${idPrefix}-clip`;
  return (
    <>
      <defs>
        <radialGradient id={bg} cx="35%" cy="28%" r="80%">
          <stop offset="0%" stopColor="#ffe3a8" />
          <stop offset="55%" stopColor="#f5b942" />
          <stop offset="100%" stopColor="#f2784b" />
        </radialGradient>
        <clipPath id={clip}>
          <circle cx="60" cy="60" r="60" />
        </clipPath>
      </defs>
      <circle cx="60" cy="60" r="60" fill={`url(#${bg})`} />
      <g clipPath={`url(#${clip})`}>
        {/* Hair, behind the head: shoulder length. */}
        <path
          d="M30 60 C27 31 43 17 60 17 C78 17 94 31 90 60 L93 88 C84 95 36 95 27 88 Z"
          fill="#3b2420"
        />
        {/* Blazer, blouse and lapels. */}
        <path d="M16 120 C18 98 35 87 60 87 C85 87 102 98 104 120 Z" fill="#8a3442" />
        <path d="M50 88 L60 106 L70 88 Z" fill="#fff1e6" />
        <path d="M50 88 L43 91 L56 113 L60 106 Z" fill="#6f2635" />
        <path d="M70 88 L77 91 L64 113 L60 106 Z" fill="#6f2635" />
        <rect x="53" y="73" width="14" height="18" rx="6" fill="#cf9470" />
        {/* Ears and small gold earrings. */}
        <circle cx="40" cy="58" r="4" fill="#e3a984" />
        <circle cx="80" cy="58" r="4" fill="#e3a984" />
        <circle cx="40" cy="64" r="1.8" fill="#f5b942" />
        <circle cx="80" cy="64" r="1.8" fill="#f5b942" />
        {/* Face. */}
        <ellipse cx="60" cy="56" rx="20" ry="24" fill="#eab48f" />
        <circle cx="48" cy="66" r="3.4" fill="#f2784b" opacity="0.2" />
        <circle cx="72" cy="66" r="3.4" fill="#f2784b" opacity="0.2" />
        {/* Side-swept fringe. */}
        <path
          d="M39 52 C38 33 51 27 62 29 C75 31 83 40 81 53 C73 42 61 37 50 43 C45 46 41 49 39 52 Z"
          fill="#3b2420"
        />
        {/* Brows, eyes, nose and a warm smile. */}
        <g fill="none" strokeLinecap="round">
          <path d="M46.5 48.6 Q51.5 46.2 56 48.2" stroke="#3b2420" strokeWidth="1.6" />
          <path d="M64 48.2 Q68.5 46.2 73.5 48.6" stroke="#3b2420" strokeWidth="1.6" />
          <path d="M60 59.5 Q58.8 64.5 61.4 65.6" stroke="#c07f5c" strokeWidth="1.2" />
          <path d="M53.5 70 Q60 75 66.5 70" stroke="#9c4a3c" strokeWidth="1.8" />
        </g>
        <g className="gia-art__eyes" fill="#2a1a16">
          <ellipse cx="51.5" cy="56.2" rx="1.8" ry="2.2" />
          <ellipse cx="68.5" cy="56.2" rx="1.8" ry="2.2" />
        </g>
        {/* Glasses. */}
        <g fill="#ffffff" fillOpacity="0.12" stroke="#2a1a16" strokeWidth="1.4">
          <rect x="43.5" y="50.5" width="16" height="11.5" rx="4.5" />
          <rect x="60.5" y="50.5" width="16" height="11.5" rx="4.5" />
        </g>
        <path
          d="M59.4 54.6 Q60 53.4 60.6 54.6"
          fill="none"
          stroke="#2a1a16"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </g>
    </>
  );
}
