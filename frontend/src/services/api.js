import axios from 'axios'

const BASE_URL = import.meta.env.VITE_API_URL || '/api'

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

export const triggerRefresh = () =>
  api.post('/dashboard/refresh')

export const getCacheStatus = () =>
  api.get('/dashboard/cache/status')

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
