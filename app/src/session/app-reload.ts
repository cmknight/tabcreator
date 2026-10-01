// Every app-initiated reload goes through here (spine AD-16). Later stories add the
// recording/analysing guard and await flushAll() first.

export function reloadApp(): void {
  location.reload();
}
