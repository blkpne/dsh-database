/** One result owner per form. Invalidated work can never publish a late result. */
export class ConnectionProbe {
  private active?: AbortController;

  start(): AbortController | undefined {
    if (this.active) return;
    return (this.active = new AbortController());
  }

  owns(probe: AbortController): boolean {
    return this.active === probe && !probe.signal.aborted;
  }

  cancel(): boolean {
    const previous = this.active;
    this.active = undefined;
    previous?.abort();
    return !!previous;
  }

  finish(probe: AbortController): boolean {
    if (!this.owns(probe)) return false;
    this.active = undefined;
    return true;
  }
}
