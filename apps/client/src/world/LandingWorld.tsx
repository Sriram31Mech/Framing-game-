/** Landing backdrop: the real region (generated client-side) slowly orbiting. */
import { useMemo } from 'react';
import { previewRegionMap } from './regionPreview';
import WorldView from './WorldView';

export default function LandingWorld() {
  const map = useMemo(() => previewRegionMap(), []);
  if (!map) return null;
  return <WorldView map={map} mode="landing" />;
}
