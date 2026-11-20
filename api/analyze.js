export const access = "public";
export const methods = ["POST"];

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function monthKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function aggregate(rows, key) {
  const out = {};
  for (const row of rows) {
    const label = String(row[key] ?? "Unknown");
    out[label] = (out[label] || 0) + number(row.revenue);
  }
  return Object.entries(out)
    .map(([name, revenue]) => ({ name, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue);
}

function buildSummary(rows) {
  const totalRevenue = rows.reduce((sum, row) => sum + number(row.revenue), 0);
  const byMonth = aggregate(rows.map(row => ({ ...row, month: monthKey(row.order_date) })), "month");
  const byProduct = aggregate(rows, "product_name");
  const bySegment = aggregate(rows, "customer_segment");
  const byRegion = aggregate(rows, "region");
  const months = byMonth.slice().sort((a, b) => new Date(a.name).getTime() - new Date(b.name).getTime());
  let change = null;
  if (months.length >= 2) {
    const previous = months[months.length - 2].revenue;
    const current = months[months.length - 1].revenue;
    change = previous ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
  }
  return {
    rowsAnalysed: rows.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalOrders: rows.length,
    averageOrderValue: rows.length ? Math.round((totalRevenue / rows.length) * 100) / 100 : 0,
    latestMonthChangePercent: change,
    monthlyRevenue: months,
    revenueByProduct: byProduct,
    revenueBySegment: bySegment,
    revenueByRegion: byRegion,
    sampleRows: rows.slice(0, 8).map(row => ({
      order_date: row.order_date,
      product_name: row.product_name,
      customer_segment: row.customer_segment,
      region: row.region,
      revenue: number(row.revenue)
    }))
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = req.body || {};
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const rows = Array.isArray(body.rows) ? body.rows : [];

  if (!question || question.length > 600) {
    return res.status(400).json({ error: "Enter a question of up to 600 characters." });
  }
  if (rows.length < 2 || rows.length > 1000) {
    return res.status(400).json({ error: "Upload a dataset containing between 2 and 1,000 rows." });
  }

  const required = ["order_date", "product_name", "customer_segment", "revenue"];
  const valid = rows.every(row => row && required.every(key => row[key] !== undefined));
  if (!valid) {
    return res.status(400).json({ error: "Dataset must include order_date, product_name, customer_segment and revenue columns." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Gemini is not configured yet. Add GEMINI_API_KEY in Vercel Project Settings → Environment Variables, then redeploy." });
  }

  const summary = buildSummary(rows);
  const system = [
    "You are InsightIQ, a careful product analytics copilot for Product Managers.",
    "Use only the supplied dataset summary. Never invent figures, causes, events, or business context.",
    "Separate verified observations from hypotheses. Correlation is not causation.",
    "If the dataset cannot answer the question, say what additional data is needed.",
    "Give a concise answer with: What the data shows, Evidence, What it might mean, and Recommended next step.",
    "Recommendations must be framed as investigations or experiments, not proven fixes.",
    "Use exact figures from the supplied summary. Do not claim to have analysed rows or fields that are not present."
  ].join("\n");

  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          role: "user",
          parts: [{ text: "PRODUCT MANAGER QUESTION:\n" + question + "\n\nVERIFIED DATA SUMMARY (JSON):\n" + JSON.stringify(summary) }]
        }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
      }),
      signal: AbortSignal.timeout(45000)
    });

    const result = await response.json();
    if (!response.ok) {
      console.error("Gemini API error:", result?.error?.message || response.status);
      return res.status(502).json({ error: "Gemini could not complete the analysis. Check the API key and try again." });
    }

    const answer = (result.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("\n")
      .trim();

    if (!answer) {
      return res.status(502).json({ error: "Gemini returned an empty answer. Please try a more focused question." });
    }

    return res.status(200).json({
      answer,
      evidence: {
        rowsAnalysed: summary.rowsAnalysed,
        totalRevenue: summary.totalRevenue,
        latestMonthChangePercent: summary.latestMonthChangePercent
      },
      model: "Gemini 2.5 Flash"
    });
  } catch (error) {
    console.error("InsightIQ analysis error:", error?.message || String(error));
    return res.status(502).json({ error: "AI analysis is temporarily unavailable. Please try again." });
  }
}
