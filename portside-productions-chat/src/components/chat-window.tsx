import { useState, useEffect, useRef, useId } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import parseHtml from 'html-react-parser';
import ThinkingSpinner from './thinking-spinner';
import './chat-window.scss';

const SUGGESTIONS = [
  "What's unique about marketing for the outdoor industry?",
  'How do I build an audience for my outdoor brand?',
] as const;

const PORTSIDE_URL = 'https://www.portsidepro.com';
/** Keep in sync with `$transition-exit` in chat-window.scss */
const EXIT_MS = 700;

type Phase = 'landing' | 'exiting' | 'chat';
type Message = { role: 'user' | 'assistant'; content: string };
type ConversationHistory = { role: 'user' | 'assistant'; content: string };

const ChatWindow = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>('landing');
  const bottomRef = useRef<HTMLDivElement>(null);
  const conversationHistory = useRef<ConversationHistory[]>([]);
  const exitFallbackRef = useRef<number | null>(null);

  const showLanding = phase === 'landing' || phase === 'exiting';
  const showChat = phase === 'exiting' || phase === 'chat';

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

    if (phase === 'landing') {
      beginExit();
    }

    setMessages((prev) => [...prev, { role: 'user', content: userText }]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/anthropic-route', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userText,
          conversationHistory: conversationHistory.current,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText);
      }

      const data = await res.json();
      const answer = data.answer;

      conversationHistory.current.push({ role: 'user', content: userText });
      conversationHistory.current.push({ role: 'assistant', content: answer });
      const html = await marked.parse(answer);
      const sanitizedHtml = DOMPurify.sanitize(html);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: sanitizedHtml },
      ]);
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

  return (
    <div className={`chat-window chat-window--${phase}`}>
      <div className="chat-window__backdrop" aria-hidden="true">
        <div className="chat-window__backdrop-image chat-window__backdrop-image--sharp" />
        <div className="chat-window__backdrop-image chat-window__backdrop-image--soft" />
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
        <button type="button" className="chat-window__login">
          Login
        </button>
      </header>

      <div className="chat-window__main">
        {showLanding && (
          <div
            className="chat-landing"
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
            <h1 className="chat-landing__headline">
              Learn the fundamentals of marketing for the outdoor industries
            </h1>
            <div className="chat-landing__composer">
              <ChatInput
                value={phase === 'landing' ? input : ''}
                disabled={loading || phase !== 'landing'}
                landing
                onChange={setInput}
                onSubmit={() => handleSend()}
              />
              <div className="chat-landing__suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="chat-suggestion"
                    onClick={() => handleSend(suggestion)}
                    disabled={loading || phase !== 'landing'}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {showChat && (
          <div className="chat-window__conversation">
            <div className="chat-window__panel">
              <div className="chat-window__body">
                {messages.map((msg, i) => (
                  <div key={i} className={`message message--${msg.role}`}>
                    {msg.role === 'assistant'
                      ? parseHtml(msg.content)
                      : msg.content}
                  </div>
                ))}
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
                onChange={setInput}
                onSubmit={() => handleSend()}
              />
            </div>
          </div>
        )}
      </div>

      <a
        className="chat-window__return"
        href={PORTSIDE_URL}
        target="_blank"
        rel="noreferrer"
      >
        Return to Port side Productions
      </a>
    </div>
  );
};

type ChatInputProps = {
  value: string;
  disabled: boolean;
  landing?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

function ChatInput({
  value,
  disabled,
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
          disabled={disabled || !filled}
        >
          Submit
        </button>
      </div>
    </div>
  );
}

export default ChatWindow;
