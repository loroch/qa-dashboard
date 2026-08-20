import axios from 'axios'

export const BASE_URL = import.meta.env.VITE_API_URL ||
  (typeof window !== 'undefined'
    ? `http://${window.location.hostname}:8000/api`
    : '/api')

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
})

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const msg = err.response?.data?.detail || err.message || 'Unknown error'
    return Promise.reject(new Error(msg))
  }
)

// --- Dashboard ---
export const getDashboard = (params = {}) =>
  api.get('/dashboard/summary', { params })

export const getReadyForTesting = (params = {}) =>
  api.get('/dashboard/ready-for-testing', { params })

export const getBugs = (params = {}) =>
  api.get('/dashboard/bugs', { params })

export const getBlockers = (params = {}) =>
  api.get('/dashboard/blockers', { params })

export const getBugsByVersion = (version, params = {}) =>
  api.get('/dashboard/bugs-by-version', { params: { version, ...params } })

export const triggerRefresh = () =>
  api.post('/dashboard/refresh')

export const getCacheStatus = () =>
  api.get('/dashboard/cache/status')

export const getIssueTransitions = (key) =>
  api.get(`/dashboard/issue/${key}/transitions`)

export const transitionIssue = (key, transitionId) =>
  api.post(`/dashboard/issue/${key}/transition`, { transition_id: transitionId })

export const getTeamMembers = () =>
  api.get('/jira/team-members')

export const reassignQaOwner = (key, accountId) =>
  api.post(`/dashboard/issue/${key}/qa-owner`, { account_id: accountId })

export const setQaEstimate = (key, hours) =>
  api.post(`/dashboard/issue/${key}/qa-estimate`, { hours })

export const getDefaultBugQaHours = () =>
  api.get('/dashboard/settings/default-bug-qa-hours')

export const setDefaultBugQaHours = (hours) =>
  api.post('/dashboard/settings/default-bug-qa-hours', { hours })

// --- Jira meta ---
export const getJiraStatus = () =>
  api.get('/jira/status')

export const getJiraFields = () =>
  api.get('/jira/fields')

export const getJiraProjects = () =>
  api.get('/jira/projects')

export const reloadConfig = () =>
  api.post('/jira/config/reload')

// --- Changelog ---
export const getChangelog = (params = {}) =>
  api.get('/changelog', { params })

export const createChangelogEntry = (data) =>
  api.post('/changelog', data)

// --- Test Case Generator ---
export const getFixVersions = () =>
  api.get('/test-generator/versions')

export const getStoriesWithoutTests = (version) =>
  api.get(`/test-generator/stories?version=${encodeURIComponent(version)}`)

export const generateTestCases = (storyKey) =>
  api.post('/test-generator/generate', { story_key: storyKey })

export const createTestCases = (data) =>
  api.post('/test-generator/create', data)

// --- Export ---
export const exportUrl = (path, params = {}) => {
  const qs = new URLSearchParams(params).toString()
  return `${BASE_URL}/export/${path}${qs ? '?' + qs : ''}`
}

export default api
