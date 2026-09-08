import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { executeHistorical17Recovery } from '@/lib/pipeline/historical-recovery';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeCompare(provided: string, expected: string): boolean {
  const hashA = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse>> {
  try {
    ensureInitialized();

    // 1. Strict Security Check: ADMIN_RECOVERY_KEY must be configured
    const configuredAdminKey = process.env.ADMIN_RECOVERY_KEY?.trim();
    if (!configuredAdminKey) {
      console.error(
        JSON.stringify({
          event: 'ADMIN_HISTORICAL_RECOVERY',
          timestamp: new Date().toISOString(),
          operation: 'recover-historical-failures',
          outcome: 'FORBIDDEN',
          error: 'ADMIN_RECOVERY_KEY_NOT_CONFIGURED',
        })
      );
      return NextResponse.json(
        {
          success: false,
          error: 'ADMIN_RECOVERY_KEY_NOT_CONFIGURED',
          message: 'Administrative recovery is disabled. Required key is not configured in the environment.',
        },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // 2. Authorization Header Extraction & Validation
    const authHeader = request.headers.get('authorization') || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);

    if (!bearerMatch) {
      console.warn(
        JSON.stringify({
          event: 'ADMIN_HISTORICAL_RECOVERY',
          timestamp: new Date().toISOString(),
          operation: 'recover-historical-failures',
          outcome: 'UNAUTHORIZED',
          error: 'MISSING_OR_MALFORMED_AUTH_HEADER',
        })
      );
      return NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Missing or malformed Bearer authorization token.',
        },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const providedKey = bearerMatch[1];
    const isAuthorized = timingSafeCompare(providedKey, configuredAdminKey);

    if (!isAuthorized) {
      console.warn(
        JSON.stringify({
          event: 'ADMIN_HISTORICAL_RECOVERY',
          timestamp: new Date().toISOString(),
          operation: 'recover-historical-failures',
          outcome: 'UNAUTHORIZED',
          error: 'INVALID_BEARER_TOKEN',
        })
      );
      return NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Invalid administrative authorization token.',
        },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // 3. Execute Atomic Single-Transaction Recovery
    const result = executeHistorical17Recovery();

    // 4. Structured Audit Log (Zero secrets or PII logged)
    console.log(
      JSON.stringify({
        event: 'ADMIN_HISTORICAL_RECOVERY',
        timestamp: new Date().toISOString(),
        operation: result.operation,
        targetCount: result.targetCount,
        affectedCount: result.affectedCount,
        alreadyRecovered: result.alreadyRecovered || false,
        outcome: result.success
          ? result.alreadyRecovered
            ? 'ALREADY_RECOVERED'
            : 'SUCCESS'
          : 'ABORTED',
        error: result.error,
        failedPrecondition: result.failedPrecondition,
      })
    );

    // 5. Response Formatting
    if (result.success) {
      return NextResponse.json(
        {
          success: true,
          data: {
            operation: result.operation,
            targetCount: result.targetCount,
            affectedCount: result.affectedCount,
            alreadyRecovered: result.alreadyRecovered || false,
            message: result.message,
          },
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'PRECONDITION_FAILED',
          message: result.message,
          data: {
            operation: result.operation,
            targetCount: result.targetCount,
            affectedCount: 0,
            failedPrecondition: result.failedPrecondition,
          },
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  } catch (error) {
    console.error('Unhandled admin recovery error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'An unexpected internal error occurred during recovery.',
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
