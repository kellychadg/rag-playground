const ingestBtn = document.getElementById("ingestBtn");
const fileInput = document.getElementById("docFile");
const chunkSizeInput = document.getElementById("chunkSize");
const chunkSizeValue = document.getElementById("chunkSizeValue");
const sampleBtn = document.getElementById("sampleBtn");
const clearBtn = document.getElementById("clearBtn");
const warmupBtn = document.getElementById("warmupBtn");
const askBtn = document.getElementById("askBtn");
const ingestStatus = document.getElementById("ingestStatus");
const queryStatus = document.getElementById("queryStatus");
const answerText = document.getElementById("answerText");
const extractedText = document.getElementById("extractedText");
const sourcesList = document.getElementById("sourcesList");
const docTitleInput = document.getElementById("docTitle");
const docTextInput = document.getElementById("docText");
const queryInput = document.getElementById("query");

const SAMPLE_DOC = `Acme Robotics is a mid-sized manufacturer of warehouse robots.

Key products include the LiftMate 3000 and the SwiftPick arm. The LiftMate 3000 can carry up to 800 pounds and is designed for pallets, while the SwiftPick arm is optimized for bin picking of small parts.

Safety guidelines:
- Operators must keep a 3-foot distance during autonomous mode.
- Batteries should be swapped every 12 hours of continuous use.
- Emergency stop buttons are located on all four sides of the base.

Service policy:
Standard warranty is 2 years; extended warranty adds 3 more years. On-site service requires 48 hours notice, while remote diagnostics are available 24/7.`;

const SAMPLE_QUERY = "What is the lift capacity of the LiftMate 3000 and how long is the standard warranty?";

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function readFileText(file) {
  if (!file) return "";
  return await file.text();
}

function isPdf(file) {
  return Boolean(file && file.name.toLowerCase().endsWith(".pdf"));
}

ingestBtn.addEventListener("click", async () => {
  ingestStatus.textContent = "";
  extractedText.textContent = "";
  try {
    const title = docTitleInput.value || "Untitled";
    const textInput = docTextInput.value || "";
    const file = fileInput.files?.[0];
    const chunkSize = Number.parseInt(chunkSizeInput.value, 10);

    ingestStatus.textContent = "Ingesting... (first run may download the model)";
    if (isPdf(file)) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      formData.append("chunkSize", String(chunkSize));

      const response = await fetch("/api/ingest-pdf", {
        method: "POST",
        body: formData
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Request failed");
      }

      ingestStatus.textContent = `Ingested ${data.chunks} chunks from PDF.`;
      extractedText.textContent = data.extractedTextPreview || "";
      return;
    }

    const fileText = await readFileText(file);
    const text = `${textInput}\n\n${fileText}`.trim();
    const result = await postJson("/api/ingest", { title, text, chunkSize });
    ingestStatus.textContent = `Ingested ${result.chunks} chunks.`;
    extractedText.textContent = text.slice(0, 8000);
  } catch (error) {
    ingestStatus.textContent = error.message;
  }
});

sampleBtn.addEventListener("click", () => {
  docTitleInput.value = "Acme Robotics FAQ";
  docTextInput.value = SAMPLE_DOC;
  queryInput.value = SAMPLE_QUERY;
  fileInput.value = "";
  ingestStatus.textContent = "Sample loaded. Click Ingest.";
  extractedText.textContent = "";
});

clearBtn.addEventListener("click", async () => {
  ingestStatus.textContent = "";
  extractedText.textContent = "";
  try {
    ingestStatus.textContent = "Clearing...";
    await postJson("/api/clear", {});
    ingestStatus.textContent = "All documents cleared.";
  } catch (error) {
    ingestStatus.textContent = error.message;
  }
});

warmupBtn.addEventListener("click", async () => {
  ingestStatus.textContent = "";
  try {
    ingestStatus.textContent = "Warming up model... (first run may download)";
    const result = await postJson("/api/warmup", {});
    ingestStatus.textContent = result.message || "Model ready.";
  } catch (error) {
    ingestStatus.textContent = error.message;
  }
});

askBtn.addEventListener("click", async () => {
  queryStatus.textContent = "";
  answerText.textContent = "";
  sourcesList.innerHTML = "";

  try {
    const query = queryInput.value || "";
    queryStatus.textContent = "Thinking...";
    const result = await postJson("/api/query", { query, topK: 4 });
    queryStatus.textContent = "";
    answerText.textContent = result.answer || "";

    result.sources.forEach((source, index) => {
      const card = document.createElement("div");
      card.className = "source";
      card.innerHTML = `<strong>Source ${index + 1}</strong><div>${source.title} (chunk ${source.chunk})</div><pre>${source.content}</pre>`;
      sourcesList.appendChild(card);
    });
  } catch (error) {
    queryStatus.textContent = error.message;
  }
});

chunkSizeInput.addEventListener("input", () => {
  chunkSizeValue.textContent = chunkSizeInput.value;
});
