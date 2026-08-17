import { BrowserRouter } from 'react-router-dom';

import { RootMenu } from './features/shell/RootMenu';
import { AppRoutes } from './routes';
import { IconSprite } from './ui/Icon';
import { TooltipLayer } from './ui/Tooltip';

export function App() {
  return (
    <BrowserRouter>
      <IconSprite />
      <AppRoutes />
      {/* Last, and outside the routes: it answers the right button for whatever the routes
          did not, so it has to outlive any one screen. */}
      <RootMenu />
      <TooltipLayer />
    </BrowserRouter>
  );
}
