import type { ReactElement, ReactNode } from 'react';

import type { Messages } from '../shape';

export const uiRich = {
  typeToConfirm: (phrase: ReactNode): ReactElement => <>Введите {phrase}, чтобы подтвердить</>,
} satisfies Messages['uiRich'];
