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
  const masked =
    apiKey.length > 8 ? apiKey.slice(0, 4) + "..." + apiKey.slice(-4) : "***";
  console.log("OpenAI key (masked):", masked);
}
// --------------------------------------

function getCachedResult(input) {
  const cache = JSON.parse(localStorage.getItem("jironautCache") || "{}");
  return cache[input];
}

function setCachedResult(input, result) {
  const cache = JSON.parse(localStorage.getItem("jironautCache") || "{}");
  cache[input] = result;
  localStorage.setItem("jironautCache", JSON.stringify(cache));
}

function calculateBadgeAndTotal(scores) {
  const totalPoints = 100;
  let obtained = 0;
  for (let k in scores) {
    obtained += scores[k];
  }
  const total = Math.round((obtained / totalPoints) * 100);

  let badge = null;
  const benefit = (scores["Benefit Hypothesis"] || 0) + (scores["Strategic alignment"] || 0) + (scores["Leading Indicators"] || 0);
  const clarity = (scores["Title clarity"] || 0) + (scores["Description completeness"] || 0) + (scores["Scope clarity"] || 0);
  const riskDeps = (scores["Risk/Impact"] || 0) + (scores["Dependencies"] || 0);

  if (benefit >= 40) badge = "Visionary Thinker 🌟";
  if (total >= 85) badge = "Feature Architect 🧠";
  if (clarity >= 30) badge = "Clarity Champion 🥇";
  if (riskDeps >= 15) badge = "Risk Wrangler ⚖️";

  return { total, badge };
}

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const [isLoading, setIsLoading] = useState(false);

  async function chatWithRetry(
    payload,
    { retries = 3, baseDelayMs = 800 } = {}
  ) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await client.chat.completions.create(payload);
      } catch (err) {
        const msg = String(err?.message || "");
        // Do not retry if it's a quota/billing problem
        if (msg.includes("check your plan and billing")) {
          throw new Error(
            "OpenAI: quota/billing exceeded. Add billing to your account."
          );
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
      content:
        "You are Jironaut, a Jira co-pilot. You ONLY help with writing, scoring, and improving Jira tickets. You never answer unrelated questions. Always respond in a structured way: either as a draft Jira ticket or as a scoring report.",
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
      modePrompt =
        "Only Jira-related drafting and scoring tasks are supported.";
    }

    const newMessages = [
      systemMessage,
      ...messages.filter((m) => m.role !== "system"),
      { role: "user", content: `${modePrompt}\n\n${cleanedInput}` },
    ];
    setMessages(newMessages);
    setInput("");

    const cached = getCachedResult(cleanedInput);
    if (cached) {
      setMessages([...newMessages, { role: "assistant", content: cached }]);
      return;
    }

    setIsLoading(true);

    try {
      const response = await chatWithRetry({
        model: "gpt-4o-mini",
        messages: newMessages,
        response_format: { type: "json_object" },
        temperature: 0,
      });
      const aiMessage = response.choices[0].message.content;

      try {
        const parsed = JSON.parse(aiMessage);
        if (parsed.scores) {
          const { total, badge } = calculateBadgeAndTotal(parsed.scores);
          parsed.total = total;
          parsed.badge = badge;
          const finalMessage = JSON.stringify(parsed);
          setMessages([...newMessages, { role: "assistant", content: finalMessage }]);
          setCachedResult(cleanedInput, finalMessage);
          return;
        }
      } catch (e) {
        // fall back if not JSON
      }

      setMessages([...newMessages, { role: "assistant", content: aiMessage }]);
    } catch (err) {
      const humanMessage = String(err?.message || "").includes("billing")
        ? "⚠️ OpenAI says your quota is exceeded. Add a payment method or top up credits."
        : "⚠️ We’re sending requests too quickly. Please wait a moment and try again.";
      setMessages([
        ...newMessages,
        { role: "assistant", content: humanMessage },
      ]);
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        width: "100%",
        maxWidth: "1200px",
        margin: "0 auto",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#f7f7f8",
        padding: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          maxWidth: "1200px",
          height: "90vh",
          borderRadius: "12px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          backgroundColor: "#ffffff",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "1rem 1.5rem",
            borderBottom: "1px solid #eaeaea",
            fontWeight: "600",
            fontSize: "1.5rem",
            color: "#111",
            userSelect: "none",
          }}
        >
          Jiranaut
        </header>
        <main
          style={{
            flexGrow: 1,
            padding: "1rem 1.5rem",
            overflowY: "auto",
            backgroundColor: "#fefefe",
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          {messages
            .filter((m) => m.role !== "system")
            .map((msg, i) => {
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
                    <div
                      key={i}
                      style={{
                        alignSelf: "flex-start",
                        maxWidth: "80%",
                        backgroundColor: "#e5e5ea",
                        color: "#000",
                        padding: "0.75rem 1rem",
                        borderRadius: "18px 18px 18px 4px",
                        whiteSpace: "pre-wrap",
                        wordWrap: "break-word",
                        fontSize: "0.9rem",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                      }}
                    >
                      {parsed.total !== undefined && (
                        <div
                          style={{
                            color: scoreColor,
                            marginBottom: "0.5rem",
                            fontWeight: "600",
                          }}
                        >
                          <span role="img" aria-label="trophy">
                            🏆
                          </span>{" "}
                          Total Score: {parsed.total}%
                        </div>
                      )}
                      {parsed.badge !== undefined && (
                        <div
                          style={{ marginBottom: "0.5rem", fontWeight: "600" }}
                        >
                          <strong>Badge:</strong> {parsed.badge}
                        </div>
                      )}
                      <pre
                        style={{
                          margin: 0,
                          fontFamily: "inherit",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {JSON.stringify(parsed, null, 2)}
                      </pre>
                    </div>
                  );
                } catch {
                  return (
                    <div
                      key={i}
                      style={{
                        alignSelf: "flex-start",
                        maxWidth: "80%",
                        backgroundColor: "#e5e5ea",
                        color: "#000",
                        padding: "0.75rem 1rem",
                        borderRadius: "18px 18px 18px 4px",
                        whiteSpace: "pre-wrap",
                        wordWrap: "break-word",
                        fontSize: "0.9rem",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                      }}
                    >
                      {msg.content}
                    </div>
                  );
                }
              } else {
                return (
                  <div
                    key={i}
                    style={{
                      alignSelf: "flex-end",
                      maxWidth: "80%",
                      backgroundColor: "#4caf50",
                      color: "#fff",
                      padding: "0.75rem 1rem",
                      borderRadius: "18px 18px 4px 18px",
                      whiteSpace: "pre-wrap",
                      wordWrap: "break-word",
                      fontSize: "0.9rem",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                    }}
                  >
                    {msg.content}
                  </div>
                );
              }
            })}
        </main>
        <footer
          style={{
            borderTop: "1px solid #eaeaea",
            padding: "0.75rem 1rem",
            display: "flex",
            gap: "0.5rem",
            backgroundColor: "#fafafa",
          }}
        >
          <input
            type="text"
            placeholder="Type your message..."
            style={{
              flexGrow: 1,
              padding: "0.75rem 1rem",
              borderRadius: "20px",
              border: "1px solid #ccc",
              fontSize: "1rem",
              outline: "none",
              boxShadow: "inset 0 1px 3px rgba(0,0,0,0.1)",
            }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isLoading) sendMessage();
            }}
            disabled={isLoading}
          />
          <button
            onClick={sendMessage}
            disabled={isLoading}
            style={{
              backgroundColor: isLoading ? "#a5d6a7" : "#4caf50",
              color: "#fff",
              border: "none",
              borderRadius: "20px",
              padding: "0 1.5rem",
              cursor: isLoading ? "not-allowed" : "pointer",
              fontWeight: "600",
              fontSize: "1rem",
              boxShadow: "0 2px 6px rgba(76,175,80,0.5)",
              transition: "background-color 0.2s ease",
            }}
            aria-label="Send message"
          >
            {isLoading ? "Sending..." : "Send"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default App;
