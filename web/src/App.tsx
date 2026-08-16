import { BrowserRouter } from 'react-router-dom';

import { AppRoutes } from './routes';
import { IconSprite } from './ui/Icon';
import { TooltipLayer } from './ui/Tooltip';

export function App() {
  return (
    <BrowserRouter>
      <IconSprite />
      <AppRoutes />
      <TooltipLayer />
    </BrowserRouter>
  );
}
