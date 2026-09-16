import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/chrome.css'
import './styles/surfaces.css'
import './styles/grid.css'
import './styles/overlays.css'
import './styles/voice.css'
import './styles/update.css'
import './styles/brain.css'
import './styles/stats.css'
import './styles/browser.css'
import './styles/usage.css'
import './styles/accounts.css'
import './styles/integrations.css'
import './styles/trial.css'
import './styles/host-picker.css'
// After the three sheets above: the row grammar they share.
import './styles/settings-rows.css'
import './styles/tasks.css'
import './styles/preview.css'
import './styles/pages.css'
import './styles/search.css'
import './styles/automations.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

// Neither of these reaches the error boundary — a boundary only sees what
// throws during React's own work — so they are logged here or not at all.
window.addEventListener('error', (e) => {
  console.error('[eaon] uncaught error:', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[eaon] unhandled rejection:', e.reason)
})

/*
 * A file dropped anywhere the app does not handle it would otherwise be opened
 * by Chromium — which, in a window that is the whole application, means the UI
 * is replaced by the contents of that file and there is no way back. Panes call
 * preventDefault themselves and these never see the event; this is only the
 * backstop for everything that misses one.
 */
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

// No StrictMode: terminals are imperative, long-lived DOM. Double-mounting
// them in development costs more than it catches.
createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
