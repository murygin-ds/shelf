import { useSession } from '@/store/session';
import { Icon } from '@/ui/Icon';

/**
 * Placeholder for the vault workspace. The tree, editor, inspector and modals land here
 * once the encrypted workspace API exists; for now it proves the keys are in memory.
 */
export function Workspace() {
  const { user, identity, signOut, lock } = useSession();

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeContent: 'center',
        justifyItems: 'center',
        gap: 14,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <span style={{ width: 16, height: 16, borderRadius: 4, background: 'var(--accent)' }} />

      <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>
        {user?.display_name}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{user?.login}</div>

      <div
        className="label"
        style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ok)' }}
      >
        <Icon name="lock" size={11} />
        KEY UNLOCKED
      </div>

      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--text-ghost)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '8px 12px',
        }}
      >
        {identity?.fingerprint}
      </div>

      <div style={{ display: 'flex', gap: 9, marginTop: 6 }}>
        <button
          type="button"
          onClick={lock}
          style={{
            height: 32,
            padding: '0 14px',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 12.5,
            cursor: 'pointer',
          }}
        >
          Lock
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          style={{
            height: 32,
            padding: '0 14px',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 12.5,
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
