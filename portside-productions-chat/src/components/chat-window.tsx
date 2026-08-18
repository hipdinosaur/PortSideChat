import { useState, useEffect, useRef, useId, type CSSProperties } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import parseHtml from 'html-react-parser';
import ThinkingSpinner from './thinking-spinner';
import LoginModal from './login-modal';
import { useAuth } from '../hooks/use-auth';
import { hasUsedFreeChat, markFreeChatUsed } from '../lib/free-chat';
import { supabase } from '../lib/supabase';
import loginArrow from '../assets/icon-login-arrow.svg';
import './chat-window.scss';

const SUGGESTION_ROWS = [
  [
    "What's unique about marketing for the outdoor industry?",
    'How do I build an audience for my outdoor brand?',
    'What are the best social media platforms for outdoor enthusiasts?',
    'How can I leverage influencer marketing to promote my outdoor gear?',
    'What content strategies engage hikers and campers effectively?',
    'How do I create compelling storytelling around my outdoor products?',
    'How do you justify content marketing spend to leadership?',
  ],
  [
    "What partnerships can help expand my outdoor brand's reach?",
    'How do I optimize my website for outdoor adventure seekers?',
    'What role does sustainability play in attracting outdoor consumers?',
    'How do I find my brand voice on social?',
    'How should brands support retail partners?',
    "What's the difference between building a brand and an online retailer?",
    'How do I work with an agency on outdoor campaigns?',
  ],
  [
    'What makes a compelling outdoor story?',
    'How do I develop consumer insights for my brand?',
    'Is print media still relevant for outdoor brands?',
    'How can brands use YouTube effectively?',
    'How do I scale an outdoor brand?',
    'How do I hire and build a high-performing marketing team?',
  ],
] as const;

const PORTSIDE_URL = 'https://www.portsidepro.com';
const PRIVACY_URL = `${PORTSIDE_URL}/privacy-policy`;
/** Retrieval returns many chunks per answer; show a few episodes, not all. */

/** Keep in sync with `$transition-exit` in chat-window.scss */
const EXIT_MS = 700;
const GATE_LABEL = 'Login to continue';
const MARQUEE_PX_PER_SEC = 40;
const LYR_DEFAULT_X = 17;
const LYR_DEFAULT_Y = -35;
const LYR_GLASS_RIGHT_X = 100;
const LYR_SCREEN_RIGHT_X = 143;
const LYR_TOP_Y = 0;
const LYR_BOTTOM_Y = 80;
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const LYR_MOUSE_TRACKING = true;
const PARALLAX_FACTOR = -0.1;

function nearestGlassRect(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): DOMRect | null {
  const glasses = root.querySelectorAll<HTMLElement>('.chat-input__glass');
  let best: DOMRect | null = null;
  let bestDist = Infinity;

  glasses.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const clampedX = Math.min(Math.max(clientX, rect.left), rect.right);
    const clampedY = Math.min(Math.max(clientY, rect.top), rect.bottom);
    const dist =
      (clientX - clampedX) * (clientX - clampedX) +
      (clientY - clampedY) * (clientY - clampedY);
    if (dist < bestDist) {
      bestDist = dist;
      best = rect;
    }
  });

  return best;
}

function lyrFromMouse(
  clientX: number,
  clientY: number,
  glass: DOMRect,
): { x: number; y: number } {
  const viewportRight = window.innerWidth;
  let x: number;
  if (clientX <= glass.right || viewportRight <= glass.right) {
    x = ((clientX - glass.left) / glass.width) * LYR_GLASS_RIGHT_X;
  } else {
    const t = (clientX - glass.right) / (viewportRight - glass.right);
    x =
      LYR_GLASS_RIGHT_X +
      t * (LYR_SCREEN_RIGHT_X - LYR_GLASS_RIGHT_X);
  }

  const y = Math.min(
    LYR_BOTTOM_Y,
    Math.max(
      LYR_TOP_Y,
      ((clientY - glass.top) / glass.height) * (LYR_BOTTOM_Y - LYR_TOP_Y) +
        LYR_TOP_Y,
    ),
  );

  return { x, y };
}

type Phase = 'landing' | 'exiting' | 'chat';

type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'gate'; content: typeof GATE_LABEL };
type ConversationHistory = { role: 'user' | 'assistant'; content: string };
type LoginReason = 'gate' | 'manual';





const ChatWindow = () => {
  const { accessToken, isAuthenticated } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>('landing');
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginReason, setLoginReason] = useState<LoginReason>('manual');
  const [freeChatUsed, setFreeChatUsed] = useState(hasUsedFreeChat);
  const [lyrX, setLyrX] = useState(LYR_DEFAULT_X);
  const [lyrY, setLyrY] = useState(LYR_DEFAULT_Y);
  const [parallaxY, setParallaxY] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  const conversationHistory = useRef<ConversationHistory[]>([]);
  const exitFallbackRef = useRef<number | null>(null);

  const showLanding = phase === 'landing' || phase === 'exiting';
  const showChat = phase === 'exiting' || phase === 'chat';
  const canSendWithoutAuth = !freeChatUsed;
  const submitLocked = !isAuthenticated && freeChatUsed;

  useEffect(() => {
    if (!showChat) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, showChat]);

  useEffect(() => {
    return () => {
      if (exitFallbackRef.current != null) {
        window.clearTimeout(exitFallbackRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const root = marqueeRef.current;
    if (!root) return;

    const syncDurations = () => {
      root.querySelectorAll<HTMLElement>('.question-marquee__row').forEach((row) => {
        const group = row.querySelector<HTMLElement>('.question-marquee__group');
        if (!group) return;
        row.style.animationDuration = `${group.offsetWidth / MARQUEE_PX_PER_SEC}s`;
      });
    };

    let cancelled = false;
    const syncIfMounted = () => {
      if (!cancelled) syncDurations();
    };

    syncIfMounted();
    const observer = new ResizeObserver(syncIfMounted);
    observer.observe(root);
    document.fonts?.ready.then(syncIfMounted);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [showLanding]);

  useEffect(() => {
    if (isAuthenticated && loginOpen) {
      setLoginOpen(false);
    }
  }, [isAuthenticated, loginOpen]);

  useEffect(() => {
    if (!submitLocked || !showChat) return;
    setMessages((prev) => {
      if (prev.some((msg) => msg.role === 'gate')) return prev;
      return [...prev, { role: 'gate', content: GATE_LABEL }];
    });
  }, [submitLocked, showChat]);

  useEffect(() => {
    const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
    let frame = 0;
    let nextY = 0;

    const applyParallax = () => {
      nextY = reducedMotion.matches ? 0 : window.scrollY * PARALLAX_FACTOR;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setParallaxY(Math.round(nextY * 10) / 10);
      });
    };

    const onReducedMotionChange = () => {
      applyParallax();
    };

    applyParallax();
    window.addEventListener('scroll', applyParallax, { passive: true });
    reducedMotion.addEventListener('change', onReducedMotionChange);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', applyParallax);
      reducedMotion.removeEventListener('change', onReducedMotionChange);
    };
  }, []);

  useEffect(() => {
    if (!LYR_MOUSE_TRACKING) return;

    const root = rootRef.current;
    if (!root) return;

    const finePointer = window.matchMedia(FINE_POINTER_QUERY);
    let frame = 0;
    let nextX = LYR_DEFAULT_X;
    let nextY = LYR_DEFAULT_Y;

    const applyLyr = (x: number, y: number) => {
      setLyrX(Math.round(x * 10) / 10);
      setLyrY(Math.round(y * 10) / 10);
    };

    const resetLyr = () => {
      nextX = LYR_DEFAULT_X;
      nextY = LYR_DEFAULT_Y;
      applyLyr(LYR_DEFAULT_X, LYR_DEFAULT_Y);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        resetLyr();
        return;
      }
      if (!finePointer.matches && event.pointerType !== 'mouse') return;

      const glass = nearestGlassRect(root, event.clientX, event.clientY);
      if (!glass) {
        resetLyr();
        return;
      }

      const { x, y } = lyrFromMouse(event.clientX, event.clientY, glass);
      nextX = x;
      nextY = y;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        applyLyr(nextX, nextY);
      });
    };

    const onPointerLeaveWindow = (event: MouseEvent) => {
      if (event.relatedTarget != null) return;
      resetLyr();
    };

    const onFinePointerChange = () => {
      if (!finePointer.matches) resetLyr();
    };

    applyLyr(LYR_DEFAULT_X, LYR_DEFAULT_Y);
    window.addEventListener('pointermove', onPointerMove);
    document.documentElement.addEventListener('mouseleave', onPointerLeaveWindow);
    finePointer.addEventListener('change', onFinePointerChange);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener(
        'mouseleave',
        onPointerLeaveWindow,
      );
      finePointer.removeEventListener('change', onFinePointerChange);
    };
  }, []);

  function openLogin(reason: LoginReason) {
    setLoginReason(reason);
    setLoginOpen(true);
  }

  function appendGateMessage() {
    setMessages((prev) => [...prev, { role: 'gate', content: GATE_LABEL }]);
  }

  function finishExit() {
    if (exitFallbackRef.current != null) {
      window.clearTimeout(exitFallbackRef.current);
      exitFallbackRef.current = null;
    }
    setPhase((current) => (current === 'exiting' ? 'chat' : current));
  }

  function beginExit() {
    if (phase !== 'landing') return;
    setPhase('exiting');
    exitFallbackRef.current = window.setTimeout(finishExit, EXIT_MS);
  }

  async function handleSend(text?: string) {
    const userText = (text ?? input).trim();
    if (!userText || loading || phase === 'exiting') return;

    if (!isAuthenticated && !canSendWithoutAuth) {
      if (phase === 'landing') {
        beginExit();
      }
      setInput('');
      appendGateMessage();
      return;
    }

    if (phase === 'landing') {
      beginExit();
    }

    setMessages((prev) => [...prev, { role: 'user', content: userText }]);
    setInput('');
    setLoading(true);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      const res = await fetch('/api/anthropic-route', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          userText,
          conversationHistory: conversationHistory.current,
        }),
      });

      if (res.status === 401) {
        let code = 'login_required';
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          // ignore parse errors
        }
        if (code === 'login_required') {
          markFreeChatUsed();
          setFreeChatUsed(true);
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: 'gate', content: GATE_LABEL },
          ]);
          return;
        }
        throw new Error(code);
      }

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText);
      }

      const data = await res.json();
      const answer = data.answer;
      

      const wasGuest = !isAuthenticated;
      if (wasGuest) {
        markFreeChatUsed();
        setFreeChatUsed(true);
      }

      conversationHistory.current.push({ role: 'user', content: userText });
      conversationHistory.current.push({ role: 'assistant', content: answer });
      const html = await marked.parse(answer);
      const sanitizedHtml = DOMPurify.sanitize(html);
      setMessages((prev) => {
        const next: Message[] = [
          ...prev,
          { role: 'assistant', content: sanitizedHtml },
        ];
        if (wasGuest) {
          next.push({ role: 'gate', content: GATE_LABEL });
        }
        return next;
      });
    } catch (err) {
      console.error(err);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: '<p>Something went wrong. Please try again.</p>',
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleAuthButton() {
    if (isAuthenticated) {
      await supabase.auth.signOut();
      return;
    }
    openLogin('manual');
  }

  return (
    <div
      ref={rootRef}
      className={`chat-window chat-window--${phase}`}
      style={
        {
          '--parallax-y': `${parallaxY}px`,
          '--lyr-x': `${lyrX}%`,
          '--lyr-y': `${lyrY}%`,
          '--lyr': `radial-gradient(55% 75% at ${lyrX}% ${lyrY}%, var(--white) 0%, rgba(255, 255, 255, 0) 100%)`,
        } as CSSProperties
      }
    >
      <div className="chat-window__backdrop" aria-hidden="true">
        <div className="chat-window__backdrop-image chat-window__backdrop-image--sharp" />
        <div className="chat-window__backdrop-image chat-window__backdrop-image--soft" />
        <div className="chat-window__backdrop-overlay" />
        <div className="chat-window__grid" />
      </div>

      <header className="chat-window__header">
        <a
          className="chat-window__brand"
          href={PORTSIDE_URL}
          target="_blank"
          rel="noreferrer"
        >
          Port Side
        </a>
        <button
          type="button"
          className="chat-window__login"
          onClick={handleAuthButton}
        >
          {isAuthenticated ? 'Log out' : 'Login'}
        </button>
      </header>

      <div className="chat-window__main">
        {showLanding && (
          <div
            className="chat-landing-page"
            aria-hidden={phase === 'exiting'}
            onAnimationEnd={(event) => {
              if (
                event.target === event.currentTarget &&
                event.animationName === 'landing-exit'
              ) {
                finishExit();
              }
            }}
          >
            <div className="chat-landing">
              <h1 className="chat-landing__headline">
                250 hours is a lot to listen to.
                <br />
                What if you could search all of it?
              </h1>
              <p className="chat-landing__subtitle">The Backcountry Marketing Podcast has become a library of conversations with some of the brightest minds in the outdoor industry. Instead of digging through hundreds of episodes, you can search the transcripts and find the ideas, advice, and conversations you need in seconds.</p>
              <div className="chat-landing__composer">
                <ChatInput
                  value={phase === 'landing' ? input : ''}
                  disabled={loading || phase !== 'landing'}
                  submitDisabled={submitLocked}
                  landing
                  onChange={setInput}
                  onSubmit={() => handleSend()}
                />
                <div
                  ref={marqueeRef}
                  className="question-marquee"
                  aria-label="Suggested questions"
                >
                  {SUGGESTION_ROWS.map((row, rowIndex) => (
                    <div key={rowIndex} className="question-marquee__row">
                      {[0, 1].map((copy) => (
                        <div
                          key={copy}
                          className="question-marquee__group"
                          aria-hidden={copy === 1}
                        >
                          {row.map((suggestion) => (
                            <button
                              key={`${copy}-${suggestion}`}
                              type="button"
                              className="chat-suggestion"
                              tabIndex={copy === 1 ? -1 : undefined}
                              onClick={() => handleSend(suggestion)}
                              disabled={
                                loading || phase !== 'landing' || submitLocked
                              }
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <section className="chat-support" aria-label="Support Port Side">
              <div className="chat-support__content">
                <div className="chat-support__heading">
                  <span className="chat-support__icon" aria-hidden="true">
                    !
                  </span>
                  <p className="chat-support__title">
                    Help us keep this thing going.
                  </p>
                </div>
                <div className="chat-support__body">
                  <p>
                    We&apos;ve bootstrapped this podcast from day one and
                    invested tens of thousands of dollars into producing it. Has
                    it paid off? Sure. But if you&apos;ve found value in the
                    show over the years, we&apos;d love your support in helping
                    us continue to make it.
                  </p>
                  <p>
                    This new search tool also costs us about six cents every
                    time someone uses it. So at the very least, we&apos;d ask
                    that you help cover the cost of your searches. Anything
                    beyond that helps us keep producing the podcast, having
                    better conversations, and building more useful resources
                    like this one.
                  </p>
                </div>
                <script type="text/javascript" src="https://cdnjs.buymeacoffee.com/1.0.0/button.prod.min.js" data-name="bmc-button" data-slug="coleheilborn" data-color="#f31b13" data-emoji="🔊"  data-font="Arial" data-text="Want To Support Us?" data-outline-color="#ffffff" data-font-color="#ffffff" data-coffee-color="#FFDD00" ></script>

              </div>
              <div className="chat-support__footer">
                <a href={PORTSIDE_URL} target="_blank" rel="noreferrer">
                  Return to Port side Productions
                </a>
                <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                  Privacy Policy
                </a>
              </div>
            </section>
          </div>
        )}

        {showChat && (
          <div className="chat-window__conversation">
            <div className="chat-window__panel">
              <div className="chat-window__body">
                {messages.map((msg, i) =>
                  msg.role === 'gate' ? (
                    <button
                      key={i}
                      type="button"
                      className="message message--gate"
                      onClick={() => openLogin('gate')}
                    >
                      <span>{msg.content}</span>
                      <img
                        src={loginArrow}
                        alt=""
                        aria-hidden="true"
                        className="message--gate__arrow"
                      />
                    </button>
                  ) : (
                    <div key={i} className={`message message--${msg.role}`}>
                      {msg.role === 'assistant'
                        ? parseHtml(msg.content)
                        : msg.content}
                          
                    </div>
                  ),
                )}
                {loading && (
                  <div
                    className="message message--thinking"
                    aria-live="polite"
                    aria-busy="true"
                  >
                    <span>Thinking</span>
                    <ThinkingSpinner />
                  </div>
                )}
                <div ref={bottomRef} className="chat-window__anchor" />
              </div>
            </div>
            <div className="chat-window__footer">
              <ChatInput
                value={input}
                disabled={loading}
                submitDisabled={submitLocked}
                landing
                onChange={setInput}
                onSubmit={() => handleSend()}
              />
            </div>
            <div className="chat-window__return-links">
              <a href={PORTSIDE_URL} target="_blank" rel="noreferrer">
                Return to Port side Productions
              </a>
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                Privacy Policy
              </a>
            </div>
          </div>
        )}
      </div>

      <LoginModal
        open={loginOpen}
        reason={loginReason}
        onClose={() => setLoginOpen(false)}
      />
    </div>
  );
};

type ChatInputProps = {
  value: string;
  disabled: boolean;
  submitDisabled?: boolean;
  landing?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

function ChatInput({
  value,
  disabled,
  submitDisabled = false,
  landing = false,
  onChange,
  onSubmit,
}: ChatInputProps) {
  const inputId = useId();
  const filled = value.trim().length > 0;

  return (
    <div
      className={`chat-input${filled ? ' chat-input--filled' : ''}${landing ? ' chat-input--landing' : ''}`}
    >
      {landing && (
        <div className="chat-input__glass" aria-hidden="true">
          
          <span className="chat-input__glass-stroke" />
          <span className="chat-input__glass-fill" />
          
        </div>
      )}
      <div className="chat-input__inner">
        <div className="chat-input__field">
          <label htmlFor={inputId} className="chat-input__label">
            Ask anything
          </label>
          <input
            id={inputId}
            type="text"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
        </div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || submitDisabled || !filled}
        >
          Submit
        </button>
      </div>
    </div>
  );
}

export default ChatWindow;
