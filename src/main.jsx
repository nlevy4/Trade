import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <div style={{ width: '100%', maxWidth: 1100 }}>
      <App />
    </div>
  </React.StrictMode>,
)
