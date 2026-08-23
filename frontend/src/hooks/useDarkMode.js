import { useState, useEffect } from 'react'

const KEY = 'qa-dark-mode'

function getInitial() {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored !== null) return stored === 'true'
  } catch {}
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch {}
  return false
}

export function useDarkMode() {
  const [isDark, setIsDark] = useState(getInitial)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    try { localStorage.setItem(KEY, String(isDark)) } catch {}
  }, [isDark])

  return [isDark, () => setIsDark(v => !v)]
}
