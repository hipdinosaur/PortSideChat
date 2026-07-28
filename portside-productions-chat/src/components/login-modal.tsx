import { useEffect, useId, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import './login-modal.scss';

type LoginModalProps = {
  open: boolean;
  reason?: 'gate' | 'manual';
  onClose: () => void;
};

export default function LoginModal({
  open,
  reason = 'manual',
  onClose,
}: LoginModalProps) {
  const emailId = useId();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>(
    'idle'
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStatus('idle');
    setError(null);
  }, [open]);

  if (!open) return null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || status === 'sending') return;

    setStatus('sending');
    setError(null);

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: window.location.origin,
        shouldCreateUser: true,
      },
    });

    if (otpError) {
      setStatus('error');
      setError(otpError.message);
      return;
    }

    setStatus('sent');
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
        <button
          type="button"
          className="login-modal__close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>

        <h2 id="login-modal-title" className="login-modal__title">
          {reason === 'gate' ? 'Sign in to keep chatting' : 'Sign in'}
        </h2>
        <p className="login-modal__copy">
          {reason === 'gate'
            ? "You've used your free question. Enter your email and we'll send a magic link to continue."
            : "Enter your email and we'll send a magic link — no password needed."}
        </p>

        {status === 'sent' ? (
          <p className="login-modal__sent" role="status">
            Check <strong>{email.trim()}</strong> for a sign-in link. You can
            close this window after clicking it.
          </p>
        ) : (
          <form className="login-modal__form" onSubmit={handleSubmit}>
            <label htmlFor={emailId} className="login-modal__label">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              value={email}
              disabled={status === 'sending'}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
            {error && (
              <p className="login-modal__error" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="login-modal__submit"
              disabled={status === 'sending' || !email.trim()}
            >
              {status === 'sending' ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
