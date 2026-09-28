import { createRoot } from 'react-dom/client';
import { HostApp } from './HostApp.js';
import './host.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<HostApp />);
