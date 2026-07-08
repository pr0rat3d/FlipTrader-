import { initializeApp } from 'firebase/app'
import { getMessaging, getToken, isSupported } from 'firebase/messaging'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
}

const app = initializeApp(firebaseConfig)

export const getFCMToken = async () => {
  try {
    if (!(await isSupported())) return
    if (!firebaseConfig.messagingSenderId) {
      console.warn('Firebase messaging not configured: missing VITE_FIREBASE_MESSAGING_SENDER_ID')
      return
    }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return

    const messaging = getMessaging(app)
    const token = await getToken(messaging, {
      vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY
    })
    return token
  } catch (error) {
    console.error('Error getting FCM token:', error)
  }
}
