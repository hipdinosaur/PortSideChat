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

type Message = { role: 'user' | 'assistant'; content: string };
type ConversationHistory = { role: 'user' | 'assistant'; content: string };

const ChatWindow = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const conversationHistory = useRef<ConversationHistory[]>([]);

  const isLanding = messages.length === 0 && !loading;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function handleSend(text?: string) {
    const userText = (text ?? input).trim();
    if (!userText || loading) return;

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
    <div className={`chat-window${isLanding ? ' chat-window--landing' : ''}`}>
      <div className="chat-window__main">
        {isLanding ? (
          <div className="chat-landing">
            <h1 className="chat-landing__headline">
              Learn the fundamentals of marketing for the outdoor industries
            </h1>
            <div className="chat-landing__composer">
              <ChatInput
                value={input}
                disabled={loading}
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
                    disabled={loading}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
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
              <div className="chat-window__scrim" aria-hidden="true" />
            </div>
            <div className="chat-window__footer">
              <ChatInput
                value={input}
                disabled={loading}
                onChange={setInput}
                onSubmit={() => handleSend()}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

type ChatInputProps = {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

function ChatInput({ value, disabled, onChange, onSubmit }: ChatInputProps) {
  const inputId = useId();
  const filled = value.trim().length > 0;

  return (
    <div className={`chat-input${filled ? ' chat-input--filled' : ''}`}>
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
  );
}

export default ChatWindow;
