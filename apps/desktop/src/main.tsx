import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// TEMP DEBUG (white window): surface boot/JS errors on screen so a blank
// window can be traced without devtools (remove once diagnosed).
window.addEventListener('error', (e) => {
  const el = document.createElement('pre');
  el.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;background:#fee;color:#900;z-index:9999;padding:8px;font-size:12px;white-space:pre-wrap;margin:0;';
  el.textContent = `[page error] ${e.message} @ ${e.filename}:${e.lineno}`;
  document.body.appendChild(el);
});
window.addEventListener('unhandledrejection', (e) => {
  const el = document.createElement('pre');
  el.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;background:#fee;color:#900;z-index:9999;padding:8px;font-size:12px;white-space:pre-wrap;margin:0;';
  el.textContent = `[unhandled rejection] ${String(e.reason)}`;
  document.body.appendChild(el);
});
console.log('[mission-pilot] boot, href=', window.location.href);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
