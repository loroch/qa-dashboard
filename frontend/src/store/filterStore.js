import { create } from 'zustand'

export const useFilterStore = create((set) => ({
  filters: {
    projects: '',
    assignee_ids: '',
    version: '',
    status: '',
    priority: '',
    date_from: '',
    date_to: '',
  },
  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  resetFilters: () =>
    set({
      filters: {
        projects: '',
        assignee_ids: '',
        version: '',
        status: '',
        priority: '',
        date_from: '',
        date_to: '',
      },
    }),
  getActiveFilters: (state) => {
    const active = {}
    Object.entries(state.filters).forEach(([k, v]) => {
      if (v) active[k] = v
    })
    return active
  },
}))
