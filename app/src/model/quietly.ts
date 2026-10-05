// Best-effort steps: run something and ignore its failure (clean-up, or a step whose failure
// must not stop the ones after it).

/** Runs `step` and awaits it; a throw or a rejection is ignored. */
export async function quietly(step: () => unknown): Promise<void> {
  try {
    await step();
  } catch {
    // Ignored: best effort.
  }
}

/** Runs synchronous `step`; a throw is ignored (a node not connected, or a closed context). */
export function quietlySync(step: () => void): void {
  try {
    step();
  } catch {
    // Ignored: best effort.
  }
}
