import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import OperationsDashboard from '@/components/reports/OperationsDashboard'

export default async function ReportsPage() {
  const session = await auth()
  if (!session) {
    redirect('/reports/login')
  }

  return <OperationsDashboard />
}
