import React, { useState } from 'react'

const SECTORS = ['tech', 'healthcare', 'energy', 'financials', 'consumer', 'industrials', 'materials', 'utilities', 'real_estate', 'communications']

export const Settings: React.FC = () => {
  const [selectedSectors, setSelectedSectors] = useState(['tech', 'healthcare', 'energy'])
  const [notificationType, setNotificationType] = useState('push')

  const toggleSector = (sector: string) => {
    setSelectedSectors(prev =>
      prev.includes(sector)
        ? prev.filter(s => s !== sector)
        : [...prev, sector]
    )
  }

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-6">Settings</h2>

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

      <div>
        <h3 className="text-lg font-bold text-white mb-3">Swing Trade Sectors</h3>
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
    </div>
  )
}
