import Anthropic from "@anthropic-ai/sdk";
import transcriptIndex from "../src/assets/transcript_index.json";

type ApiRequest = {
  method?:string;
  body: {
    userText?:string;
    conversationHistory?:Anthropic.MessageParam[];
  };
};

type ApiResponse = {
  status: (code: number) => {
      json: (body: unknown) => void;
  };
};



export default async function handler(req: ApiRequest, res: ApiResponse) {
    const { userText, conversationHistory = []} = req.body;

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: `https://api.anthropic.com`,
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
            ...conversationHistory,
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
    return res.status(200).json({ answer: answerMsg.content.find((b) => b.type === "text")?.text ?? "" });

  
  }