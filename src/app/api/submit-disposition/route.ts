import { NextRequest, NextResponse } from 'next/server'
import { processFormSubmission, FormSubmissionData } from '@/lib/hubspot'

/**
 * POST /api/submit-disposition
 *
 * Submits form disposition data to HubSpot CRM
 */
export async function POST(request: NextRequest) {
  try {
    // Get HubSpot access token from environment
    const accessToken = process.env.HUBSPOT_ACCESS_TOKEN

    if (!accessToken) {
      console.error('HUBSPOT_ACCESS_TOKEN not configured')
      return NextResponse.json(
        { success: false, error: 'HubSpot integration not configured' },
        { status: 500 }
      )
    }

    // Parse request body
    const body = await request.json()

    // Validate required fields
    if (!body.disposition) {
      return NextResponse.json(
        { success: false, error: 'Disposition type is required' },
        { status: 400 }
      )
    }

    // Add timestamp if not provided
    const data: FormSubmissionData = {
      ...body,
      timestamp: body.timestamp || new Date().toISOString(),
    }

    // Process the submission
    const result = await processFormSubmission(data, accessToken)

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: 'Form submitted successfully',
        contactId: result.contactId,
        dealId: result.dealId,
        callId: result.callId,
      })
    } else {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Error in submit-disposition API:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/submit-disposition
 *
 * Health check endpoint
 */
export async function GET() {
  const hasToken = !!process.env.HUBSPOT_ACCESS_TOKEN

  return NextResponse.json({
    status: 'ok',
    hubspotConfigured: hasToken,
  })
}
