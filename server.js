import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

const exec = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const CF_BASE =
  `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run`;

const LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const WHISPER_MODEL = "@cf/openai/whisper";

const uploadDir = path.join(process.cwd(), "uploads");
const outputDir = path.join(process.cwd(), "outputs");
const workDir = path.join(process.cwd(), "work");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json());

app.use(
  "/outputs",
  express.static(outputDir)
);

function runCommand(command, args) {
  return exec(command, args, {
    maxBuffer: 10 * 1024 * 1024
  });
}

async function cloudflareAI(model, input) {
  if (!CF_TOKEN || !CF_ACCOUNT_ID) {
    throw new Error(
      "Cloudflare API configuration is missing."
    );
  }

  const response = await fetch(
    `${CF_BASE}/${encodeURIComponent(model)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );

  const data = await response.json();

  if (!response.ok || data.success === false) {
    throw new Error(
      JSON.stringify(data)
    );
  }

  return data.result;
}

/* --------------------------------
   HEALTH
-------------------------------- */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "OneClick Recap AI",
    version: "5.0.0-cloudflare",
    engine: "Cloudflare AI + FFmpeg",
    openai: false,
    json2video: false,
    gemini: false,
    cloudflare: true
  });
});

/* --------------------------------
   VIDEO INFO
-------------------------------- */

async function getVideoDuration(file) {
  const { stdout } = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file
    ]
  );

  return Number(stdout.trim()) || 0;
}

/* --------------------------------
   EXTRACT AUDIO
-------------------------------- */

async function extractAudio(video, audio) {
  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      video,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      audio
    ]
  );
}

/* --------------------------------
   WHISPER
-------------------------------- */

async function transcribeAudio(audioFile) {
  const audioBuffer =
    fs.readFileSync(audioFile);

  const result = await cloudflareAI(
    WHISPER_MODEL,
    audioBuffer
  );

  return {
    text: result?.text || "",
    vtt: result?.vtt || "",
    segments: result?.segments || []
  };
}

/* --------------------------------
   AI RECAP
-------------------------------- */

async function createRecap(transcript, duration, targetDuration, language, style) {

  const prompt = `
You are an expert short-form video editor.

Create a ${targetDuration}-second recap plan from this transcript.

Original video duration:
${duration} seconds

Language:
${language}

Style:
${style}

Transcript:
${transcript}

IMPORTANT:

Return ONLY valid JSON.

Format:

{
  "title": "short title",
  "summary": "short summary",
  "clips": [
    {
      "start": 0,
      "end": 5,
      "reason": "why this part matters"
    }
  ],
  "script": "short recap script"
}

Rules:

1. Select the most important moments.
2. Do not invent events.
3. Keep clip start/end inside the original video duration.
4. Total selected clip duration should be approximately ${targetDuration} seconds.
5. Avoid unnecessary silence.
6. Prefer exciting, informative or meaningful moments.
7. Make the recap feel fast and engaging.
8. Maximum 12 clips.
9. The script must summarize only information found in the transcript.
`;

  const result = await cloudflareAI(
    LLM_MODEL,
    {
      prompt,
      max_tokens: 1500
    }
  );

  let text =
    result?.response ||
    result?.text ||
    "";

  text = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    return {
      title: "Video Recap",
      summary: text.slice(0, 500),
      clips: [
        {
          start: 0,
          end: Math.min(
            Number(targetDuration),
            Number(duration)
          ),
          reason: "Fallback"
        }
      ],
      script: text
    };
  }
}

/* --------------------------------
   NORMALIZE CLIPS
-------------------------------- */

function normalizeClips(
  clips,
  originalDuration,
  targetDuration
) {
  if (!Array.isArray(clips)) {
    return [];
  }

  const clean = [];

  for (const clip of clips) {
    let start = Number(clip.start);
    let end = Number(clip.end);

    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = start + 3;

    start = Math.max(
      0,
      Math.min(start, originalDuration)
    );

    end = Math.max(
      start + 0.5,
      Math.min(end, originalDuration)
    );

    if (end > start) {
      clean.push({
        start,
        end,
        reason: clip.reason || ""
      });
    }
  }

  let total = 0;
  const result = [];

  for (const clip of clean) {
    if (total >= targetDuration) break;

    const remaining =
      targetDuration - total;

    const length =
      clip.end - clip.start;

    const finalLength =
      Math.min(length, remaining);

    result.push({
      start: clip.start,
      end: clip.start + finalLength,
      reason: clip.reason
    });

    total += finalLength;
  }

  return result;
}

/* --------------------------------
   CREATE CLIP
-------------------------------- */

async function cutClip(
  input,
  output,
  start,
  end
) {
  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-ss",
      String(start),
      "-i",
      input,
      "-t",
      String(end - start),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      output
    ]
  );
}

/* --------------------------------
   CONCAT
-------------------------------- */

async function concatClips(
  clips,
  output
) {
  const listFile =
    output + ".txt";

  const content =
    clips
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join("\n");

  fs.writeFileSync(
    listFile,
    content
  );

  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      output
    ]
  );

  fs.unlinkSync(listFile);
}

/* --------------------------------
   FORMAT VIDEO
-------------------------------- */

async function formatVideo(
  input,
  output,
  format
) {
  let filter;

  if (format === "16:9") {
    filter =
      "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720";
  }

  else if (format === "1:1") {
    filter =
      "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080";
  }

  else {
    filter =
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
  }

  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      input,
      "-vf",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      output
    ]
  );
}

/* --------------------------------
   SRT
-------------------------------- */

function secondsToSrt(sec) {
  const ms =
    Math.floor(
      (sec % 1) * 1000
    );

  const total =
    Math.floor(sec);

  const s =
    total % 60;

  const m =
    Math.floor(total / 60) % 60;

  const h =
    Math.floor(total / 3600);

  return (
    `${String(h).padStart(2, "0")}:` +
    `${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}

/* --------------------------------
   MAIN RECAP
-------------------------------- */

const jobs = new Map();

app.post(
  "/api/recap",
  upload.single("video"),
  async (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        error: "Video file is required."
      });
    }

    const jobId =
      crypto.randomUUID();

    const videoPath =
      req.file.path;

    jobs.set(jobId, {
      status: "processing",
      progress: 5
    });

    res.json({
      jobId,
      status: "processing"
    });

    processRecap(
      jobId,
      videoPath,
      req.body
    ).catch(error => {

      console.error(error);

      jobs.set(jobId, {
        status: "error",
        progress: 100,
        error:
          error.message ||
          "Recap failed"
      });
    });
  }
);

/* --------------------------------
   PROCESS
-------------------------------- */

async function processRecap(
  jobId,
  videoPath,
  options
) {

  const duration =
    await getVideoDuration(
      videoPath
    );

  jobs.set(jobId, {
    status: "processing",
    progress: 10
  });

  const audioPath =
    path.join(
      workDir,
      `${jobId}.wav`
    );

  await extractAudio(
    videoPath,
    audioPath
  );

  jobs.set(jobId, {
    status: "processing",
    progress: 30
  });

  const transcript =
    await transcribeAudio(
      audioPath
    );

  jobs.set(jobId, {
    status: "processing",
    progress: 50
  });

  const targetDuration =
    Number(options.duration) || 30;

  const language =
    options.language || "English";

  const style =
    options.style || "cinematic";

  const recap =
    await createRecap(
      transcript.text,
      duration,
      targetDuration,
      language,
      style
    );

  const clips =
    normalizeClips(
      recap.clips,
      duration,
      targetDuration
    );

  if (!clips.length) {
    throw new Error(
      "AI did not return valid clips."
    );
  }

  jobs.set(jobId, {
    status: "processing",
    progress: 65
  });

  const clipFiles = [];

  for (
    let i = 0;
    i < clips.length;
    i++
  ) {

    const clipFile =
      path.join(
        workDir,
        `${jobId}-clip-${i}.mp4`
      );

    await cutClip(
      videoPath,
      clipFile,
      clips[i].start,
      clips[i].end
    );

    clipFiles.push(
      clipFile
    );
  }

  const joined =
    path.join(
      workDir,
      `${jobId}-joined.mp4`
    );

  await concatClips(
    clipFiles,
    joined
  );

  jobs.set(jobId, {
    status: "processing",
    progress: 85
  });

  const finalFile =
    path.join(
      outputDir,
      `${jobId}.mp4`
    );

  await formatVideo(
    joined,
    finalFile,
    options.format || "9:16"
  );

  jobs.set(jobId, {
    status: "completed",
    progress: 100,
    videoUrl:
      `/outputs/${jobId}.mp4`,
    summary:
      recap.summary || "",
    script:
      recap.script || "",
    title:
      recap.title || "Video Recap",
    clips
  });

  /* cleanup */

  try {
    fs.unlinkSync(videoPath);
    fs.unlinkSync(audioPath);
    fs.unlinkSync(joined);

    for (const file of clipFiles) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  } catch {}
}

/* --------------------------------
   STATUS
-------------------------------- */

app.get(
  "/api/recap/status/:jobId",
  (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        error: "Job not found"
      });
    }

    res.json(job);
  }
);

/* --------------------------------
   ERROR HANDLER
-------------------------------- */

app.use(
  (err, req, res, next) => {

    console.error(err);

    res.status(500).json({
      error:
        err.message ||
        "Server error"
    });
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `OneClick Recap running on port ${PORT}`
    );
  }
);
