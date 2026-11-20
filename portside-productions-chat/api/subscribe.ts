const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 320;

type ApiRequest = {
  method?: string;
  body?: {
    email?: string;
  };
};

type ApiResponse = {
  setHeader: (name: string, value: string | string[]) => void;
  status: (code: number) => {
    json: (body: unknown) => void;
  };
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method && req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const email = req.body?.email?.trim() ?? "";
  if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: "Enter a valid email." });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res
      .status(500)
      .json({ error: "Missing server environment variables" });
  }

  let response: Response;
  try {
    response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/rpc/subscribe_email`,
      {
        method: "POST",
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_email: email }),
      }
    );
  } catch (err) {
    console.error("subscribe_email request failed:", err);
    return res.status(502).json({ error: "Could not subscribe. Try again." });
  }

  if (!response.ok) {
    console.error("subscribe_email failed:", response.status);
    return res.status(502).json({ error: "Could not subscribe. Try again." });
  }

  const accepted = (await response.json()) as boolean;
  if (accepted !== true) {
    return res.status(400).json({ error: "Enter a valid email." });
  }

  return res.status(200).json({ ok: true });
}
