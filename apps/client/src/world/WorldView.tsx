/**
 * The 3D world. Lazy-loaded so three.js / R3F live in their own chunks.
 */
import type { ParcelSummaryDto, RegionMapResponse } from '@bh/contracts';
import { Canvas } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { ACESFilmicToneMapping, SRGBColorSpace } from 'three';
import { polygonArea } from '../lib/geometry';
import { useQualityProfile } from '../store/settings';
import { CameraRig, LandingOrbit } from './CameraRig';
import { perfStats } from './cameraState';
import { buildWorldLayout, buildWorldScenery, disposeLayout, layoutKey } from './layout';
import {
  CropLayer,
  Lights,
  ParcelHighlight,
  ParcelLayer,
  PerfProbe,
  ShaderClock,
  StaticWorld,
  VegetationLayer,
  Vehicles,
  type ParcelVisualContext,
} from './layers';
import { createSceneMaterials } from './materials';
import { FOG, SKY } from './palette';

export interface WorldViewProps {
  map: RegionMapResponse;
  mode: 'game' | 'landing';
  myCompanyId?: string | null;
  aiCompanyIds?: ReadonlySet<string>;
  selectedParcelId?: string | null;
  hoveredParcelId?: string | null;
  onHover?: (id: string | null, clientX: number, clientY: number) => void;
  onSelect?: (id: string, focus: boolean) => void;
  showPerf?: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function Scene({
  map,
  mode,
  myCompanyId = null,
  aiCompanyIds = EMPTY_SET,
  selectedParcelId,
  hoveredParcelId,
  onHover,
  onSelect,
  showPerf,
}: WorldViewProps) {
  const profile = useQualityProfile();
  const key = layoutKey(map);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only when the static layout changes
  const layout = useMemo(() => buildWorldLayout(map), [key]);
  useEffect(() => () => disposeLayout(layout), [layout]);
  useEffect(() => {
    perfStats.layoutMs = layout.buildMs;
  }, [layout]);

  const animate = mode === 'landing' || profile.animate;
  const materials = useMemo(() => createSceneMaterials(animate), [animate]);
  useEffect(() => () => materials.dispose(), [materials]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- scenery depends on the static layout only
  const scenery = useMemo(
    () => buildWorldScenery(map, layout, profile.treeDensity),
    [layout, profile.treeDensity],
  );
  useEffect(() => () => scenery.architecture.dispose(), [scenery]);

  const ctx = useMemo<ParcelVisualContext>(
    () => ({ myCompanyId, aiCompanyIds }),
    [myCompanyId, aiCompanyIds],
  );

  const parcelById = useMemo(() => new Map(map.parcels.map((p) => [p.id, p])), [map.parcels]);
  const centroids = useMemo(
    () =>
      new Map(
        map.parcels.map((p) => [
          p.id,
          { x: p.centroid.x, y: p.centroid.y, sizeM: Math.sqrt(polygonArea(p.polygon)) },
        ]),
      ),
    [map.parcels],
  );

  const mine = useMemo<ParcelSummaryDto | null>(() => {
    if (!myCompanyId) return null;
    return (
      map.parcels.find(
        (p) => p.operatorCompanyId === myCompanyId || p.ownerCompanyId === myCompanyId,
      ) ?? null
    );
  }, [map.parcels, myCompanyId]);

  const initial = useMemo(() => {
    if (mine) return { x: mine.centroid.x, z: mine.centroid.y, distance: 620 };
    return { x: 0, z: 0, distance: layout.halfSize * 1.25 };
    // Only the first placement matters; later focus is driven by the UI.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  const tractorParcel =
    mine?.polygon ??
    (mode === 'landing' ? (map.parcels.find((p) => p.crop)?.polygon ?? null) : null);
  const selected = selectedParcelId ? parcelById.get(selectedParcelId) : undefined;
  const hovered =
    hoveredParcelId && hoveredParcelId !== selectedParcelId
      ? parcelById.get(hoveredParcelId)
      : undefined;

  return (
    <>
      <color attach="background" args={[SKY]} />
      <fog attach="fog" args={[FOG, 1500, 9000]} />
      <Lights shadows={profile.shadows} shadowMapSize={profile.shadowMapSize} />
      {animate ? <ShaderClock /> : null}
      <StaticWorld layout={layout} materials={materials} scenery={scenery} />
      <ParcelLayer
        layout={layout}
        parcels={map.parcels}
        materials={materials}
        ctx={ctx}
        interactive={mode === 'game'}
        onHover={onHover}
        onSelect={onSelect}
      />
      <CropLayer
        layout={layout}
        parcels={map.parcels}
        materials={materials}
        spacingScale={profile.cropSpacingScale}
        maxPerCrop={profile.maxCropInstances}
        castShadow={profile.shadowMapSize >= 2048}
      />
      <VegetationLayer scenery={scenery} materials={materials} />
      <Vehicles
        layout={layout}
        materials={materials}
        animate={animate}
        tractorParcel={tractorParcel}
      />
      {selected ? (
        <ParcelHighlight
          layout={layout}
          polygon={selected.polygon}
          id={selected.id}
          kind="selected"
        />
      ) : null}
      {hovered ? (
        <ParcelHighlight layout={layout} polygon={hovered.polygon} id={hovered.id} kind="hover" />
      ) : null}
      {mode === 'game' ? (
        <CameraRig
          sampler={layout.sampler}
          halfSize={layout.halfSize}
          initial={initial}
          centroids={centroids}
        />
      ) : (
        <LandingOrbit sampler={layout.sampler} halfSize={layout.halfSize} />
      )}
      {showPerf ? <PerfProbe /> : null}
    </>
  );
}

export default function WorldView(props: WorldViewProps) {
  const profile = useQualityProfile();
  const animate = props.mode === 'landing' || profile.animate;
  return (
    <Canvas
      // Antialiasing can only be chosen at context creation: remount on change.
      key={profile.antialias ? 'aa' : 'no-aa'}
      frameloop={animate ? 'always' : 'demand'}
      dpr={[1, profile.maxPixelRatio]}
      shadows={profile.shadows ? 'percentage' : false}
      gl={{
        antialias: profile.antialias,
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
      }}
      camera={{ fov: 30, near: 4, far: 12000, position: [1500, 1400, 1500] }}
      onCreated={({ gl }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.02;
        gl.outputColorSpace = SRGBColorSpace;
      }}
      style={{ position: 'absolute', inset: 0 }}
      aria-label="3D view of the Hemavati valley"
      data-testid="world-canvas"
    >
      <Scene {...props} />
    </Canvas>
  );
}
