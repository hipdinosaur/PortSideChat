import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import closeIcon from '../assets/icon-close.svg';
import './login-modal.scss';

type LoginModalProps = {
  open: boolean;
  reason?: 'gate' | 'manual';
  onClose: () => void;
  onAuthenticated?: (session: Session) => void;
};

type Mode = 'signin' | 'signup' | 'forgot';
type Status = 'idle' | 'submitting' | 'confirm' | 'reset-sent' | 'error';

const RESIZE_MS = 420;
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1,
  );
}

export default function LoginModal({
  open,
  onClose,
  onAuthenticated,
}: LoginModalProps) {
  const emailId = useId();
  const passwordId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const onAuthenticatedRef = useRef(onAuthenticated);
  onCloseRef.current = onClose;
  onAuthenticatedRef.current = onAuthenticated;
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [animateHeight, setAnimateHeight] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMode('signin');
      setEmail('');
      setPassword('');
      setStatus('idle');
      setError(null);
      setPanelHeight(null);
      setAnimateHeight(false);
    }
  }

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

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

  useLayoutEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const dialog = dialogRef.current;
    const panelEl = panelRef.current;
    if (!dialog || !panelEl) return;
    const panel: HTMLElement = panelEl;

    const siblings = [...(dialog.parentElement?.children ?? [])].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== dialog,
    );
    siblings.forEach((el) => {
      el.inert = true;
    });

    const focusTarget =
      emailRef.current ?? getFocusable(panel)[0] ?? panel;
    focusTarget.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;

      const nodes = getFocusable(panel);
      if (nodes.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      siblings.forEach((el) => {
        el.inert = false;
      });
      previouslyFocused?.focus();
    };
  }, [open]);

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

      onAuthenticatedRef.current?.(data.session);
      return;
    }

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });

    if (signInError) {
      setStatus('error');
      setError(signInError.message);
      return;
    }

    if (data.session) {
      onAuthenticatedRef.current?.(data.session);
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
    <div ref={dialogRef} className="login-modal">
      <div
        className="login-modal__backdrop"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className={`login-modal__panel login-modal__panel--${mode}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
        tabIndex={-1}
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
                    ref={emailRef}
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
