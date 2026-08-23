import type { ReactElement, ReactNode } from 'react';

import type { Messages } from '../shape';

export const authRich = {
  notYou: (signOut: ReactNode): ReactElement => <>Это не вы? {signOut}</>,
  noAccount: (create: ReactNode): ReactElement => <>Нет аккаунта? {create}</>,
  haveAccount: (signIn: ReactNode): ReactElement => <>Уже есть аккаунт? {signIn}</>,
  rememberedIt: (signIn: ReactNode): ReactElement => <>Вспомнили? {signIn}</>,
  // Present tense: «пригласил» would need the inviter's gender, which the sealed preview
  // does not carry and the server could not know.
  invitedYou: (who: string, vault: ReactNode): ReactElement => (
    <>
      {who} приглашает вас в {vault}
    </>
  ),
} satisfies Messages['authRich'];
