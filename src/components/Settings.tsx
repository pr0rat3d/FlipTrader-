import React, { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { getUserPreferences, saveUserPreferences, getExecutionSettings, setExecutionEnabled } from '../lib/supabase'
import { Auth } from './Auth'

const SECTORS = ['tech', 'healthcare', 'energy', 'financials', 'consumer', 'industrials', 'materials', 'utilities', 'real_estate', 'communications']

export const Settings: React.FC = () => {
  const { user, loading: authLoading, signOut } = useAuth()
  const [selectedSectors, setSelectedSectors] = useState<string[]>(['tech', 'healthcare', 'energy'])
  const [notificationType, setNotificationType] = useState('push')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [executionEnabled, setExecutionEnabledState] = useState(false)
  const [executionToggling, setExecutionToggling] = useState(false)
  const [executionError, setExecutionError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    const loadPreferences = async () => {
      try {
        const prefs = await getUserPreferences(user.id)
        if (prefs) {
          setSelectedSectors(prefs.sector_filters || [])
          setNotificationType(prefs.notification_type || 'push')
        }
      } catch (error) {
        console.error('Error loading preferences:', error)
      } finally {
        setLoading(false)
      }
    }

    loadPreferences()

    getExecutionSettings()
      .then(settings => setExecutionEnabledState(settings.is_enabled))
      .catch(error => console.error('Error loading execution settings:', error))
  }, [user])

  const handleToggleExecution = async () => {
    const next = !executionEnabled
    setExecutionToggling(true)
    setExecutionError(null)
    try {
      await setExecutionEnabled(next)
      setExecutionEnabledState(next)
    } catch (error) {
      console.error('Error updating execution settings:', error)
      setExecutionError(error instanceof Error ? error.message : String(error))
    } finally {
      setExecutionToggling(false)
    }
  }

  const toggleSector = (sector: string) => {
    setSelectedSectors(prev =>
      prev.includes(sector)
        ? prev.filter(s => s !== sector)
        : [...prev, sector]
    )
  }

  const handleSave = async () => {
    if (!user) return
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      await saveUserPreferences(user.id, {
        sector_filters: selectedSectors,
        notification_type: notificationType
      })
      setSaved(true)
    } catch (error) {
      console.error('Error saving preferences:', error)
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (authLoading) {
    return <div className="p-4"><p className="text-gray-400">Loading...</p></div>
  }

  if (!user) {
    return (
      <div className="p-4">
        <h2 className="text-2xl font-bold text-white mb-4">Settings</h2>
        <p className="text-gray-400 mb-4">Log in to save your sector preferences and notification settings.</p>
        <Auth />
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-white">Settings</h2>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span className="text-xs text-gray-400">{user.email}</span>
          <button onClick={signOut} className="px-3 py-1 bg-gray-700 text-gray-400 rounded text-sm">
            Log Out
          </button>
        </div>
      </div>

      {loading && <p className="text-gray-400">Loading preferences...</p>}

      {!loading && (
        <>
          <div className="mb-6">
            <h3 className="text-lg font-bold text-white mb-3">Automated Paper Trading</h3>
            <p className="text-xs text-gray-400 mb-3">
              When enabled, new qualifying signals are automatically entered on Alpaca paper trading.
              Turning this off only stops NEW entries - positions already open keep being monitored
              and protected.
            </p>
            <label className="flex items-center text-white cursor-pointer">
              <input
                type="checkbox"
                checked={executionEnabled}
                disabled={executionToggling}
                onChange={handleToggleExecution}
                className="mr-2"
              />
              {executionEnabled ? 'Enabled' : 'Disabled'}
            </label>
            {executionError && <p className="text-sm text-red-400 mt-2">Failed to update: {executionError}</p>}
          </div>

          <div className="mb-6">
            <h3 className="text-lg font-bold text-white mb-3">Notification Type</h3>
            <div className="space-y-2">
              <label className="flex items-center text-white cursor-pointer">
                <input
                  type="radio"
                  name="notif"
                  value="push"
                  checked={notificationType === 'push'}
                  onChange={(e) => setNotificationType(e.target.value)}
                  className="mr-2"
                />
                Push Notifications (Browser)
              </label>
              <label className="flex items-center text-white cursor-pointer">
                <input
                  type="radio"
                  name="notif"
                  value="sms"
                  checked={notificationType === 'sms'}
                  onChange={(e) => setNotificationType(e.target.value)}
                  className="mr-2"
                />
                SMS (Coming Soon)
              </label>
              <label className="flex items-center text-white cursor-pointer">
                <input
                  type="radio"
                  name="notif"
                  value="both"
                  checked={notificationType === 'both'}
                  onChange={(e) => setNotificationType(e.target.value)}
                  className="mr-2"
                />
                Both
              </label>
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-lg font-bold text-white mb-3">Swing Trade Sectors</h3>
            <p className="text-xs text-gray-400 mb-3">Controls which sectors' stocks get scanned for swing alerts.</p>
            <div className="grid grid-cols-2 gap-3">
              {SECTORS.map(sector => (
                <label key={sector} className="flex items-center text-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedSectors.includes(sector)}
                    onChange={() => toggleSector(sector)}
                    className="mr-2"
                  />
                  {sector.charAt(0).toUpperCase() + sector.slice(1).replace('_', ' ')}
                </label>
              ))}
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            {saving ? 'Saving...' : 'Save Preferences'}
          </button>
          {saved && <span className="text-sm text-green-400 ml-2">Saved!</span>}
          {saveError && <p className="text-sm text-red-400 mt-2">Failed to save: {saveError}</p>}
        </>
      )}
    </div>
  )
}
