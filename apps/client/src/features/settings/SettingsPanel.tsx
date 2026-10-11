import type { MeResponse } from '@bh/contracts';
import { api, signOutLocally } from '../../api/client';
import { QUALITY_PROFILES, useSettingsStore, type GraphicsQuality } from '../../store/settings';
import { useUiStore } from '../../store/ui';
import { SectionTitle, Segmented } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { Panel } from '../../ui/Panel';

const DESCRIPTIONS: Record<GraphicsQuality, string> = {
  low: 'No shadows, 1× pixel ratio, sparse crop rows, static water and vehicles (renders on demand). For integrated GPUs.',
  medium:
    'Soft shadows (1024), up to 1.5× pixel ratio, antialiasing, animated water, wind and traffic.',
  high: 'Sharper shadows (2048) incl. crop shadows, up to 2× pixel ratio, full crop and tree density.',
};

export function SettingsPanel({ me }: { me: MeResponse }) {
  const close = useUiStore((s) => s.closePanel);
  const quality = useSettingsStore((s) => s.quality);
  const setQuality = useSettingsStore((s) => s.setQuality);
  const showPerf = useSettingsStore((s) => s.showPerf);
  const setShowPerf = useSettingsStore((s) => s.setShowPerf);
  const p = QUALITY_PROFILES[quality];
  return (
    <Panel title="Settings" onClose={close} testId="settings-panel">
      <div className="bh-stack">
        <SectionTitle>Graphics quality</SectionTitle>
        <Segmented
          label="Graphics quality"
          value={quality}
          onChange={setQuality}
          options={[
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
          ]}
        />
        <div className="muted" style={{ fontSize: 12.5 }}>
          {DESCRIPTIONS[quality]}
        </div>
        <dl className="bh-kv">
          <dt>Shadows</dt>
          <dd>{p.shadows ? `${p.shadowMapSize}px` : 'Off'}</dd>
          <dt>Max pixel ratio</dt>
          <dd>{p.maxPixelRatio}×</dd>
          <dt>Antialiasing</dt>
          <dd>{p.antialias ? 'On' : 'Off'}</dd>
          <dt>Crop instances (per crop)</dt>
          <dd>≤ {p.maxCropInstances.toLocaleString('en-IN')}</dd>
          <dt>Tree density</dt>
          <dd>{Math.round(p.treeDensity * 100)}%</dd>
        </dl>
        <label className="bh-toggle">
          <input
            type="checkbox"
            checked={showPerf}
            onChange={(e) => setShowPerf(e.target.checked)}
            data-testid="settings-show-perf"
          />
          <span className="grow">
            Show performance overlay
            <span className="faint" style={{ display: 'block', fontSize: 12 }}>
              FPS, draw calls and triangle count
            </span>
          </span>
        </label>
        <SectionTitle>Account</SectionTitle>
        <dl className="bh-kv">
          <dt>Signed in as</dt>
          <dd>
            {me.account.displayName} (@{me.account.username})
          </dd>
          <dt>Region</dt>
          <dd>{me.regionId}</dd>
        </dl>
        <Button
          variant="danger"
          icon="logout"
          onClick={() => {
            void api.logout().catch(() => undefined);
            signOutLocally();
          }}
          data-testid="settings-logout"
        >
          Sign out
        </Button>
      </div>
    </Panel>
  );
}
