import type { BoardApi } from '../api';
import { ScoreboardCard } from './Scoreboard';
import { LedgerCard } from './Ledger';

// Merged page: 记分板 on top, 账本 below. Both cards keep their own data
// fetching and copy; this page only composes them under one nav entry.
export function ScoreboardLedger(props: { api: BoardApi }) {
  const { api } = props;
  return (
    <div>
      <h1>记账本</h1>
      <p className="sub">上面是执行者记分板，下面是预算与哈希链审计记录。</p>
      <ScoreboardCard api={api} />
      <LedgerCard api={api} />
    </div>
  );
}
