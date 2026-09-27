import React from 'react';
import { createRoot } from 'react-dom/client';
import PopupLauncher from './components/PopupLauncher';

const container = document.getElementById('root');
const root = createRoot(container);
root.render(<PopupLauncher />);
