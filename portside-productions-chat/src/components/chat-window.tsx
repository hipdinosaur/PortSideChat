import { useState, useEffect, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import parseHtml from 'html-react-parser';
import './chat-window.scss';

const ChatWindow = () => {
    const [messages, setMessages] = useState<{ role: 'user' | 'assistant', content: string }[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    type ConversationHistory = { 
        role: 'user' | 'assistant';
        content: string }
    const conversationHistory = useRef<ConversationHistory[]>([])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, loading]);

    async function handleSend() {
        const userText = input.trim();
        if (!userText) return;





        setMessages(prev => [...prev, { role: 'user', content: userText }]);
        setInput('');
        setLoading(true);
        const res = await fetch("/api/anthropic-route", {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userText: userText,
                conversationHistory: conversationHistory.current
            })
        })
        const data = await res.json();
        const answer = data.answer;
        
        conversationHistory.current.push({ role: 'user', content: userText });
        conversationHistory.current.push({ role: 'assistant', content: answer });
        const html = await marked.parse(answer);
        const sanitizedHtml = DOMPurify.sanitize(html);
        setMessages(prev => [...prev, { role: 'assistant', content: sanitizedHtml }]);
        setLoading(false);
    }

    return (
        <div className="chat-window">
            <div className="chat-window-header">
                <h1>Ask Portside Productions anything about outdoor marketing and branding</h1>
            </div>
            <div className="chat-window-body">
                {messages.map((msg, i) => (
                    <div key={i} className={`message ${msg.role}`}>      
                             {parseHtml(msg.content)}                     
                    </div>
                ))}
                {loading && <p className="loading">Thinking...</p>}
                <div ref={bottomRef} />
            </div>
            <div className="chat-input-container">
            <div className="chat-window-input">
                <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSend()}
                />
                <button onClick={handleSend}>Send</button>
            </div>
            </div>
        </div>
    );
}

export default ChatWindow;
