export interface Failure {
  code: string;
  reason: string;
  retryable: boolean;
}

export function failureProbability(amount: bigint, scale: number): number {
  return Math.min(0.5, (Number(amount) / scale) * 0.5);
}

export function simulateFailure(
  reference: string,
  amount: bigint,
  attempt: number,
  options: { enabled: boolean; scale: number },
  random = Math.random,
): Failure | null {
  // Reference fixtures remain deterministic even when random simulation is disabled.
  if (reference.toUpperCase().includes('FAIL')) {
    return { code: 'SIMULATED_TECHNICAL', reason: 'Forced reference failure', retryable: true };
  }
  if (reference.toUpperCase().startsWith('RETRY-ONCE') && attempt === 1) {
    return { code: 'SIMULATED_TECHNICAL', reason: 'First-attempt failure', retryable: true };
  }
  if (options.enabled && random() < failureProbability(amount, options.scale)) {
    return {
      code: 'SIMULATED_TECHNICAL',
      reason: 'Amount-based simulated failure',
      retryable: true,
    };
  }
  return null;
}

export function retryDelay(attempt: number, base: number): number {
  return Math.min(60000, base * 2 ** Math.min(attempt - 1, 16));
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return (
    ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(code ?? '') ||
    (error as { name?: string })?.name === 'PrismaClientInitializationError'
  );
}
