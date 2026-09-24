import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/crm.css'
import App from './App.jsx'
import { initSiteTracking } from './utils/siteTracking.js'

initSiteTracking()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
