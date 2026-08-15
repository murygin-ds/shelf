import { strength } from '@/lib/passphrase';

import styles from './auth.module.css';

const BARS = 4;

export function PassphraseMeter({ value }: { value: string }) {
  const { score, hint } = strength(value);

  return (
    <>
      <span className={styles.meter}>
        {Array.from({ length: BARS }, (_, index) => (
          <span
            key={index}
            className={[
              styles.meterBar,
              index < score ? (score <= 1 ? styles.meterBarWeak : styles.meterBarOn) : '',
            ]
              .filter(Boolean)
              .join(' ')}
          />
        ))}
      </span>
      {hint ? <span className={styles.meterHint}>{hint}</span> : null}
    </>
  );
}
