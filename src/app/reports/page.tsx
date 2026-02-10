import { redirect } from 'next/navigation'
import { isAuthenticated } from '@/lib/reports-auth'
import ReportsDashboard from '@/components/reports/ReportsDashboard'

export default async function ReportsPage() {
  const authed = await isAuthenticated()
  if (!authed) {
    redirect('/reports/login')
  }

  return <ReportsDashboard />
}
