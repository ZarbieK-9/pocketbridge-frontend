'use client';

/**
 * PocketBridge Logo — SVG bridge with phone and wifi signals
 * Matches the brand icon (icon-192.jpg / icon-512.jpg)
 */

interface LogoProps {
  size?: number;
  className?: string;
}

/** Full PocketBridge logo — bridge + phone + wifi */
export function PocketBridgeLogo({ size = 120, className }: LogoProps) {
  const bridgeBlue = '#3B8DD0';
  const bridgeLight = '#5BAAE0';
  const bridgeDark = '#2B6EA8';
  const phoneScreen = '#E8F4FF';
  const signalColor = '#2B6EA8';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="pb-bridgeGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={bridgeLight} />
          <stop offset="1" stopColor={bridgeDark} />
        </linearGradient>
        <linearGradient id="pb-towerGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={bridgeDark} />
          <stop offset="0.5" stopColor={bridgeLight} />
          <stop offset="1" stopColor={bridgeDark} />
        </linearGradient>
        <linearGradient id="pb-phoneGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={bridgeLight} />
          <stop offset="1" stopColor={bridgeBlue} />
        </linearGradient>
      </defs>

      {/* Bridge deck */}
      <path
        d="M12 78 Q60 72 108 78"
        stroke="url(#pb-bridgeGrad)"
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
      />

      {/* Left tower */}
      <rect x="28" y="48" width="5" height="34" rx="2" fill="url(#pb-towerGrad)" />
      <rect x="26" y="46" width="9" height="4" rx="1.5" fill={bridgeBlue} />

      {/* Right tower */}
      <rect x="87" y="48" width="5" height="34" rx="2" fill="url(#pb-towerGrad)" />
      <rect x="85" y="46" width="9" height="4" rx="1.5" fill={bridgeBlue} />

      {/* Main cables */}
      <path d="M30 48 Q46 70 60 68" stroke={bridgeBlue} strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M60 68 Q74 70 90 48" stroke={bridgeBlue} strokeWidth="2" strokeLinecap="round" fill="none" />

      {/* Vertical hangers — left */}
      <line x1="36" y1="54" x2="36" y2="76" stroke={bridgeBlue} strokeWidth="1" opacity="0.5" />
      <line x1="42" y1="59" x2="42" y2="75" stroke={bridgeBlue} strokeWidth="1" opacity="0.5" />
      <line x1="48" y1="63" x2="48" y2="74" stroke={bridgeBlue} strokeWidth="1" opacity="0.5" />
      <line x1="54" y1="66" x2="54" y2="74" stroke={bridgeBlue} strokeWidth="1" opacity="0.5" />

      {/* Vertical hangers — right */}
      <line x1="66" y1="66" x2="66" y2="74" stroke={bridgeBlue} strokeWidth="1" opacity="0.5" />
      <line x1="72" y1="63" x2="72" y2="74" stroke={bridgeBlue} strokeWidth="1" opacity="0.5" />
      <line x1="78" y1="59" x2="78" y2="75" stroke={bridgeBlue} strokeWidth="1" opacity="0.5" />
      <line x1="84" y1="54" x2="84" y2="76" stroke={bridgeBlue} strokeWidth="1" opacity="0.5" />

      {/* Phone on bridge */}
      <rect x="51" y="38" width="18" height="30" rx="3" fill="url(#pb-phoneGrad)" />
      <rect x="53" y="42" width="14" height="22" rx="1.5" fill={phoneScreen} />
      <circle cx="60" cy="66" r="1.2" fill={phoneScreen} opacity="0.6" />

      {/* Wifi signal arcs */}
      <path d="M54 36 Q60 30 66 36" stroke={signalColor} strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.8" />
      <path d="M50 32 Q60 23 70 32" stroke={signalColor} strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.55" />
      <path d="M46 28 Q60 16 74 28" stroke={signalColor} strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.3" />

      {/* Bridge approach ramps */}
      <path d="M4 86 L12 78" stroke={bridgeBlue} strokeWidth="4" strokeLinecap="round" opacity="0.6" />
      <path d="M108 78 L116 86" stroke={bridgeBlue} strokeWidth="4" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

/** Small bridge icon for sidebar / nav */
export function PocketBridgeIcon({ size = 24, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="pb-sm-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5BAAE0" />
          <stop offset="1" stopColor="#2B6EA8" />
        </linearGradient>
      </defs>
      {/* Bridge deck */}
      <path d="M3 22 Q16 19 29 22" stroke="url(#pb-sm-grad)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      {/* Towers */}
      <rect x="8" y="12" width="2" height="11" rx="1" fill="#3B8DD0" />
      <rect x="22" y="12" width="2" height="11" rx="1" fill="#3B8DD0" />
      {/* Cables */}
      <path d="M9 13 Q13 20 16 19" stroke="#3B8DD0" strokeWidth="1" fill="none" opacity="0.7" />
      <path d="M16 19 Q19 20 23 13" stroke="#3B8DD0" strokeWidth="1" fill="none" opacity="0.7" />
      {/* Phone */}
      <rect x="13" y="6" width="6" height="10" rx="1.5" fill="#3B8DD0" />
      <rect x="14" y="7.5" width="4" height="7" rx="0.8" fill="#E8F4FF" />
      {/* Wifi */}
      <path d="M13.5 5 Q16 2 18.5 5" stroke="#2B6EA8" strokeWidth="1" strokeLinecap="round" fill="none" opacity="0.6" />
    </svg>
  );
}
