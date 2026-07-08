import React, { useState } from 'react'
import { useAuth } from '../hooks/useAuth'

export const Auth: React.FC = () => {
  const { signUp, signIn } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setSubmitting(true)

    try {
      if (mode === 'signup') {
        await signUp(email, password)
        setInfo('Account created. If email confirmation is enabled, check your inbox before signing in.')
      } else {
        await signIn(email, password)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-4">{mode === 'signin' ? 'Log In' : 'Sign Up'}</h2>

      <form onSubmit={handleSubmit} className="space-y-2" style={{ maxWidth: 360 }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          required
          className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          required
          minLength={6}
          className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600"
        />

        {error && <p className="text-sm text-red-400">{error}</p>}
        {info && <p className="text-sm text-green-400">{info}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
        >
          {submitting ? 'Please wait...' : mode === 'signin' ? 'Log In' : 'Sign Up'}
        </button>
      </form>

      <button
        onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setInfo(null) }}
        className="text-sm text-gray-400 hover:text-white mt-3"
      >
        {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
      </button>
    </div>
  )
}
