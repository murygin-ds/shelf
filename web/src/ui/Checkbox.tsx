import type { ReactNode } from 'react';

import { Icon } from './Icon';
import styles from './checkbox.module.css';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}

/**
 * A checkbox, which this app had no need for until something had to be consented to rather
 * than merely chosen.
 *
 * The native input is kept and hidden rather than replaced by a div: it is what makes the
 * control reachable by keyboard, focusable, and announced as a checkbox — none of which a
 * styled span would be, and all of which matter for a control whose whole job is to record
 * that somebody understood what they were agreeing to.
 */
export default function Checkbox({ checked, onChange, children, disabled }: Props) {
  return (
    <label className={styles.field} data-disabled={disabled ? 'true' : 'false'}>
      <input
        className={styles.input}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden className={styles.box}>
        <Icon name="check" size={11} />
      </span>
      <span className={styles.label}>{children}</span>
    </label>
  );
}
