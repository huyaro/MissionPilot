// User-facing Chinese labels for backend status/kind enums.
// Unknown values fall back to the raw string so new statuses stay visible.
export const STATUS_LABELS: Record<string, string> = {
  planned: '已规划',
  executing: '执行中',
  running: '运行中',
  done: '已完成',
  passed: '已通过',
  failed: '失败',
  pending: '待处理',
  approved: '已批准',
  rejected: '已拒绝',
  connected: '已连接',
  available: '可用',
  disabled: '未启用',
  missing: '未安装',
  'not-connected': '未连接',
  stopped: '已停止',
  starting: '启动中',
  reconnecting: '重连中',
  cancelled: '已取消',
  skipped: '已跳过',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const KIND_LABELS: Record<string, string> = {
  replan: '重新规划',
  push: '推送',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}
