import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { triggerRefresh } from '../services/api'

const REFRESH_INTERVAL_MS = 5 * 60 * 1000  // 5 minutes

export function useAutoRefresh(queryKeys = []) {
  const queryClient = useQueryClient()
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const [nextRefresh, setNextRefresh] = useState(new Date(Date.now() + REFRESH_INTERVAL_MS))
  const [isRefreshing, setIsRefreshing] = useState(false)
  const timerRef = useRef(null)

  const refresh = async (force = false) => {
    setIsRefreshing(true)
    try {
      if (force) {
        await triggerRefresh()
      }
      queryKeys.forEach((key) => {
        queryClient.invalidateQueries({ queryKey: key })
      })
      setLastRefresh(new Date())
      setNextRefresh(new Date(Date.now() + REFRESH_INTERVAL_MS))
    } finally {
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    timerRef.current = setInterval(() => refresh(false), REFRESH_INTERVAL_MS)
    return () => clearInterval(timerRef.current)
  }, [])

  return { lastRefresh, nextRefresh, isRefreshing, refresh }
}
