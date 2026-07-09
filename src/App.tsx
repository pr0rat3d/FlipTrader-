import React, { useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { WatchlistManager } from './components/WatchlistManager'
import { Settings } from './components/Settings'
import { AlertHistory } from './components/AlertHistory'
import { Indicators } from './components/Indicators'
import { Performance } from './components/Performance'
import { useFirebase } from './hooks/useFirebase'
import './index.css'

type Page = 'dashboard' | 'watchlist' | 'indicators' | 'performance' | 'history' | 'settings'

export const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard')
  useFirebase()

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard': return <Dashboard />
      case 'watchlist': return <WatchlistManager />
      case 'indicators': return <Indicators />
      case 'performance': return <Performance />
      case 'history': return <AlertHistory />
      case 'settings': return <Settings />
      default: return <Dashboard />
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="min-h-[calc(100vh-60px)] pb-20">
        {renderPage()}
      </div>

      <nav className="fixed bottom-0 w-full bg-gray-900 border-t border-gray-700 flex justify-around">
        {(['dashboard', 'watchlist', 'indicators', 'performance', 'history', 'settings'] as const).map(page => (
          <button
            key={page}
            onClick={() => setCurrentPage(page)}
            className={`flex-1 py-3 text-center ${
              currentPage === page
                ? 'bg-green-600 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            {page.charAt(0).toUpperCase() + page.slice(1)}
          </button>
        ))}
      </nav>
    </div>
  )
}

export default App
