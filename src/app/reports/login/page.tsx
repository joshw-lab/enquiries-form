import { signIn } from '@/lib/auth'

export default async function ReportsLogin({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
          <h1 className="text-xl font-semibold text-gray-900 mb-1">Call Reports</h1>
          <p className="text-sm text-gray-500 mb-6">Sign in with your Google account</p>

          {error === 'AccessDenied' && (
            <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              You are not authorized to access reports.
            </p>
          )}

          {error && error !== 'AccessDenied' && (
            <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              Something went wrong. Please try again.
            </p>
          )}

          <form
            action={async () => {
              'use server'
              await signIn('google', { redirectTo: '/reports' })
            }}
          >
            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors cursor-pointer"
            >
              Sign in with Google
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
