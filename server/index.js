import dotenv from "dotenv";
import express from "express";
import { Pool } from "pg";
import multer from "multer";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

dotenv.config();

const app = express();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "o4-mini";
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
const LOCAL_EMBEDDINGS = String(process.env.LOCAL_EMBEDDINGS || "").toLowerCase() === "true";
const LOCAL_EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || "Xenova/paraphrase-MiniLM-L3-v2";
const EMBED_DIM = Number.parseInt(
  process.env.EMBED_DIM || (LOCAL_EMBEDDINGS ? "384" : process.env.OPENAI_EMBED_DIM || "1536"),
  10
);
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MINERU_CMD = process.env.MINERU_CMD || "mineru";
const MINERU_TIMEOUT_MS = Number.parseInt(process.env.MINERU_TIMEOUT_MS || "180000", 10);

const uploadDir = path.join(os.tmpdir(), "rag-playground-uploads");
mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 }
});

let localEmbedderPromise = null;

if (!OPENAI_API_KEY) {
  console.warn("Missing OPENAI_API_KEY in environment.");
}

if (!Number.isInteger(EMBED_DIM) || EMBED_DIM <= 0) {
  throw new Error("EMBED_DIM must be a positive integer.");
}

if (!DATABASE_URL) {
  console.warn("Missing DATABASE_URL in environment.");
}

const pool = new Pool({ connectionString: DATABASE_URL });

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function chunkText(text, chunkSize = 1000, overlap = 200) {
  const chunks = [];
  const step = Math.max(1, chunkSize - overlap);
  for (let i = 0; i < text.length; i += step) {
    const chunk = text.slice(i, i + chunkSize).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

function parseChunkSize(value, fallback = 1000) {
  const raw = Number.parseInt(value || String(fallback), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, 200), 4000);
}

function toPgVector(values) {
  return `[${values.join(",")}]`;
}

async function findFirstFile(dir, extensions) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFirstFile(entryPath, extensions);
      if (found) return found;
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) {
        return entryPath;
      }
    }
  }
  return null;
}

async function runMineru(pdfPath) {
  const outputDir = path.join(
    os.tmpdir(),
    `rag-playground-mineru-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  await fs.mkdir(outputDir, { recursive: true });

  const args = ["-p", pdfPath, "-o", outputDir];
  const proc = spawn(MINERU_CMD, args, { shell: true });

  let stderr = "";

  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("MinerU timed out."));
    }, MINERU_TIMEOUT_MS);

    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`MinerU failed with code ${code}. ${stderr}`));
      } else {
        resolve();
      }
    });
  });

  const textFile = await findFirstFile(outputDir, [".md", ".markdown", ".txt"]);
  if (!textFile) {
    await fs.rm(outputDir, { recursive: true, force: true });
    throw new Error("MinerU did not produce a text output.");
  }

  const text = await fs.readFile(textFile, "utf8");
  await fs.rm(outputDir, { recursive: true, force: true });
  return text;
}

async function embedTexts(texts) {
  if (LOCAL_EMBEDDINGS) {
    const embedder = await getLocalEmbedder();
    const results = [];
    for (const text of texts) {
      const output = await embedder(text, { pooling: "mean", normalize: true });
      results.push(Array.from(output.data));
    }
    return results;
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_EMBED_MODEL,
      input: texts,
      dimensions: EMBED_DIM
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Embeddings error: ${response.status} ${JSON.stringify(data)}`);
  }

  return data.data.map((item) => item.embedding);
}

async function getLocalEmbedder() {
  if (!localEmbedderPromise) {
    localEmbedderPromise = import("@xenova/transformers").then(({ pipeline }) =>
      pipeline("feature-extraction", LOCAL_EMBED_MODEL)
    );
  }
  return localEmbedderPromise;
}

async function chatAnswer(prompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a helpful RAG assistant. Use the provided context. If the answer is not in the context, say you don't know."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Chat error: ${response.status} ${JSON.stringify(data)}`);
  }

  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function ingestText(title, text, chunkSize) {
  const size = parseChunkSize(chunkSize, 1000);
  const overlap = Math.min(Math.floor(size * 0.2), 800);
  const chunks = chunkText(text, size, overlap);
  const embeddings = await embedTexts(chunks);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (let i = 0; i < chunks.length; i += 1) {
      const content = chunks[i];
      const embedding = embeddings[i];
      await client.query(
        "INSERT INTO rag_chunks (doc_title, chunk_index, content, embedding) VALUES ($1, $2, $3, $4)",
        [title, i, content, toPgVector(embedding)]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { chunks: chunks.length };
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post("/api/ingest", async (req, res) => {
  try {
    const title = String(req.body?.title || "Untitled").slice(0, 200);
    const text = String(req.body?.text || "").trim();
    const chunkSize = parseChunkSize(req.body?.chunkSize, 1000);

    if (!text) {
      return res.status(400).json({ error: "Text is required." });
    }

    const result = await ingestText(title, text, chunkSize);
    res.json({ ok: true, chunks: result.chunks });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/api/ingest-pdf", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    const title = String(req.body?.title || file?.originalname || "Untitled").slice(0, 200);
    const chunkSize = parseChunkSize(req.body?.chunkSize, 1000);

    if (!file) {
      return res.status(400).json({ error: "PDF file is required." });
    }

    const extractedText = await runMineru(file.path);
    const cleanedText = extractedText.trim();

    if (!cleanedText) {
      return res.status(400).json({ error: "No text extracted from PDF." });
    }

    const result = await ingestText(title, cleanedText, chunkSize);
    const preview = cleanedText.slice(0, 8000);
    res.json({ ok: true, chunks: result.chunks, extractedTextPreview: preview });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  } finally {
    if (file?.path) {
      await fs.rm(file.path, { force: true });
    }
  }
});

app.post("/api/clear", async (req, res) => {
  try {
    await pool.query("TRUNCATE rag_chunks RESTART IDENTITY");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/api/warmup", async (req, res) => {
  try {
    if (!LOCAL_EMBEDDINGS) {
      return res.json({ ok: true, message: "Local embeddings disabled." });
    }
    await getLocalEmbedder();
    res.json({ ok: true, message: "Local embedding model ready." });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/api/query", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    const topK = Math.min(Number.parseInt(req.body?.topK || "4", 10), 10);

    if (!query) {
      return res.status(400).json({ error: "Query is required." });
    }

    const [queryEmbedding] = await embedTexts([query]);

    const { rows } = await pool.query(
      "SELECT id, doc_title, chunk_index, content, 1 - (embedding <=> $1) AS similarity FROM rag_chunks ORDER BY embedding <=> $1 LIMIT $2",
      [toPgVector(queryEmbedding), topK]
    );

    const context = rows
      .map(
        (row, idx) =>
          `Source ${idx + 1} (doc: ${row.doc_title}, chunk: ${row.chunk_index}):\n${row.content}`
      )
      .join("\n\n---\n\n");

    const prompt = `Question:\n${query}\n\nContext:\n${context}\n\nAnswer with references to Source 1, Source 2, etc.`;

    const answer = await chatAnswer(prompt);

    res.json({
      answer,
      sources: rows.map((row) => ({
        id: row.id,
        title: row.doc_title,
        chunk: row.chunk_index,
        similarity: Number(row.similarity),
        content: row.content
      }))
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`RAG playground running at http://localhost:${PORT}`);
  if (LOCAL_EMBEDDINGS) {
    console.log("Prewarming local embedding model...");
    getLocalEmbedder()
      .then(() => console.log("Local embedding model ready."))
      .catch((error) => console.warn("Local embedder warm-up failed:", error));
  }
});
