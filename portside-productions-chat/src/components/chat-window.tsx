import { useState, useEffect, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import parseHtml from 'html-react-parser';
import transcriptIndex from '../assets/transcript_index.json';
import Anthropic from "@anthropic-ai/sdk";
import './chat-window.scss';

const ChatWindow = () => {
    const [messages, setMessages] = useState<{ role: 'user' | 'assistant', content: string }[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const conversationHistory = useRef<Anthropic.MessageParam[]>([])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, loading]);

    async function handleSend() {
        const userText = input.trim();
        if (!userText) return;

        setMessages(prev => [...prev, { role: 'user', content: userText }]);
        setInput('');
        setLoading(true);

        const anthropic = new Anthropic({
            dangerouslyAllowBrowser: true,
            apiKey:  process.env.VITE_ANTHROPIC_API_KEY,
            baseURL: `https://ai-gateway.vercel.sh`,
            defaultHeaders: {
                'anthropic-beta': 'files-api-2025-04-14',
            },
        });

        // STEP 1: Find the most relevant transcripts
        const selectionMsg = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 300,
            system: `You are a search assistant. Given a question and a podcast episode index, return ONLY a JSON array of the 1-3 file_id strings. Return nothing else, no explanation, no markdown, no code blocks. Example:[\"file_011Ca6Y5wP1LCrbrZMbXVcg4', \"file_011Ca4f6SfhAYFKMbs6cMxJG\"].`,
            messages: [
                {
                    role: "user",
                    content: `Question: ${userText}\n\nIndex: ${JSON.stringify(transcriptIndex)}`,
                }
            ],
        });

        const selectionText = selectionMsg.content.find((b) => b.type === "text")?.text ?? "[]";
        const match = selectionText.match(/\[.*?\]/s); // fallback if response isn't clean JSON
        const selectedFileIDs: string[] = JSON.parse(match ? match[0] : "[]");

        // STEP 2: Answer using transcript contents
        const answerMsg = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1800,
            system: `You are a strategic creative professional focused on the outdoor industry. Answer questions using the podcast transcript content provided. Along with answers, provide quotes from an applicable episode along and its espisode number. Do not provide any preamble or introduction to your capilities
            Avoid conversations that are off topic from marketing or the outdoor industry.
            If initial question is too vague or unclear, ask clarifying questions to help understand the user's goals and objectives.
            Provide answers that are relevant to the question and the podcast transcript content.
            When asked provide ideas and concepts that are relevant to the question and the podcast transcript content.
            Not all brands or products are directly related to the outdoor industry but engage an audience within that space, tailor answers assuming the audience is interested in the outdoor industry.`,
            messages: [
                ...conversationHistory.current,
                {
                    role: "user",
                    content: [
                        ...selectedFileIDs.map((fileId) => ({
                            type: 'document',
                            source: { type: 'file', file_id: fileId },
                        })),
                        {
                            type: 'text',
                            text: `Question: ${userText}`,
                        }
                    ] as Anthropic.MessageParam['content'],
                }
            ],
        });

        const answer = answerMsg.content.find((b) => b.type === "text")?.text ?? "";
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
