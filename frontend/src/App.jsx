import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Sidebar } from './components/layout/Sidebar'
import Dashboard from './pages/Dashboard'
import ReadyForTesting from './pages/ReadyForTesting'
import TeamOverview from './pages/TeamOverview'
import AgingReport from './pages/AgingReport'
import BlockersPage from './pages/BlockersPage'
import BugsReport from './pages/BugsReport'
import TrendsPage from './pages/TrendsPage'
import Changelog from './pages/Changelog'
import ZohoDeskPage from './pages/ZohoDeskPage'
import ZohoReportsPage from './pages/ZohoReportsPage'
import TestCoveragePage from './pages/TestCoveragePage'
import TestGeneratorPage from './pages/TestGeneratorPage'
import AnomalyPage from './pages/AnomalyPage'
import BugsByVersionPage from './pages/BugsByVersionPage'
import TestPlansPage from './pages/TestPlansPage'
import ReleaseNotesPage from './pages/ReleaseNotesPage'

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 flex flex-col min-w-0">
          <Routes>
            <Route path="/"                  element={<Dashboard />} />
            <Route path="/ready-for-testing" element={<ReadyForTesting />} />
            <Route path="/team"              element={<TeamOverview />} />
            <Route path="/aging"             element={<AgingReport />} />
            <Route path="/blockers"          element={<BlockersPage />} />
            <Route path="/bugs"              element={<BugsReport />} />
            <Route path="/trends"            element={<TrendsPage />} />
            <Route path="/coverage"          element={<TestCoveragePage />} />
            <Route path="/zoho"              element={<ZohoDeskPage />} />
            <Route path="/zoho-reports"     element={<ZohoReportsPage />} />
            <Route path="/changelog"         element={<Changelog />} />
            <Route path="/test-generator"    element={<TestGeneratorPage />} />
            <Route path="/anomaly"           element={<AnomalyPage />} />
            <Route path="/bugs-by-version"   element={<BugsByVersionPage />} />
            <Route path="/test-plans"        element={<TestPlansPage />} />
            <Route path="/release-notes"     element={<ReleaseNotesPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
