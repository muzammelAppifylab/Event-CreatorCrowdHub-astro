import {useMemo} from 'react';
import {renderSVG} from 'uqr';

/** A QR code for `value`, drawn by uqr and shown as an <img> data URI (so the SVG can never run script). */
export function QrCode({value, label, size = 160}: {value: string; label: string; size?: number}) {
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(value, {border: 1}))}`, [value]);
  return <img src={src} alt={label} width={size} height={size} style={{background: '#fff', borderRadius: 8}} />;
}
