import { createRoot } from 'react-dom/client'
import { FluentProvider } from '@fluentui/react-components'
import { androidRemoteDarkTheme } from './theme'
import './index.css'
import App from './App.tsx'

// StrictMode disabled temporarily to test WebRTC connection
// StrictMode in React 18 causes effects to run twice, which breaks WebSocket connections
createRoot(document.getElementById('root')!).render(
  <FluentProvider theme={androidRemoteDarkTheme}>
    <App />
  </FluentProvider>,
)
