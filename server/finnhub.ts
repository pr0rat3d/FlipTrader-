import axios from 'axios'

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY
const BASE_URL = 'https://finnhub.io/api/v1'

export const getQuote = async (symbol: string) => {
  try {
    const response = await axios.get(`${BASE_URL}/quote`, {
      params: { symbol, token: FINNHUB_API_KEY }
    })
    return response.data
  } catch (error) {
    console.error(`Error fetching quote for ${symbol}:`, error)
    return null
  }
}
