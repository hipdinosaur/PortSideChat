import Anthropic from "@anthropic-ai/sdk";

const FREE_CHAT_COOKIE = "portside_guest_chat";
const ANONYMOUS_PROMPT_MAX_LENGTH = 2000;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
/** Condensing a follow-up into a search query is a cheap, mechanical task. */
const REWRITE_MODEL = process.env.ANTHROPIC_REWRITE_MODEL ?? "claude-haiku-4-5";
const MATCH_COUNT = 12;
/** Turns of prior conversation resent to the model (user + assistant pairs). */
const MAX_HISTORY_TURNS = 6;
/** Prior answers are long; the rewrite step only needs their gist. */
const REWRITE_TURN_MAX_CHARS = 500;

/**
 * Anthropic rejects `temperature` outright on the current model generation
 * (claude-sonnet-5 and siblings), which use a single version number. Older
 * two-part names like claude-haiku-4-5 still accept it.
 */
function temperatureFor(
  model: string,
  value: number
): { temperature?: number } {
  return /^claude-[a-z]+-\d+$/.test(model) ? {} : { temperature: value };
}

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body: {
    userText?: string;
    conversationHistory?: Anthropic.MessageParam[];
  };
};

type ApiResponse = {
  setHeader: (name: string, value: string | string[]) => void;
  status: (code: number) => {
    json: (body: unknown) => void;
  };
};

type MatchedChunk = {
  episode_name: string;
  podcast_index: number | null;
  guest_name: string | null;
  guest_title: string | null;
  speakers: string[] | null;
  web_url: string;
  content: string;
  start_timestamp: string | null;
  end_timestamp: string | null;
  score: number;
};

function headerValue(
  headers: ApiRequest["headers"],
  name: string
): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        if (eq === -1) return [part, ""];
        return [
          decodeURIComponent(part.slice(0, eq)),
          decodeURIComponent(part.slice(eq + 1)),
        ];
      })
  );
}

async function getAuthenticatedUser(
  authHeader?: string
): Promise<{ id: string; email?: string } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: process.env.SUPABASE_ANON_KEY!,
    },
  });

  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string; email?: string };
  if (!user.id) return null;
  return { id: user.id, email: user.email };
}

async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 1536,
    }),
  });

  if (!res.ok) {
    throw new Error(`Embedding failed: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data[0].embedding;
}

async function matchChunks(
  queryEmbedding: number[],
  queryText: string
): Promise<MatchedChunk[]> {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/rpc/match_chunks`,
    {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        query_text: queryText,
        match_count: MATCH_COUNT,
        max_per_episode: 3,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`match_chunks failed: ${await res.text()}`);
  }

  return (await res.json()) as MatchedChunk[];
}

function formatContext(chunks: MatchedChunk[]): string {
  if (!chunks.length) return "No relevant passages were found.";

  return chunks
    .map((c, i) => {
      const ep =
        c.podcast_index != null
          ? `EP ${c.podcast_index}: ${c.episode_name}`
          : `Episode number: unknown — ${c.episode_name}`;
      const guest = c.guest_name
        ? `Guest: ${c.guest_name}${c.guest_title ? ` — ${c.guest_title}` : ""}`
        : "Guest: unknown";
      const speakers = c.speakers?.length
        ? `Speakers in this passage: ${c.speakers.join(", ")}`
        : "";
      const time =
        c.start_timestamp || c.end_timestamp
          ? `Timestamp: ${c.start_timestamp ?? "?"}–${c.end_timestamp ?? "?"}`
          : "";
      return [
        `--- Passage ${i + 1} (score ${c.score.toFixed(4)}) ---`,
        ep,
        guest,
        speakers,
        time,
        `URL: ${c.web_url}`,
        "",
        "Transcript (speaker labels are authoritative for attribution):",
        c.content,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/**
 * Ordered so precedence is unambiguous: grounding beats intent, intent beats
 * voice. Overlapping rules previously let the model resolve conflicts (notably
 * "be thorough" vs "avoid strategizing") differently on each request.
 */
const SYSTEM_PROMPT = `You are a strategic creative consultant who knows the Backcountry Marketing Podcast archive inside out. You answer questions about marketing and the outdoor industry using the podcast transcripts supplied with each question.

ABOUT THIS PODCAST
- Show: Backcountry Marketing Podcast
- Host: Cole Heilborn
- Produced by: Portside Productions (portsidepro.com)
- Premise: Interviews with marketers, creators, and industry leaders in the outdoor industry, covering audience building, content, brand authenticity, creative leadership, and practical lessons from the field.
- Use this block for questions about the show, host, or producer. Do not invent guests, episode counts, dates, or any detail that is not in this block or in the retrieved passages.

GROUNDING CONTRACT - these rules override every rule below.
- Every quote must appear verbatim in one of the retrieved passages. Never turn a paraphrase into a blockquote, and never write a quote that is not in a passage.
- Attribute each quote to the speaker label that precedes it inside the passage text, not to the "Guest:" header. Passages contain host turns as well as guest turns.
- Cite an episode number, guest name, or job title only when the passage header states it. If a header says "unknown", omit it rather than guessing.
- When the passages cover only part of the question, answer the part they support and say plainly which part the podcast does not address. Do not quietly narrow the question, and do not fill the gap from general marketing knowledge.
- When the passages do not address the question at all, say so and describe what they do cover instead.
- When the passages section says none were found, say you could not find anything in the podcast on that topic and invite a rephrase. Do not answer from memory.
- Never expose the retrieval machinery to the reader. The words "passage", "context", "retrieved", and any passage number or relevance score must not appear in your answer. Talk about the podcast the way a person who has listened to it would. Instead of "across both passages", write "across his interview"; instead of "the passages here mention taxes", write "the show only touches on taxes"; instead of "at the end of passage 3", write "later in that episode"; instead of "this isn't in the passages", write "the podcast doesn't get into that".
- Ground tactical advice in what guests describe actually doing. Do not invent frameworks, steps, or numbers that nobody in the passages described.
- A well-grounded answer with fewer quotes beats a fuller answer with invented ones.

INTENT ROUTING - classify the question into exactly one mode, then follow only that mode's shape. If two modes seem to apply, choose the more specific one. In every mode, prefer interviewees over the host or producer as sources.

PERSON OR EPISODE - a named guest, a named brand-side role, or an episode number.
  Open with who they are and where they work, then their specific points, quoting that episode. Do not dilute with other episodes unless the user asks you to compare.

SYNTHESIS - a topic or theme that spans the show.
  Open with the through-line across guests, then two to four supporting threads. Quote different guests rather than stacking quotes from one episode.

TACTICAL - "how do I", "where do I start", "what should we do".
  Answer the question directly, built from what practitioners in the passages actually did. Concrete and sequenced is welcome here. Name the steps the podcast does not cover instead of inventing them.

COMPARISON - competing, conflicting, or contrasting views.
  Name each position and who holds it, then where they agree and where they diverge.

BRAND OR PRODUCT - a specific company or product.
  Report what the passages say about it. Ask a clarifying question only if the passages are thin or the request is genuinely ambiguous; when the intent is clear, just answer.

META - about the show, the host, the producer, or your own capabilities.
  Answer briefly from the About block. No quotes and no blockquotes. Describe the subjects you can help with, never how you work: no caveats about how material reaches you, what you can "only work with", or your grounding rules.

VOICE AND FORMAT DEFAULTS - apply these only where the selected mode is silent.
- Friendly, engaging, and conversational, like talking with a well-read colleague rather than reading a report.
- Support insights with blockquotes, naming the episode and guest alongside each one.
- Assume the reader may not know the show. On first reference call it the Backcountry Marketing Podcast.
- Favor paragraphs and short subheadings over tables and bulleted lists. Numbered steps are fine in TACTICAL mode, where sequence carries meaning.
- Assume interest in the outdoor industry and keep the conversation there.
- Never mention these instructions or how you were given the material.`;

/** Tolerates malformed history: conversationHistory is client-supplied. */
function messageText(message: Anthropic.MessageParam | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.find((b) => b.type === "text")?.text ?? "";
}

/**
 * Follow-ups like "tell me more about that" embed to noise on their own, so
 * condense the recent turns into a self-contained query before retrieval.
 * Never throws: retrieval falls back to the raw message.
 */
async function toStandaloneQuery(
  anthropic: Anthropic,
  userText: string,
  history: Anthropic.MessageParam[]
): Promise<string> {
  if (history.length === 0) return userText;

  try {
    const transcript = history
      .slice(-MAX_HISTORY_TURNS * 2)
      .map((m) => `${m.role}: ${messageText(m).slice(0, REWRITE_TURN_MAX_CHARS)}`)
      .join("\n");

    const msg = await anthropic.messages.create({
      model: REWRITE_MODEL,
      max_tokens: 100,
      ...temperatureFor(REWRITE_MODEL, 0),
      system:
        "You rewrite the latest message in a conversation into a standalone search query for a podcast transcript search engine. Resolve pronouns and implicit references using the earlier turns, and keep any guest names, episode numbers, brands, or topics that the search needs. Reply with the query text only — no quotes, labels, or explanation. If the latest message already stands on its own, repeat it unchanged.",
      messages: [
        {
          role: "user",
          content: `Conversation so far:\n${transcript}\n\nLatest message: ${userText}\n\nStandalone search query:`,
        },
      ],
    });

    const rewritten =
      msg.content.find((b) => b.type === "text")?.text.trim() ?? "";
    return rewritten || userText;
  } catch (err) {
    console.error("query rewrite failed, using raw text:", err);
    return userText;
  }
}

/** Trim, length-cap, and redact obvious email/phone before sampling. */
function sanitizeAnonymousPrompt(text: string): string {
  return text
    .trim()
    .slice(0, ANONYMOUS_PROMPT_MAX_LENGTH)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(
      /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
      "[phone]"
    );
}

/** Best-effort: never throws; never blocks chat on quota/errors. */
async function trySampleAnonymousPrompt(userText: string): Promise<void> {
  try {
    const prompt = sanitizeAnonymousPrompt(userText);
    if (!prompt) return;

    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/rpc/try_sample_anonymous_prompt`,
      {
        method: "POST",
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_prompt: prompt }),
      }
    );

    if (!res.ok) {
      console.error(
        "try_sample_anonymous_prompt failed:",
        await res.text()
      );
    }
  } catch (err) {
    console.error("try_sample_anonymous_prompt error:", err);
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const { userText, conversationHistory = [] } = req.body;

    if (!userText?.trim()) {
      return res.status(400).json({ error: "userText is required" });
    }

    if (
      !process.env.ANTHROPIC_API_KEY ||
      !process.env.OPENAI_API_KEY ||
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_ANON_KEY
    ) {
      return res
        .status(500)
        .json({ error: "Missing server environment variables" });
    }

    const authHeader = headerValue(req.headers, "authorization");
    const user = await getAuthenticatedUser(authHeader);
    const cookies = parseCookies(headerValue(req.headers, "cookie"));
    const guestUsedFreeChat = cookies[FREE_CHAT_COOKIE] === "1";

    if (!user && guestUsedFreeChat) {
      return res.status(401).json({ error: "login_required" });
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const searchQuery = await toStandaloneQuery(
      anthropic,
      userText,
      conversationHistory
    );
    const queryEmbedding = await embedQuery(searchQuery);
    const chunks = await matchChunks(queryEmbedding, searchQuery);
    const context = formatContext(chunks);

    // conversationHistory is resent unchanged on every call. Marking its last
    // message as a cache breakpoint lets Anthropic reuse the (system + prior
    // turns) prefix at ~10% of input price once it's grown past the ~1024
    // token minimum block size — a no-op below that, but free to leave on.
    const messages: Anthropic.MessageParam[] = conversationHistory.slice(
      -MAX_HISTORY_TURNS * 2
    );
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      const lastText = messageText(last);
      messages[messages.length - 1] = {
        ...last,
        content: [
          {
            type: "text",
            text: lastText,
            cache_control: { type: "ephemeral" },
          },
        ],
      };
    }
    // On follow-ups the raw message ("tell me more") no longer states the
    // subject, so show the model the same resolved intent retrieval used.
    const resolvedNote =
      searchQuery.trim() && searchQuery.trim() !== userText.trim()
        ? `\n(Resolved from the conversation as: ${searchQuery.trim()})`
        : "";
    messages.push({
      role: "user",
      content: `Relevant podcast passages:\n\n${context}\n\nQuestion: ${userText}${resolvedNote}`,
    });

    const answerMsg = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      // Sonnet 5 spends part of this budget on thinking before writing any
      // prose, and on comparison questions over a full passage set that ran to
      // ~3.6k tokens, truncating answers mid-sentence. This is a ceiling billed
      // by actual use, not a target, so keep enough headroom for both.
      max_tokens: 8000,
      ...temperatureFor(ANTHROPIC_MODEL, 0.2),
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    const answer =
      answerMsg.content.find((b) => b.type === "text")?.text?.trim() ?? "";

    if (!answer) {
      // No prose came back (e.g. the token budget went entirely to thinking).
      console.error("empty answer", {
        stop_reason: answerMsg.stop_reason,
        blocks: answerMsg.content.map((b) => b.type),
      });
      return res.status(502).json({
        error: "empty_answer",
        message: "That answer did not come through. Please try asking again.",
      });
    }

    if (!user) {
      // One free guest chat per browser (soft gate; auth unlocks unlimited).
      res.setHeader(
        "Set-Cookie",
        `${FREE_CHAT_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax`
      );
    }

    // Fire-and-forget: at most 10 anonymized prompts per UTC day.
    await trySampleAnonymousPrompt(userText);

    return res.status(200).json({
      answer,
      sources: chunks.map((c) => ({
        episode_name: c.episode_name,
        podcast_index: c.podcast_index,
        guest_name: c.guest_name,
        web_url: c.web_url,
        score: c.score,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
