import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type ConnectionState = 'checking' | 'connected' | 'unavailable';

function App() {
  const [connection, setConnection] = useState<ConnectionState>('checking');

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch('/health');
        if (active) setConnection(response.ok ? 'connected' : 'unavailable');
      } catch {
        if (active) setConnection('unavailable');
      }
    };
    void check();
    const timer = window.setInterval(check, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return (
    <main>
      <p className="eyebrow">Local Runtime</p>
      <h1>IRIS</h1>
      <p className={`status status--${connection}`} role="status">
        <span aria-hidden="true" /> Connection {connection}
      </p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);
