import { NextRequest, NextResponse } from 'next/server';
import { sendTestEmail } from '@/lib/gmail/send-email';
import { getGmailConnectionStatus } from '@/lib/gmail/gmail-client';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<{ messageId: string; recipient: string }>>> {
  try {
    ensureInitialized();

    // 1. Verify Gmail is connected
    const status = await getGmailConnectionStatus();
    if (!status.connected) {
      return NextResponse.json(
        {
          success: false,
          error: 'Gmail is not connected. Please connect your Gmail account before running a test send.',
        },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const recipient = body.recipient || status.email;

    if (!recipient || recipient === 'Authorized Account' || !recipient.includes('@')) {
      return NextResponse.json(
        {
          success: false,
          error: 'Please specify a valid test recipient email address.',
        },
        { status: 400 }
      );
    }

    console.log(`[API /test-send] Initiating controlled test send to: ${recipient}`);
    const result = await sendTestEmail(recipient);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Failed to send test email.',
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        messageId: result.messageId || 'unknown_id',
        recipient,
      },
    });
  } catch (error) {
    console.error('[API /test-send Error]:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Test send encountered an unexpected failure.',
      },
      { status: 500 }
    );
  }
}
