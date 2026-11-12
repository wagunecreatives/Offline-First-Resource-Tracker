// Client-side LWW tie-breaker utility. 
// Note: The server is authoritative, but this documents the exact logic used.
export function determineLocalWinner(localTs, serverTs, localOpId, serverOpId, toleranceMs = 5000) {
    if (localTs > serverTs + toleranceMs) return true;
    if (localTs < serverTs - toleranceMs) return false;
    
    // Tie-breaker: Lexicographically smaller operationId wins
    const safeServerOpId = serverOpId || "";
    return localOpId < safeServerOpId;
}