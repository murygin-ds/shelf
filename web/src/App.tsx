import { BrowserRouter } from 'react-router-dom';

import { AppRoutes } from './routes';
import { IconSprite } from './ui/Icon';

export function App() {
  return (
    <BrowserRouter>
      <IconSprite />
      <AppRoutes />
    </BrowserRouter>
  );
}
