import React, { useEffect, useState } from 'react'

const FADE_OUT_AT_MS = 1100
const UNMOUNT_AT_MS = 1500

// Shown once per app load (App.tsx only mounts this on initial render, not on
// in-app nav) - rendered as an overlay so the real app can mount/fetch underneath
// while this is visible, avoiding a jarring "splash -> blank loading state" gap.
export const Splash: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [fadeOut, setFadeOut] = useState(false)

  useEffect(() => {
    const fadeOutTimer = setTimeout(() => setFadeOut(true), FADE_OUT_AT_MS)
    const doneTimer = setTimeout(onDone, UNMOUNT_AT_MS)
    return () => {
      clearTimeout(fadeOutTimer)
      clearTimeout(doneTimer)
    }
  }, [onDone])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000000',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: fadeOut ? 0 : 1,
        transition: 'opacity 400ms ease'
      }}
    >
      <img
        src="/icon-512.png"
        alt="FlipTrader"
        style={{ width: 120, height: 120, borderRadius: 24, animation: 'splash-fade-in 500ms ease both' }}
      />
      <div
        style={{
          color: '#10b981',
          fontSize: 28,
          fontWeight: 800,
          marginTop: 16,
          letterSpacing: -0.5,
          animation: 'splash-fade-in 500ms ease 150ms both'
        }}
      >
        FlipTrader
      </div>
      <style>{`
        @keyframes splash-fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
