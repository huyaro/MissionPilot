// In-process event bus for the P3 board.
// The dispatcher/scheduler publish backend events here; the board API
// (REST + SSE) consumes them. No persistence — the SQLite store is the
// source of truth; the bus is only a live push channel.
import { EventEmitter } from 'node:events';

export type BoardEventType =
  | 'attempt_started'
  | 'attempt_finished'
  | 'attempt_verified'
  | 'attempt_merged'
  | 'mission_done'
  | 'mission_failed'
  | 'approval_created'
  | 'approval_decided';

export interface BoardEvent {
  type: BoardEventType;
  ts: string;
  missionId?: string;
  taskId?: string;
  attemptId?: string;
  approvalId?: string;
  summary: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(64);

export function publishBoardEvent(
  event: Omit<BoardEvent, 'ts'> & { ts?: string },
): void {
  emitter.emit('board-event', {
    ...event,
    ts: event.ts ?? new Date().toISOString(),
  } satisfies BoardEvent);
}

export function subscribeBoardEvents(
  listener: (event: BoardEvent) => void,
): () => void {
  emitter.on('board-event', listener);
  return () => {
    emitter.off('board-event', listener);
  };
}
