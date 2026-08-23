/**
 * The auth sentences that carry a node.
 *
 * Four of them are the card's footer, where the way out to the other screen is a link or a
 * button sitting inside the sentence; the fifth is the invite headline, where the vault
 * name is coloured and the inviter's name opens the sentence. Splitting those into a prefix
 * and a suffix reads fine in English and falls apart in Russian, which puts the same pieces
 * in a different order — so the translation returns the whole element and owns the order.
 */

import type { ReactElement, ReactNode } from 'react';

export const authRich = {
  notYou: (signOut: ReactNode): ReactElement => <>Not you? {signOut}</>,
  noAccount: (create: ReactNode): ReactElement => <>No account? {create}</>,
  haveAccount: (signIn: ReactNode): ReactElement => <>Have an account? {signIn}</>,
  rememberedIt: (signIn: ReactNode): ReactElement => <>Remembered it? {signIn}</>,
  invitedYou: (who: string, vault: ReactNode): ReactElement => (
    <>
      {who} invited you to {vault}
    </>
  ),
};
