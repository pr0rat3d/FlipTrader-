import { useEffect } from 'react'
import { getFCMToken } from '../lib/firebase'

export const useFirebase = () => {
  useEffect(() => {
    const registerFCM = async () => {
      const token = await getFCMToken()
      if (!token) return

      try {
        await fetch('/api/register-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        })
      } catch (error) {
        console.error('Error registering FCM token:', error)
      }
    }

    registerFCM()
  }, [])
}
