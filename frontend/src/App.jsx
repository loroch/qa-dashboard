import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Sidebar } from './components/layout/Sidebar'
import LoginPage from './pages/LoginPage'
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
import AutomationPage from './pages/AutomationPage'
import AnomalyPage from './pages/AnomalyPage'
import BugsByVersionPage from './pages/BugsByVersionPage'
import TestPlansPage from './pages/TestPlansPage'
import ReleaseNotesPage from './pages/ReleaseNotesPage'
import InvestigationPage from './pages/InvestigationPage'
import BugReporterPage from './pages/BugReporterPage'
import BugTriagePage from './pages/BugTriagePage'
import MexicoQAPage from './pages/MexicoQAPage'
import KonePage from './pages/KonePage'
import SprintPlanningPage from './pages/SprintPlanningPage'

// Routes accessible by the QA role
const QA_ALLOWED_PATHS = new Set(['/kone', '/coverage', '/bugs-by-version'])
const QA_HOME = '/coverage'

function loadUser() {
  try { return JSON.parse(localStorage.getItem('qa_user')) } catch { return null }
}

export default function App() {
  const [user, setUser] = useState(loadUser)

  function handleLogin(data) {
    localStorage.setItem('qa_user', JSON.stringify(data))
    setUser(data)
  }

  function handleLogout() {
    localStorage.removeItem('qa_user')
    setUser(null)
  }

  if (!user) return <LoginPage onLogin={handleLogin} />

  const isAdmin = user.role === 'admin'

  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Sidebar user={user} onLogout={handleLogout} />
        <main className="flex-1 flex flex-col min-w-0">
          <Routes>
            {/* Admin-only routes */}
            <Route path="/"                  element={isAdmin ? <Dashboard />         : <Navigate to={QA_HOME} replace />} />
            <Route path="/ready-for-testing" element={isAdmin ? <ReadyForTesting />   : <Navigate to={QA_HOME} replace />} />
            <Route path="/team"              element={isAdmin ? <TeamOverview />      : <Navigate to={QA_HOME} replace />} />
            <Route path="/aging"             element={isAdmin ? <AgingReport />       : <Navigate to={QA_HOME} replace />} />
            <Route path="/blockers"          element={isAdmin ? <BlockersPage />      : <Navigate to={QA_HOME} replace />} />
            <Route path="/bugs"              element={isAdmin ? <BugsReport />        : <Navigate to={QA_HOME} replace />} />
            <Route path="/trends"            element={isAdmin ? <TrendsPage />        : <Navigate to={QA_HOME} replace />} />
            <Route path="/zoho"              element={isAdmin ? <ZohoDeskPage />      : <Navigate to={QA_HOME} replace />} />
            <Route path="/zoho-reports"      element={isAdmin ? <ZohoReportsPage />  : <Navigate to={QA_HOME} replace />} />
            <Route path="/changelog"         element={isAdmin ? <Changelog />         : <Navigate to={QA_HOME} replace />} />
            <Route path="/automation"        element={isAdmin ? <AutomationPage />    : <Navigate to={QA_HOME} replace />} />
            <Route path="/anomaly"           element={isAdmin ? <AnomalyPage />       : <Navigate to={QA_HOME} replace />} />
            <Route path="/test-plans"        element={isAdmin ? <TestPlansPage />     : <Navigate to={QA_HOME} replace />} />
            <Route path="/release-notes"     element={isAdmin ? <ReleaseNotesPage />  : <Navigate to={QA_HOME} replace />} />
            <Route path="/investigation"     element={isAdmin ? <InvestigationPage /> : <Navigate to={QA_HOME} replace />} />
            <Route path="/bug-reporter"      element={isAdmin ? <BugReporterPage />   : <Navigate to={QA_HOME} replace />} />
            <Route path="/bug-triage"        element={isAdmin ? <BugTriagePage />     : <Navigate to={QA_HOME} replace />} />
            <Route path="/mexico-qa"         element={isAdmin ? <MexicoQAPage />      : <Navigate to={QA_HOME} replace />} />
            <Route path="/sprint-planning"   element={isAdmin ? <SprintPlanningPage />: <Navigate to={QA_HOME} replace />} />

            {/* Routes available to both roles */}
            <Route path="/coverage"          element={<TestCoveragePage />} />
            <Route path="/bugs-by-version"   element={<BugsByVersionPage />} />
            <Route path="/kone"              element={<KonePage />} />

            <Route path="*"                  element={<Navigate to={isAdmin ? '/' : QA_HOME} replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
