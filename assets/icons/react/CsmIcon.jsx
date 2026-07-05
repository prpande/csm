import React, { useId } from "react";

/**
 * CSM app icon — React components.
 *
 *  <CsmMark />  bare mark (transparent) — in-app UI, light surfaces, about screens
 *  <CsmTile />  cream-tile app icon (#f2ebe1, subtle depth) — window chrome, dock/taskbar previews
 *  <CsmMono />  monochrome template — menu-bar / tray / inline; inherits `color` via currentColor
 *
 * All accept `size` (px, default varies) and forward any extra SVG props
 * (className, style, onClick, aria-*, …). Gradient/mask ids are namespaced
 * with useId(), so any number of instances can render on one page safely.
 */

export function CsmMark({ size = 32, title = "CSM", ...props }) {
  const uid = useId();
  const o = `${uid}o`, c = `${uid}c`, s = `${uid}s`, cut = `${uid}cut`;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width={size} height={size} role="img" aria-label={title} {...props}>
      <defs>
        <linearGradient id={o} x1="0.12" y1="0" x2="0.88" y2="1">
          <stop offset="0" stopColor="#e8845a" />
          <stop offset="0.55" stopColor="#e27a48" />
          <stop offset="1" stopColor="#d9622b" />
        </linearGradient>
        <linearGradient id={c} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#342c26" />
          <stop offset="1" stopColor="#2a2420" />
        </linearGradient>
        <filter id={s} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="10" stdDeviation="13" floodColor="#2a2420" floodOpacity="0.22" />
        </filter>
        <mask id={cut}>
          <rect width="512" height="512" fill="#fff" />
          <rect x="259" y="97" width="158" height="158" rx="47" fill="#000" transform="rotate(-9 338 176)" />
        </mask>
      </defs>
      <path d="M250,140 H206 Q140,140 140,206 V306 Q140,372 206,372 H306 Q372,372 372,306 V262" fill="none" stroke={`url(#${c})`} strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" mask={`url(#${cut})`} />
      <rect x="268" y="106" width="140" height="140" rx="40" fill={`url(#${o})`} filter={`url(#${s})`} transform="rotate(-9 338 176)" />
    </svg>
  );
}

export function CsmTile({ size = 40, title = "CSM", ...props }) {
  const uid = useId();
  const o = `${uid}o`, c = `${uid}c`, p = `${uid}p`, sf = `${uid}sf`, lift = `${uid}lift`;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width={size} height={size} role="img" aria-label={title} {...props}>
      <defs>
        <linearGradient id={o} x1="0.12" y1="0" x2="0.88" y2="1">
          <stop offset="0" stopColor="#e8845a" />
          <stop offset="0.55" stopColor="#e27a48" />
          <stop offset="1" stopColor="#d9622b" />
        </linearGradient>
        <linearGradient id={c} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#342c26" />
          <stop offset="1" stopColor="#2a2420" />
        </linearGradient>
        <linearGradient id={p} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f7f1e8" />
          <stop offset="1" stopColor="#ebe2d4" />
        </linearGradient>
        <filter id={sf} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="10" stdDeviation="13" floodColor="#2a2420" floodOpacity="0.26" />
        </filter>
        <filter id={lift} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="10" stdDeviation="16" floodColor="#000" floodOpacity="0.42" />
        </filter>
      </defs>
      <rect x="40" y="40" width="432" height="432" rx="112" fill={`url(#${p})`} filter={`url(#${lift})`} />
      <rect x="40.5" y="40.5" width="431" height="431" rx="111.5" fill="none" stroke="#2a2420" strokeOpacity="0.07" strokeWidth="1" />
      <g transform="translate(-6,3)">
        <path d="M250,140 H206 Q140,140 140,206 V306 Q140,372 206,372 H306 Q372,372 372,306 V262" fill="none" stroke={`url(#${c})`} strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="259" y="97" width="158" height="158" rx="47" fill="#f2ebe1" transform="rotate(-9 338 176)" />
        <rect x="268" y="106" width="140" height="140" rx="40" fill={`url(#${o})`} filter={`url(#${sf})`} transform="rotate(-9 338 176)" />
      </g>
    </svg>
  );
}

export function CsmMono({ size = 20, title = "CSM", ...props }) {
  const uid = useId();
  const cut = `${uid}cut`;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width={size} height={size} role="img" aria-label={title} fill="currentColor" {...props}>
      <defs>
        <mask id={cut}>
          <rect width="512" height="512" fill="#fff" />
          <rect x="259" y="97" width="158" height="158" rx="47" fill="#000" transform="rotate(-9 338 176)" />
        </mask>
      </defs>
      <path d="M250,140 H206 Q140,140 140,206 V306 Q140,372 206,372 H306 Q372,372 372,306 V262" fill="none" stroke="currentColor" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" mask={`url(#${cut})`} />
      <rect x="268" y="106" width="140" height="140" rx="40" fill="currentColor" transform="rotate(-9 338 176)" />
    </svg>
  );
}

export default CsmMark;
