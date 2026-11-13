import type { Connection, Draft } from './model.js';

export interface PanelSnapshot {
  connections: Connection[];
  selected?: string;
  draft: Draft;
  view: 'settings' | 'activity';
  policyOpen: boolean;
  dirty: boolean;
  conflict: boolean;
  pendingMutation: boolean;
  checking: boolean;
  scrollTop: number;
}

/** One plugin activation, in memory only. Never serialize a draft or its password. */
export class PanelSession {
  private snapshot?: PanelSnapshot;
  private disposed = false;

  read() {
    return this.snapshot;
  }

  write(snapshot: PanelSnapshot) {
    if (!this.disposed) this.snapshot = snapshot;
  }

  scroll(top: number) {
    if (this.snapshot && !this.disposed) this.snapshot.scrollTop = top;
  }

  get needsExitWarning() {
    return !!(this.snapshot?.dirty || this.snapshot?.pendingMutation);
  }

  dispose() {
    this.disposed = true;
    this.snapshot = undefined;
  }
}

/** A resumed draft must never silently inherit a newer write revision. */
export function panelDraftConflict(snapshot: PanelSnapshot, latest: Connection[]): boolean {
  if (snapshot.conflict || snapshot.pendingMutation) return true;
  if (!snapshot.dirty || !snapshot.selected) return false;
  const before = snapshot.connections.find((item) => item.id === snapshot.selected);
  const after = latest.find((item) => item.id === snapshot.selected);
  return !before || !after || before.revision !== after.revision;
}
