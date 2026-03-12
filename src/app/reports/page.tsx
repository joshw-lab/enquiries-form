import { redirect } from 'next/navigation'
import { isAuthenticated } from '@/lib/reports-auth'
import OperationsDashboard from '@/components/reports/OperationsDashboard'

export default async function ReportsPage() {
  const authed = await isAuthenticated()
  if (!authed) {
    redirect('/reports/login')
  }

  return <OperationsDashboard />
}
