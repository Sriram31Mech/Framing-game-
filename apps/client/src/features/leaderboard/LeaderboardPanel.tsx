import { useLeaderboard } from '../../api/queries';
import { formatHa } from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Chip, Money } from '../../ui/Bits';
import { Panel } from '../../ui/Panel';
import { EmptyState, QueryView } from '../../ui/States';

export function LeaderboardPanel({ myCompanyId }: { myCompanyId: string | null }) {
  const close = useUiStore((s) => s.closePanel);
  const board = useLeaderboard();
  return (
    <Panel
      title="Leaderboard"
      subtitle="Companies in the valley by valuation"
      onClose={close}
      testId="leaderboard-panel"
    >
      <QueryView query={board}>
        {(data) =>
          data.entries.length === 0 ? (
            <EmptyState icon="leaderboard" title="No companies yet" />
          ) : (
            <table className="bh-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Company</th>
                  <th className="num">Land</th>
                  <th className="num">Valuation</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr
                    key={e.companyId}
                    className={e.companyId === myCompanyId ? 'selected' : undefined}
                  >
                    <td className="num">{e.rank}</td>
                    <td>
                      {e.name} {e.kind === 'ai' ? <Chip tone="info">AI</Chip> : null}
                      {e.companyId === myCompanyId ? <Chip tone="accent">You</Chip> : null}
                    </td>
                    <td className="num">{formatHa(e.landHa)}</td>
                    <td className="num">
                      <Money paise={e.valuationPaise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QueryView>
    </Panel>
  );
}
