import { useEffect } from 'react'
import { Shell } from './components/Shell'
import { RouterProvider, useRouter, Link } from './router'
import { JobsPage } from './pages/JobsPage'
import { DetailPage } from './pages/DetailPage'
import { QcPage } from './pages/QcPage'
import { QcOverviewPage } from './pages/QcOverviewPage'
import { DeliveriesPage } from './pages/DeliveriesPage'
import { StudioPage } from './pages/StudioPage'
import { ProductionTrackerPage } from './pages/ProductionTrackerPage'
import { AgentsPage } from './pages/AgentsPage'

function RedirectHome() {
  const { navigate } = useRouter()
  useEffect(() => {
    navigate('/')
  }, [navigate])
  return <ProductionTrackerPage />
}

function Routes() {
  const { path: raw } = useRouter()
  const path = raw !== '/' && raw.endsWith('/') ? raw.replace(/\/+$/, '') : raw

  const qc = path.match(/^\/job\/([\w-]+)\/qc$/)
  if (qc) return <QcPage id={qc[1]} />
  const detail = path.match(/^\/job\/([\w-]+)$/)
  if (detail) return <DetailPage id={detail[1]} />

  if (path === '/' || path === '' || path === '/overview') return <ProductionTrackerPage />
  if (path === '/studio') return <StudioPage />
  if (path === '/jobs') return <JobsPage />
  if (path === '/qc') return <QcOverviewPage />
  if (path === '/deliveries') return <DeliveriesPage />
  if (path === '/agents') return <AgentsPage />

  if (path === '/status' || path === '/reports' || path === '/issues' || path === '/flow' || path === '/pipeline') {
    return <RedirectHome />
  }

  return (
    <div className="card p-8">
      <h1 className="text-lg font-semibold">页面不存在</h1>
      <p className="mt-2 text-sm text-apple-subtext">路径 {path} 没有对应的页面。</p>
      <Link to="/" className="mt-4 inline-block rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white">
        返回视频生产总台
      </Link>
    </div>
  )
}

export function App() {
  return (
    <RouterProvider>
      <Shell>
        <Routes />
      </Shell>
    </RouterProvider>
  )
}
