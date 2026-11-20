import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import closeIcon from '../assets/icon-close.svg';
import './login-modal.scss';

type SubscribeModalProps = {
  open: boolean;
  onClose: () => void;
  onSubscribed?: (email: string) => void;
};

type Status = 'idle' | 'submitting' | 'done' | 'error';

const RESIZE_MS = 420;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

export default function SubscribeModal({
  open,
  onClose,
  onSubscribed,
}: SubscribeModalProps) {
  const emailId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const onSubscribedRef = useRef(onSubscribed);
  const submitIdRef = useRef(0);
  onCloseRef.current = onClose;
  onSubscribedRef.current = onSubscribed;
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [animateHeight, setAnimateHeight] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      submitIdRef.current += 1;
      setEmail('');
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
  }, [open, status, error]);

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

    const focusTarget = emailRef.current ?? getFocusable(panel)[0] ?? panel;
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

  const done = status === 'done';

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || done || status === 'submitting') return;

    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setStatus('error');
      setError('Enter a valid email.');
      return;
    }

    const submitId = submitIdRef.current;
    setEmail(trimmedEmail);
    setError(null);
    setStatus('submitting');

    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (submitIdRef.current !== submitId) return;

      if (!res.ok) {
        setStatus('error');
        setError(data?.error ?? 'Could not subscribe. Try again.');
        return;
      }

      setStatus('done');
      onSubscribedRef.current?.(trimmedEmail);
    } catch {
      if (submitIdRef.current !== submitId) return;
      setStatus('error');
      setError('Could not subscribe. Try again.');
    }
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
      <div className="login-modal__backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className="login-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subscribe-modal-title"
        tabIndex={-1}
        style={panelStyle}
      >
        <div ref={bodyRef} className="login-modal__body">
          <div className="login-modal__header">
            <h2 id="subscribe-modal-title" className="login-modal__title">
              Subscribe
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

          {done ? (
            <div className="login-modal__message" role="status">
              <p>
                Thanks. We&apos;ll send the latest insights to{' '}
                <strong>{email}</strong>.
              </p>
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
                    disabled={status === 'submitting'}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (status === 'error') {
                        setStatus('idle');
                        setError(null);
                      }
                    }}
                    placeholder="Email"
                  />
                </label>

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
                  disabled={!email.trim() || status === 'submitting'}
                >
                  {status === 'submitting' ? 'Subscribing' : 'Subscribe'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
