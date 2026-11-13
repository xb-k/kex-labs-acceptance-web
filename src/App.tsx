import { Shell } from './components/Shell'
import { RouterProvider, useRouter, Link } from './router'
import { JobsPage } from './pages/JobsPage'
import { DetailPage } from './pages/DetailPage'
import { QcPage } from './pages/QcPage'
import { StatusPage } from './pages/StatusPage'
import { DashboardPage } from './pages/DashboardPage'
import { IssuesPage } from './pages/IssuesPage'
import { QcOverviewPage } from './pages/QcOverviewPage'
import { DeliveriesPage } from './pages/DeliveriesPage'
import { ReportsPage } from './pages/ReportsPage'
import { FlowPage } from './pages/FlowPage'
import { PipelinePage } from './pages/PipelinePage'
import { StudioPage } from './pages/StudioPage'
import { AgentsPage } from './pages/AgentsPage'
import { IssuesProvider } from './issues'

function Routes() {
  const { path: raw } = useRouter()
  const path = raw !== '/' && raw.endsWith('/') ? raw.replace(/\/+$/, '') : raw

  const qc = path.match(/^\/job\/([\w-]+)\/qc$/)
  if (qc) return <QcPage id={qc[1]} />
  const detail = path.match(/^\/job\/([\w-]+)$/)
  if (detail) return <DetailPage id={detail[1]} />

  if (path === '/' || path === '') return <DashboardPage />
  if (path === '/jobs') return <JobsPage />
  if (path === '/studio') return <StudioPage />
  if (path === '/issues') return <IssuesPage />
  if (path === '/status') return <StatusPage />
  if (path === '/flow') return <FlowPage />
  if (path === '/pipeline') return <PipelinePage />
  if (path === '/qc') return <QcOverviewPage />
  if (path === '/deliveries') return <DeliveriesPage />
  if (path === '/reports') return <ReportsPage />
  if (path === '/agents') return <AgentsPage />

  return (
    <div className="card p-8">
      <h1 className="text-lg font-semibold">页面不存在</h1>
      <p className="mt-2 text-sm text-apple-subtext">路径 {path} 没有对应的页面。</p>
      <Link to="/" className="mt-4 inline-block rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white">
        返回工作台总览
      </Link>
    </div>
  )
}

export function App() {
  return (
    <RouterProvider>
      <IssuesProvider>
        <Shell>
          <Routes />
        </Shell>
      </IssuesProvider>
    </RouterProvider>
  )
}
