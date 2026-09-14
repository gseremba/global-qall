const claimedIncomingCallRoutes = new Map<string, number>();

const CLAIM_TTL_MS = 12_000;

function pruneClaims(now: number) {
  for (const [callId, claimedAt] of claimedIncomingCallRoutes.entries()) {
    if (now - claimedAt > CLAIM_TTL_MS) {
      claimedIncomingCallRoutes.delete(callId);
    }
  }
}

export function claimIncomingCallRoute(callId: string): boolean {
  const normalized = callId.trim();
  if (!normalized) return false;

  const now = Date.now();
  pruneClaims(now);

  if (claimedIncomingCallRoutes.has(normalized)) {
    console.log("[CALL ROUTE GUARD] Duplicate route ignored", {
      callId: normalized,
      timestamp: new Date(now).toISOString(),
    });
    return false;
  }

  claimedIncomingCallRoutes.set(normalized, now);

  console.log("[CALL ROUTE GUARD] Route claimed", {
    callId: normalized,
    timestamp: new Date(now).toISOString(),
  });

  return true;
}

export function releaseIncomingCallRoute(callId: string): void {
  claimedIncomingCallRoutes.delete(callId.trim());
}
