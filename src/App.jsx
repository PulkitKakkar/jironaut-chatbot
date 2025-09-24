import { useState } from "react";
import OpenAI from "openai";

// ---- OpenAI client (module scope) ----
const getApiKey = () => {
  const fromEnv = import.meta.env.VITE_OPENAI_API_KEY;
  if (fromEnv && typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const fromStorage = localStorage.getItem("OPENAI_API_KEY");
  if (fromStorage && fromStorage.trim().length > 0) {
    return fromStorage.trim();
  }
  return null;
};

let apiKey = getApiKey();
if (!apiKey) {
  const entered = window.prompt(
    "Enter your OpenAI API Key (will be saved to localStorage for dev only):"
  );
  if (entered && entered.trim().length > 0) {
    localStorage.setItem("OPENAI_API_KEY", entered.trim());
    apiKey = entered.trim();
  }
}
if (!apiKey) {
  console.error(
    "OpenAI API key not found. Add VITE_OPENAI_API_KEY in .env.local or store OPENAI_API_KEY in localStorage."
  );
}

export const client = new OpenAI({
  apiKey: apiKey || "",
  dangerouslyAllowBrowser: true, // dev only; use a backend in production
});

// Log masked key once (module scope avoids repeated logs on re-render)
if (apiKey) {
  const masked = apiKey.length > 8 ? apiKey.slice(0, 4) + "..." + apiKey.slice(-4) : "***";
  console.log("OpenAI key (masked):", masked);
}
// --------------------------------------

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const [isLoading, setIsLoading] = useState(false);

  async function chatWithRetry(payload, { retries = 3, baseDelayMs = 800 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await client.chat.completions.create(payload);
      } catch (err) {
        const msg = String(err?.message || "");
        // Do not retry if it's a quota/billing problem
        if (msg.includes("check your plan and billing")) {
          throw new Error("OpenAI: quota/billing exceeded. Add billing to your account.");
        }
        // Retry only on HTTP 429 Too Many Requests
        if (err?.status === 429 && attempt < retries) {
          const delay = baseDelayMs * Math.pow(2, attempt); // exponential backoff
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    let systemMessage = {
      role: "system",
      content: "You are Jironaut, a Jira co-pilot. You ONLY help with writing, scoring, and improving Jira tickets. You never answer unrelated questions. Always respond in a structured way: either as a draft Jira ticket or as a scoring report."
    };

    let modePrompt = "";
    let cleanedInput = input.trim();

    if (cleanedInput.toLowerCase().startsWith("draft:")) {
      modePrompt = `Draft a Jira ticket from the following brief. 
Return JSON with:
- title (≤80 chars, action + context)
- description_markdown (with sections: Why, What, Constraints)
- acceptance_criteria (4–8 Gherkin-style items)
- labels (≤5, kebab-case)
Rules:
- If details are missing, add a "Questions" section at the end.
- Include risk_notes, qa_checks, and assumptions if relevant.
- Keep tone clear, concise, and Jira-ready.
`;
      cleanedInput = cleanedInput.slice(6).trim();
    } else if (cleanedInput.toLowerCase().startsWith("score:")) {
      systemMessage.content += `
You are Jironaut, a Jira ticket reviewer. 
Score tickets against 8 criteria (total 100 points):
- Title clarity (10), Description completeness (15), Benefit Hypothesis (20), Leading Indicators (15),
  Strategic alignment (10), Risk/Impact (10), Dependencies (10), Scope clarity (10).
Return JSON with: individual scores, total %, one badge, one positive note, one area to improve, 
and ask if user wants rewrite.
Badges:
- Visionary Thinker 🌟: Benefit+Alignment+Indicators ≥ 40/45
- Feature Architect 🧠: Total ≥ 85%
- Clarity Champion 🥇: Title+Description+Scope ≥ 30/35
- Risk Wrangler ⚖️: Risk+Dependencies ≥ 15/20
`;
      modePrompt = "Evaluate the following Jira ticket:";
      cleanedInput = cleanedInput.slice(6).trim();
    } else {
      modePrompt = "Only Jira-related drafting and scoring tasks are supported.";
    }

    const newMessages = [systemMessage, ...messages.filter(m => m.role !== "system"), { role: "user", content: `${modePrompt}\n\n${cleanedInput}` }];
    setMessages(newMessages);
    setInput("");

    setIsLoading(true);

    try {
      const response = await chatWithRetry({
        model: "gpt-4o-mini",
        messages: newMessages,
        response_format: { type: "json_object" },
      });
      const aiMessage = response.choices[0].message.content;
      setMessages([...newMessages, { role: "assistant", content: aiMessage }]);
    } catch (err) {
      const humanMessage =
        String(err?.message || "").includes("billing")
          ? "⚠️ OpenAI says your quota is exceeded. Add a payment method or top up credits."
          : "⚠️ We’re sending requests too quickly. Please wait a moment and try again.";
      setMessages([...newMessages, { role: "assistant", content: humanMessage }]);
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ padding: "2rem", maxWidth: "600px", margin: "auto" }}>
      <h1>Jiranaut</h1>
      <div
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          height: "400px",
          overflowY: "auto",
          marginBottom: "1rem",
        }}
      >
        {messages.filter(m => m.role !== "system").map((msg, i) => {
          if (msg.role === "assistant") {
            try {
              const parsed = JSON.parse(msg.content);
              let scoreColor = "red";
              if (parsed.total !== undefined) {
                if (parsed.total >= 85) {
                  scoreColor = "green";
                } else if (parsed.total >= 70) {
                  scoreColor = "orange";
                }
              }
              return (
                <div key={i} style={{ whiteSpace: "pre-wrap", wordWrap: "break-word" }}>
                  {parsed.total !== undefined && (
                    <div style={{ color: scoreColor }}><strong>🏆 Total Score:</strong> {parsed.total}%</div>
                  )}
                  {parsed.badge !== undefined && (
                    <div><strong>Badge:</strong> {parsed.badge}</div>
                  )}
                  <pre>{JSON.stringify(parsed, null, 2)}</pre>
                </div>
              );
            } catch {
              return (
                <p key={i}>
                  <b>AI:</b> {msg.content}
                </p>
              );
            }
          } else {
            return (
              <p key={i}>
                <b>You:</b> {msg.content}
              </p>
            );
          }
        })}
      </div>
      <input
        style={{ width: "80%", padding: "0.5rem" }}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isLoading) sendMessage();
        }}
        disabled={isLoading}
      />
      <button
        style={{ padding: "0.5rem", marginLeft: "0.5rem" }}
        onClick={sendMessage}
        disabled={isLoading}
      >
        {isLoading ? "Sending..." : "Send"}
      </button>
    </div>
  );
}

export default App;
