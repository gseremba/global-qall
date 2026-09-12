type NativeCallHandoff = {
  fromCallId: string;
  toCallId: string;
  cleanupComplete: boolean;
  startedAt: number;
};

let currentHandoff: NativeCallHandoff | null = null;
const cleanupWaiters = new Set<() => void>();

export function beginNativeCallHandoff(
  fromCallId: string,
  toCallId: string,
): void {
  if (
    currentHandoff?.fromCallId === fromCallId &&
    currentHandoff?.toCallId === toCallId
  ) {
    return;
  }

  currentHandoff = {
    fromCallId,
    toCallId,
    cleanupComplete: false,
    startedAt: Date.now(),
  };

  console.log("[NATIVE CALL HANDOFF]", {
    event: "handoff_started",
    fromCallId,
    toCallId,
    timestamp: new Date().toISOString(),
  });
}

export function isNativeCallHandoffFrom(
  callId: string,
): boolean {
  return currentHandoff?.fromCallId === callId;
}

export function isNativeCallHandoffTo(
  callId: string,
): boolean {
  return currentHandoff?.toCallId === callId;
}

export function markNativeCallHandoffCleanupComplete(
  callId: string,
): void {
  if (currentHandoff?.fromCallId !== callId) {
    return;
  }

  currentHandoff.cleanupComplete = true;

  console.log("[NATIVE CALL HANDOFF]", {
    event: "old_call_cleanup_complete",
    fromCallId: currentHandoff.fromCallId,
    toCallId: currentHandoff.toCallId,
    timestamp: new Date().toISOString(),
  });

  for (const resolve of cleanupWaiters) {
    resolve();
  }
  cleanupWaiters.clear();
}

export async function waitForNativeCallHandoffCleanup(
  fromCallId: string,
  timeoutMs = 1800,
): Promise<void> {
  if (
    currentHandoff?.fromCallId !== fromCallId ||
    currentHandoff.cleanupComplete
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanupWaiters.delete(finish);
      resolve();
    };

    cleanupWaiters.add(finish);
    setTimeout(finish, timeoutMs);
  });
}

export function clearNativeCallHandoff(
  toCallId?: string,
): void {
  if (
    toCallId &&
    currentHandoff &&
    currentHandoff.toCallId !== toCallId
  ) {
    return;
  }

  if (currentHandoff) {
    console.log("[NATIVE CALL HANDOFF]", {
      event: "handoff_cleared",
      fromCallId: currentHandoff.fromCallId,
      toCallId: currentHandoff.toCallId,
      timestamp: new Date().toISOString(),
    });
  }

  currentHandoff = null;

  for (const resolve of cleanupWaiters) {
    resolve();
  }
  cleanupWaiters.clear();
}
