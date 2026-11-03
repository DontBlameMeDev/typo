export class BackGate {
  private pending: { exit: boolean; tapped: boolean } | null = null

  begin(exit: boolean): boolean {
    if (this.pending) {
      this.pending.exit &&= exit
      return false
    }
    this.pending = { exit, tapped: false }
    return true
  }

  blockOpening(): boolean {
    if (!this.pending) return false
    this.pending.tapped = true
    return true
  }

  finish(): boolean {
    const pending = this.pending
    this.pending = null
    return !!pending?.exit && !pending.tapped
  }

  cancel(): void {
    this.pending = null
  }
}
