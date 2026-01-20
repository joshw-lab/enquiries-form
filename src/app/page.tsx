import { Suspense } from 'react'
import DispositionForm from '@/components/DispositionForm'

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center">Loading...</div>}>
      <DispositionForm />
    </Suspense>
  )
}
