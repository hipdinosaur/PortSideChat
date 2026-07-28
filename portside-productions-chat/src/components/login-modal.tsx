import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { supabase } from '../lib/supabase';
import closeIcon from '../assets/icon-close.svg';
import './login-modal.scss';

type LoginModalProps = {
  open: boolean;
  reason?: 'gate' | 'manual';
  onClose: () => void;
};

type Mode = 'signin' | 'signup' | 'forgot';
type Status = 'idle' | 'submitting' | 'confirm' | 'reset-sent' | 'error';

const RESIZE_MS = 420;

export default function LoginModal({ open, onClose }: LoginModalProps) {
  const emailId = useId();
  const passwordId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [animateHeight, setAnimateHeight] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    setMode('signin');
    setEmail('');
    setPassword('');
    setStatus('idle');
    setError(null);
    setPanelHeight(null);
    setAnimateHeight(false);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !bodyRef.current) return;

    const body = bodyRef.current;
    const measure = () => {
      const next = body.getBoundingClientRect().height;
      setPanelHeight((prev) => (prev === next ? prev : next));
    };

    measure();
    const frame = window.requestAnimationFrame(() => {
      setAnimateHeight(true);
    });

    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open, mode, status, error]);

  if (!open) return null;

  const busy = status === 'submitting';
  const showMessage = status === 'confirm' || status === 'reset-sent';

  const title =
    mode === 'signup'
      ? 'Create your account'
      : mode === 'forgot'
        ? 'Forgot password'
        : 'Sign in';

  const primaryLabel =
    mode === 'signup'
      ? 'Create your Account'
      : busy
        ? 'Submitting…'
        : 'Submit';

  const secondaryLabel =
    mode === 'signin' ? 'Create an Account' : 'Return to sign in';

  function goTo(next: Mode) {
    setMode(next);
    setStatus('idle');
    setError(null);
    if (next === 'signup') {
      setPassword('');
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || busy) return;

    if (mode === 'forgot') {
      setStatus('submitting');
      setError(null);

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        trimmedEmail,
        { redirectTo: window.location.origin }
      );

      if (resetError) {
        setStatus('error');
        setError(resetError.message);
        return;
      }

      setStatus('reset-sent');
      return;
    }

    if (!password) return;

    setStatus('submitting');
    setError(null);

    if (mode === 'signup') {
      if (password.length < 8) {
        setStatus('error');
        setError('Password must be 8 or more characters.');
        return;
      }

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

  function handleSecondary() {
    if (mode === 'signin') {
      goTo('signup');
      return;
    }
    goTo('signin');
  }

  const panelStyle =
    panelHeight != null
      ? {
          height: `${panelHeight}px`,
          transition:
            animateHeight && !reduceMotion
              ? `height ${RESIZE_MS}ms cubic-bezier(0.3, 0, 0, 1)`
              : undefined,
        }
      : undefined;

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
      <div
        ref={panelRef}
        className={`login-modal__panel login-modal__panel--${mode}`}
        style={panelStyle}
      >
        <div ref={bodyRef} className="login-modal__body">
          <div className="login-modal__header">
            <h2
              id="login-modal-title"
              className={`login-modal__title${mode === 'signup' ? ' login-modal__title--wrap' : ''}`}
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

          {showMessage ? (
            <div className="login-modal__message" role="status">
              <p>
                {status === 'reset-sent' ? (
                  <>
                    Check <strong>{email.trim()}</strong> for a password reset
                    link.
                  </>
                ) : (
                  <>
                    Check <strong>{email.trim()}</strong> to confirm your
                    account, then sign in.
                  </>
                )}
              </p>
              <button
                type="button"
                className="login-modal__secondary"
                onClick={() => goTo('signin')}
              >
                Return to sign in
              </button>
            </div>
          ) : (
            <form className="login-modal__form" onSubmit={handleSubmit}>
              <div className="login-modal__fields">
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

                {mode !== 'forgot' && (
                  <div className="login-modal__password-block">
                    <label className="login-modal__field" htmlFor={passwordId}>
                      <span className="visually-hidden">Password</span>
                      <input
                        id={passwordId}
                        type="password"
                        autoComplete={
                          mode === 'signup' ? 'new-password' : 'current-password'
                        }
                        required
                        minLength={mode === 'signup' ? 8 : 6}
                        value={password}
                        disabled={busy}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                      />
                    </label>
                    {mode === 'signup' && (
                      <p className="login-modal__hint">8 or more characters</p>
                    )}
                  </div>
                )}

                {error && (
                  <p className="login-modal__error" role="alert">
                    {error}
                  </p>
                )}
              </div>

              <div className="login-modal__actions">
                <button
                  type="submit"
                  className="login-modal__submit"
                  disabled={
                    busy ||
                    !email.trim() ||
                    (mode !== 'forgot' && !password)
                  }
                >
                  {primaryLabel}
                </button>

                <button
                  type="button"
                  className="login-modal__secondary"
                  onClick={handleSecondary}
                  disabled={busy}
                >
                  {secondaryLabel}
                </button>
              </div>

              {mode === 'signin' && (
                <button
                  type="button"
                  className="login-modal__forgot"
                  onClick={() => goTo('forgot')}
                  disabled={busy}
                >
                  Forgot Password?
                </button>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
