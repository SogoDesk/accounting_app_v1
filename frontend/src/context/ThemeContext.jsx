import { createContext, useContext, useEffect, useState } from 'react'

const ThemeContext = createContext(null)

// The five theme colours from the design handoff. Purple is the default.
// The key is persisted; the hex is written to --accent on :root, and every
// accent tint in saas.css is derived from it with color-mix.
export const ACCENTS = [
  { key: 'purple', label: 'Purple', hex: '#5b4de3' },
  { key: 'blue', label: 'Blue', hex: '#1570d6' },
  { key: 'pink', label: 'Pink', hex: '#b8476e' },
  { key: 'green', label: 'Green', hex: '#53a37c' },
  { key: 'orange', label: 'Orange', hex: '#e0a02e' },
]

const DEFAULT_ACCENT = 'purple'
const accentHex = (key) =>
  (ACCENTS.find((a) => a.key === key) || ACCENTS[0]).hex

export function ThemeProvider({ children }) {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')
  const [accent, setAccentState] = useState(() => {
    const stored = localStorage.getItem('accent')
    return ACCENTS.some((a) => a.key === stored) ? stored : DEFAULT_ACCENT
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accentHex(accent))
    localStorage.setItem('accent', accent)
  }, [accent])

  const setAccent = (key) => {
    if (ACCENTS.some((a) => a.key === key)) setAccentState(key)
  }

  return (
    <ThemeContext.Provider
      value={{ dark, toggle: () => setDark((d) => !d), accent, setAccent, accents: ACCENTS }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
