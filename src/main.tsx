import React from 'react';
import {createRoot} from 'react-dom/client';
import {StudioShell} from './witchcraft/studio-shell';
import './app/base.css';
import './openhiggsfield/openhiggsfield.css';
import './witchcraft/witchcraft.css';
import './witchcraft/prompts.css';
import './witchcraft/access.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><StudioShell/></React.StrictMode>);
