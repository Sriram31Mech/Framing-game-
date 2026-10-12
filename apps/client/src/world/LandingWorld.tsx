/** Landing backdrop: the real map of Tamil Nadu, slowly turning. Needs no server data. */
import { tamilNaduDistricts, tamilNaduSegments } from '@bh/domain';
import { useMemo } from 'react';
import TamilNaduMap from './tn/TamilNaduMap';

export default function LandingWorld() {
  const data = useMemo(() => {
    const districts = tamilNaduDistricts().map((d) => ({ ...d, annualRainMm: 0 }));
    return { districts, segments: tamilNaduSegments() };
  }, []);
  return (
    <TamilNaduMap
      mode="landing"
      districts={data.districts}
      segments={data.segments}
      showLabels={false}
    />
  );
}
