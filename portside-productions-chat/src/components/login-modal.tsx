import { useEffect, useId, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import closeIcon from '../assets/icon-close.svg';
import './login-modal.scss';

type LoginModalProps = {
  open: boolean;
  reason?: 'gate' | 'manual';
  onClose: () => void;
};

type Mode = 'signin' | 'signup';
type Status = 'idle' | 'submitting' | 'confirm' | 'error';

export default function LoginModal({
  open,
  onClose,
}: LoginModalProps) {
  const emailId = useId();
  const passwordId = useId();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('signin');
    setEmail('');
    setPassword('');
    setStatus('idle');
    setError(null);
  }, [open]);

  if (!open) return null;

  const isSignup = mode === 'signup';
  const title = isSignup ? 'Create an account' : 'Sign in';
  const secondaryLabel = isSignup ? 'Sign in' : 'Create an Account';
  const busy = status === 'submitting';

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password || busy) return;

    setStatus('submitting');
    setError(null);

    if (isSignup) {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          emailRedirectTo: window.location.origin,
        },
      });

      if (signUpError) {
        setStatus('error');
        setError(signUpError.message);
        return;
      }

      // If email confirmation is enabled, session may be null until verified.
      if (!data.session) {
        setStatus('confirm');
        return;
      }

      setStatus('idle');
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });

    if (signInError) {
      setStatus('error');
      setError(signInError.message);
      return;
    }

    setStatus('idle');
  }

  function switchMode() {
    setMode((current) => (current === 'signin' ? 'signup' : 'signin'));
    setStatus('idle');
    setError(null);
  }

  return (
    <div
      className="login-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-modal-title"
    >
      <button
        type="button"
        className="login-modal__backdrop"
        aria-label="Close login"
        onClick={onClose}
      />
      <div className="login-modal__panel">
        <div className="login-modal__header">
          <h2
            id="login-modal-title"
            className={`login-modal__title${isSignup ? ' login-modal__title--compact' : ''}`}
          >
            {title}
          </h2>
          <button
            type="button"
            className="login-modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            <img src={closeIcon} alt="" width={13} height={13} />
          </button>
        </div>

        {status === 'confirm' ? (
          <p className="login-modal__confirm" role="status">
            Check <strong>{email.trim()}</strong> to confirm your account, then
            sign in.
          </p>
        ) : (
          <form className="login-modal__form" onSubmit={handleSubmit}>
            <label className="login-modal__field" htmlFor={emailId}>
              <span className="visually-hidden">Email</span>
              <input
                id={emailId}
                type="email"
                autoComplete="email"
                required
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
              />
            </label>

            <label className="login-modal__field" htmlFor={passwordId}>
              <span className="visually-hidden">Password</span>
              <input
                id={passwordId}
                type="password"
                autoComplete={
                  isSignup ? 'new-password' : 'current-password'
                }
                required
                minLength={6}
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
              />
            </label>

            {error && (
              <p className="login-modal__error" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="login-modal__submit"
              disabled={busy || !email.trim() || !password}
            >
              {busy ? 'Submitting…' : 'Submit'}
            </button>

            <button
              type="button"
              className="login-modal__secondary"
              onClick={switchMode}
              disabled={busy}
            >
              {secondaryLabel}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
