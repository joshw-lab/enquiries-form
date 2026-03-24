export function getDispositionLabel(disposition: string): string {
  const labels: Record<string, string> = {
    // snake_case (form submissions)
    book_water_test: 'Booked Test',
    call_back: 'Call Back',
    not_interested: 'Not Interested',
    other_department: 'Other Dept',
    unable_to_service: 'Unable to Service',
    no_answer: 'No Answer',
    wrong_number: 'Wrong Number',
    // Title Case (call_recordings from RingCX)
    'Booked Test': 'Booked Test',
    'Needs Call Back': 'Call Back',
    'Not interested': 'Not Interested',
    'Other Departments': 'Other Dept',
    'Not Qualified': 'Not Qualified',
    'No Answer': 'No Answer',
    'Left Voicemail': 'Voicemail',
    'Wrong Number': 'Wrong Number',
    'Hang Up': 'Hang Up',
    'Do Not Call': 'Do Not Call',
    'Busy': 'Busy',
  }
  return labels[disposition] || disposition.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function getDispositionColor(disposition: string): string {
  const colors: Record<string, string> = {
    // snake_case (form submissions)
    book_water_test: '#22c55e',
    call_back: '#f59e0b',
    not_interested: '#ef4444',
    other_department: '#8b5cf6',
    unable_to_service: '#6b7280',
    no_answer: '#3b82f6',
    wrong_number: '#f97316',
    // Title Case (call_recordings from RingCX)
    'Booked Test': '#22c55e',
    'Needs Call Back': '#f59e0b',
    'Not interested': '#ef4444',
    'Other Departments': '#8b5cf6',
    'Not Qualified': '#6b7280',
    'No Answer': '#3b82f6',
    'Left Voicemail': '#3b82f6',
    'Wrong Number': '#f97316',
    'Hang Up': '#ef4444',
    'Do Not Call': '#ef4444',
    'Busy': '#3b82f6',
  }
  return colors[disposition] || '#94a3b8'
}
