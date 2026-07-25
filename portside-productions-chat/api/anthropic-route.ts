import Anthropic from "@anthropic-ai/sdk";

type ApiRequest = {
  method?: string;
  body: {
    userText?: string;
    conversationHistory?: Anthropic.MessageParam[];
  };
};

type ApiResponse = {
  status: (code: number) => {
    json: (body: unknown) => void;
  };
};

type MatchedChunk = {
  episode_name: string;
  podcast_index: number | null;
  guest_name: string | null;
  web_url: string;
  content: string;
  start_timestamp: string | null;
  end_timestamp: string | null;
  score: number;
};

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
        match_count: 8,
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
          : c.episode_name;
      const guest = c.guest_name ? `Guest: ${c.guest_name}` : "";
      const time =
        c.start_timestamp || c.end_timestamp
          ? `Timestamp: ${c.start_timestamp ?? "?"}–${c.end_timestamp ?? "?"}`
          : "";
      return [
        `--- Passage ${i + 1} (score ${c.score.toFixed(4)}) ---`,
        ep,
        guest,
        time,
        `URL: ${c.web_url}`,
        "",
        c.content,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
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

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const queryEmbedding = await embedQuery(userText);
    const chunks = await matchChunks(queryEmbedding, userText);
    const context = formatContext(chunks);

    const answerMsg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: `You are a strategic creative consultant focused on the outdoor industry. Answer questions using the podcast transcript passages provided. Along with answers, provide quotes from an applicable episode and its episode number. Do not provide any preamble or introduction to your capabilities.
Do not assume that users are familiar with the podcast. When introducing the podcast, use the name "Backcountry Marketing Podcast".
Avoid conversations that are off topic from marketing or the outdoor industry.
Avoid planning or strategizing; focus on providing insights and best practices.
Provide answers that are relevant to the question and the podcast transcript content.
Not all brands or products are directly related to the outdoor industry but engage an audience within that space; tailor answers assuming the audience is interested in the outdoor industry.
When citing, prefer episode name/number and guest when available, and you may mention the episode URL.
Answer in a friendly, engaging, and conversational tone; keep responses generally unformatted and free of markdown.`,
      messages: [
        ...conversationHistory,
        {
          role: "user",
          content: `Relevant podcast passages:\n\n${context}\n\nQuestion: ${userText}`,
        },
      ],
    });

    const answer =
      answerMsg.content.find((b) => b.type === "text")?.text ?? "";

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
