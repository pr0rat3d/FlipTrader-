import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')
const isConfigured = Object.keys(serviceAccount).length > 0

if (isConfigured && getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount)
  })
}

export const sendPushNotification = async (fcmToken: string, title: string, body: string) => {
  if (!isConfigured) return
  try {
    const messaging = getMessaging()

    await messaging.send({
      notification: { title, body },
      token: fcmToken
    })

    console.log(`Notification sent to ${fcmToken}`)
  } catch (error) {
    console.error('Error sending notification:', error)
  }
}

export const sendToTopic = async (topic: string, title: string, body: string) => {
  if (!isConfigured) return
  try {
    const messaging = getMessaging()

    await messaging.send({
      notification: { title, body },
      topic
    })

    console.log(`Notification sent to topic ${topic}`)
  } catch (error) {
    console.error('Error sending to topic:', error)
  }
}

export const subscribeToTopic = async (fcmToken: string, topic: string) => {
  if (!isConfigured) {
    throw new Error('Firebase not configured: missing FIREBASE_SERVICE_ACCOUNT')
  }
  const messaging = getMessaging()
  const response = await messaging.subscribeToTopic([fcmToken], topic)
  if (response.failureCount > 0) {
    throw new Error(response.errors[0]?.error.message || 'Failed to subscribe token to topic')
  }
}
