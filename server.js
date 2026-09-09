// @ts-nocheck

import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} from "@google/genai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 3000);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const ROOT = process.cwd();

const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const WORK_DIR = path.join(ROOT, "work");

for (const dir of [
  UPLOAD_DIR,
  OUTPUT_DIR,
  WORK_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is missing.");
}

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    })
  : null;

const execFileAsync = promisify(execFile);

const upload = multer({
  dest: UPLOAD_DIR,

  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) {
      return cb(
        new Error("Only video files are allowed.")
      );
    }

    cb(null, true);
  }
});

const jobs = new Map();

/* =====================================================
   HELPERS
===================================================== */

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function makeId() {
  return crypto.randomUUID();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

async function ffprobeDuration(file) {
  const { stdout } = await execFileAsync(
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

  const duration = Number(
    String(stdout).trim()
  );

  if (!Number.isFinite(duration)) {
    throw new Error(
      "Could not detect video duration."
    );
  }

  return duration;
}

function cleanGeminiText(text) {
  let value = String(text || "").trim();

  value = value
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  return value;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

/* =====================================================
   GEMINI VIDEO ANALYSIS
===================================================== */

async function uploadVideoToGemini(filePath, mimeType) {

  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY is not configured."
    );
  }

  console.log(
    "Uploading video to Gemini..."
  );

  const uploaded =
    await ai.files.upload({
      file: filePath,
      config: {
        mimeType:
          mimeType || "video/mp4"
      }
    });

  if (!uploaded?.name) {
    throw new Error(
      "Gemini video upload failed."
    );
  }

  console.log(
    "Gemini file:",
    uploaded.name
  );

  let videoFile = uploaded;

  let attempts = 0;

  while (
    videoFile.state &&
    String(videoFile.state) === "PROCESSING"
  ) {

    attempts++;

    if (attempts > 120) {
      throw new Error(
        "Gemini video processing timed out."
      );
    }

    await sleep(3000);

    videoFile =
      await ai.files.get({
        name: uploaded.name
      });

    console.log(
      "Gemini video state:",
      videoFile.state
    );
  }

  if (
    String(videoFile.state) === "FAILED"
  ) {
    throw new Error(
      "Gemini failed to process the video."
    );
  }

  return videoFile;
}

/* =====================================================
   GEMINI RECAP PROMPT
===================================================== */

function buildRecapPrompt({
  targetDuration,
  language,
  style,
  sourceDuration
}) {

  return `
You are the AI editor for OneClick Recap.

Analyze the entire uploaded video.

SOURCE VIDEO DURATION:
${sourceDuration.toFixed(2)} seconds

TARGET RECAP DURATION:
${targetDuration} seconds

LANGUAGE:
${language}

STYLE:
${style}

Your job is to create a REAL video recap.

IMPORTANT:
- Do NOT simply describe the whole video.
- Select the most important and interesting moments.
- Return precise timestamps for the clips.
- Clips must be taken from the original video.
- Avoid repeated or boring scenes.
- Prefer visually meaningful moments.
- The total selected clip duration should be close to ${targetDuration} seconds.
- Each clip should normally be 2 to 12 seconds.
- Do not select timestamps outside the source video.
- Do not invent events that are not visible/audible.
- Create a short narration/script based ONLY on what happens in the video.
- Create subtitle segments.
- Keep the final recap engaging.

Return ONLY valid JSON.

Required JSON structure:

{
  "title": "short recap title",
  "summary": "short summary",
  "clips": [
    {
      "start": 0.0,
      "end": 5.0,
      "reason": "why this moment matters"
    }
  ],
  "narration": [
    {
      "start": 0.0,
      "end": 5.0,
      "text": "narration for this section"
    }
  ]
}

Rules:
- clips must contain real timestamps.
- narration timestamps must fit inside the selected recap timeline.
- Keep narration concise.
- For Burmese, write natural Burmese.
- For English, write natural English.
- For Japanese, write natural Japanese.
- For Chinese, write natural Chinese.
- For Korean, write natural Korean.
`;
}

/* =====================================================
   GEMINI ANALYSIS
===================================================== */

async function analyzeVideo({
  videoFile,
  targetDuration,
  language,
  style,
  sourceDuration
}) {

  console.log(
    "Sending video to Gemini..."
  );

  const prompt =
    buildRecapPrompt({
      targetDuration,
      language,
      style,
      sourceDuration
    });

  const response =
    await ai.models.generateContent({
      model: GEMINI_MODEL,

      contents:
        createUserContent([
          createPartFromUri(
            videoFile.uri,
            videoFile.mimeType
          ),

          prompt
        ])
    });

  const raw =
    cleanGeminiText(
      response.text
    );

  console.log(
    "Gemini response:",
    raw.slice(0, 2000)
  );

  let result;

  try {
    result = JSON.parse(raw);
  } catch {

    const match =
      raw.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error(
        "Gemini returned invalid recap JSON."
      );
    }

    result =
      JSON.parse(match[0]);
  }

  return result;
}

/* =====================================================
   NORMALIZE CLIPS
===================================================== */

function normalizeClips(
  clips,
  sourceDuration,
  targetDuration
) {

  if (!Array.isArray(clips)) {
    throw new Error(
      "Gemini did not return video clips."
    );
  }

  const cleaned = [];

  for (const clip of clips) {

    let start =
      safeNumber(clip.start);

    let end =
      safeNumber(clip.end);

    start =
      clamp(
        start,
        0,
        Math.max(0, sourceDuration - 0.2)
      );

    end =
      clamp(
        end,
        start + 0.5,
        sourceDuration
      );

    if (end > start) {

      cleaned.push({
        start,
        end,
        reason:
          String(
            clip.reason || ""
          )
      });
    }
  }

  if (!cleaned.length) {
    throw new Error(
      "No valid recap clips were returned."
    );
  }

  /*
    Limit to requested output duration.
  */

  const selected = [];

  let total = 0;

  for (const clip of cleaned) {

    const length =
      clip.end - clip.start;

    if (
      total + length <=
      targetDuration + 1
    ) {

      selected.push(clip);

      total += length;
    }
  }

  /*
    If Gemini selected too little,
    add additional clips when available.
  */

  if (
    selected.length === 0
  ) {
    selected.push(
      cleaned[0]
    );
  }

  return selected;
}

/* =====================================================
   CREATE CLIPS WITH FFMPEG
===================================================== */

async function createClip(
  input,
  output,
  start,
  end
) {

  const duration =
    Math.max(
      0.5,
      end - start
    );

  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-ss",
      String(start),

      "-i",
      input,

      "-t",
      String(duration),

      "-map",
      "0:v:0",

      "-map",
      "0:a?",

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "23",

      "-c:a",
      "aac",

      "-ar",
      "48000",

      "-ac",
      "2",

      "-movflags",
      "+faststart",

      output
    ],
    {
      maxBuffer:
        10 * 1024 * 1024
    }
  );
}

/* =====================================================
   CONCAT CLIPS
===================================================== */

async function concatClips(
  clips,
  output
) {

  const listFile =
    output + ".txt";

  const content =
    clips
      .map(file => {
        const escaped =
          file.replace(
            /'/g,
            "'\\''"
          );

        return `file '${escaped}'`;
      })
      .join("\n");

  fs.writeFileSync(
    listFile,
    content
  );

  try {

    await execFileAsync(
      "ffmpeg",
      [
        "-y",

        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        listFile,

        "-c",
        "copy",

        "-movflags",
        "+faststart",

        output
      ],
      {
        maxBuffer:
          10 * 1024 * 1024
      }
    );

  } finally {

    try {
      fs.unlinkSync(
        listFile
      );
    } catch {}
  }
}

/* =====================================================
   SRT
===================================================== */

function formatSrtTime(seconds) {

  seconds =
    Math.max(
      0,
      Number(seconds) || 0
    );

  const hours =
    Math.floor(
      seconds / 3600
    );

  const minutes =
    Math.floor(
      (seconds % 3600) / 60
    );

  const secs =
    Math.floor(
      seconds % 60
    );

  const ms =
    Math.floor(
      (seconds -
        Math.floor(seconds)) *
        1000
    );

  return [
    String(hours).padStart(2, "0"),

    String(minutes).padStart(2, "0"),

    String(secs).padStart(2, "0")
  ].join(":") +
    "," +
    String(ms).padStart(3, "0");
}

function createSrt(
  narration,
  clips
) {

  if (
    !Array.isArray(narration) ||
    !narration.length
  ) {
    return "";
  }

  const entries = [];

  /*
    Gemini narration timestamps may correspond
    to the recap timeline.

    We clamp them to the final video.
  */

  for (
    let i = 0;
    i < narration.length;
    i++
  ) {

    const item =
      narration[i];

    let start =
      safeNumber(item.start);

    let end =
      safeNumber(item.end);

    if (
      end <= start
    ) {
      continue;
    }

    const text =
      String(
        item.text || ""
      ).trim();

    if (!text) {
      continue;
    }

    entries.push(
      [
        String(
          entries.length + 1
        ),

        `${formatSrtTime(start)} --> ${formatSrtTime(end)}`,

        text,

        ""
      ].join("\n")
    );
  }

  return entries.join("\n");
}

/* =====================================================
   BURN SUBTITLES
===================================================== */

async function burnSubtitles(
  input,
  srtFile,
  output,
  format
) {

  /*
    Use Noto fonts installed in Docker.
  */

  const subtitleFilter =
    `subtitles=${srtFile.replace(
      /\\/g,
      "\\\\"
    ).replace(
      /:/g,
      "\\:"
    )}:force_style='FontName=Noto Sans Myanmar,FontSize=22,Outline=2,Shadow=1,Alignment=2,MarginV=55'`;

  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-i",
      input,

      "-vf",
      subtitleFilter,

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
    ],
    {
      maxBuffer:
        10 * 1024 * 1024
    }
  );
}

/* =====================================================
   FORMAT VIDEO
===================================================== */

async function formatVideo(
  input,
  output,
  format
) {

  let vf;

  if (format === "9:16") {

    vf =
      "scale=1080:1920:force_original_aspect_ratio=decrease," +
      "pad=1080:1920:(ow-iw)/2:(oh-ih)/2";

  } else if (
    format === "1:1"
  ) {

    vf =
      "scale=1080:1080:force_original_aspect_ratio=decrease," +
      "pad=1080:1080:(ow-iw)/2:(oh-ih)/2";

  } else {

    vf =
      "scale=1920:1080:force_original_aspect_ratio=decrease," +
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
  }

  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-i",
      input,

      "-vf",
      vf,

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
    ],
    {
      maxBuffer:
        10 * 1024 * 1024
    }
  );
}

/* =====================================================
   PROCESS RECAP
===================================================== */

async function processRecap({
  jobId,
  inputFile,
  mimeType,
  duration,
  format,
  language,
  style,
  aiVoice,
  subtitles
}) {

  const work =
    path.join(
      WORK_DIR,
      jobId
    );

  fs.mkdirSync(
    work,
    { recursive: true }
  );

  try {

    jobs.get(jobId).status =
      "analyzing";

    jobs.get(jobId).progress =
      10;

    /* -----------------------------------------------
       1. Get source duration
    ------------------------------------------------ */

    const sourceDuration =
      await ffprobeDuration(
        inputFile
      );

    console.log(
      "Source duration:",
      sourceDuration
    );

    jobs.get(jobId).progress =
      15;

    /* -----------------------------------------------
       2. Upload to Gemini
    ------------------------------------------------ */

    const videoFile =
      await uploadVideoToGemini(
        inputFile,
        mimeType
      );

    jobs.get(jobId).status =
      "ai-analysis";

    jobs.get(jobId).progress =
      30;

    /* -----------------------------------------------
       3. Gemini selects recap scenes
    ------------------------------------------------ */

    const analysis =
      await analyzeVideo({
        videoFile,

        targetDuration:
          duration,

        language,

        style,

        sourceDuration
      });

    console.log(
      "Recap title:",
      analysis.title
    );

    const clips =
      normalizeClips(
        analysis.clips,
        sourceDuration,
        duration
      );

    jobs.get(jobId).analysis =
      analysis;

    jobs.get(jobId).clips =
      clips;

    jobs.get(jobId).progress =
      45;

    /* -----------------------------------------------
       4. Cut selected scenes
    ------------------------------------------------ */

    const clipFiles = [];

    for (
      let i = 0;
      i < clips.length;
      i++
    ) {

      const clip =
        clips[i];

      const clipFile =
        path.join(
          work,
          `clip-${i}.mp4`
        );

      await createClip(
        inputFile,
        clipFile,
        clip.start,
        clip.end
      );

      clipFiles.push(
        clipFile
      );

      jobs.get(jobId).progress =
        45 +
        Math.round(
          (i + 1) /
          clips.length *
          25
        );
    }

    /* -----------------------------------------------
       5. Concatenate
    ------------------------------------------------ */

    const concatenated =
      path.join(
        work,
        "recap-concat.mp4"
      );

    await concatClips(
      clipFiles,
      concatenated
    );

    jobs.get(jobId).progress =
      75;

    /* -----------------------------------------------
       6. Format
    ------------------------------------------------ */

    const formatted =
      path.join(
        work,
        "recap-formatted.mp4"
      );

    await formatVideo(
      concatenated,
      formatted,
      format
    );

    jobs.get(jobId).progress =
      82;

    let finalVideo =
      formatted;

    /* -----------------------------------------------
       7. Subtitles
    ------------------------------------------------ */

    if (
      subtitles &&
      Array.isArray(
        analysis.narration
      ) &&
      analysis.narration.length
    ) {

      const srt =
        createSrt(
          analysis.narration,
          clips
        );

      if (srt.trim()) {

        const srtFile =
          path.join(
            work,
            "subtitles.srt"
          );

        fs.writeFileSync(
          srtFile,
          srt,
          "utf8"
        );

        const subtitled =
          path.join(
            work,
            "recap-subtitled.mp4"
          );

        await burnSubtitles(
          formatted,
          srtFile,
          subtitled,
          format
        );

        finalVideo =
          subtitled;
      }
    }

    jobs.get(jobId).progress =
      95;

    /* -----------------------------------------------
       8. Copy final video
    ------------------------------------------------ */

    const outputName =
      `${jobId}.mp4`;

    const outputFile =
      path.join(
        OUTPUT_DIR,
        outputName
      );

    fs.copyFileSync(
      finalVideo,
      outputFile
    );

    jobs.get(jobId).videoUrl =
      `/outputs/${outputName}`;

    jobs.get(jobId).summary =
      analysis.summary ||
      "";

    jobs.get(jobId).script =
      Array.isArray(
        analysis.narration
      )
        ? analysis.narration
            .map(x => x.text)
            .join(" ")
        : "";

    jobs.get(jobId).status =
      "completed";

    jobs.get(jobId).progress =
      100;

    console.log(
      "RECAP COMPLETED:",
      outputFile
    );

  } catch (error) {

    console.error(
      "RECAP ERROR:",
      error
    );

    jobs.get(jobId).status =
      "error";

    jobs.get(jobId).progress =
      100;

    jobs.get(jobId).error =
      error?.message ||
      String(error);

  } finally {

    /*
      Remove uploaded source.
    */

    try {
      if (
        fs.existsSync(
          inputFile
        )
      ) {
        fs.unlinkSync(
          inputFile
        );
      }
    } catch {}

    /*
      Keep output but remove work files.
    */

    try {
      fs.rmSync(
        work,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  }
}

/* =====================================================
   STATIC OUTPUTS
===================================================== */

app.use(
  "/outputs",
  express.static(
    OUTPUT_DIR
  )
);

/* =====================================================
   CREATE RECAP
===================================================== */

app.post(
  "/api/recap",
  upload.single("video"),
  async (req, res) => {

    try {

      if (!GEMINI_API_KEY) {

        if (req.file?.path) {
          try {
            fs.unlinkSync(
              req.file.path
            );
          } catch {}
        }

        return res.status(500).json({
          error:
            "GEMINI_API_KEY is not configured."
        });
      }

      if (!req.file) {

        return res.status(400).json({
          error:
            "Please upload a video."
        });
      }

      const jobId =
        makeId();

      const requestedDuration =
        Number(
          req.body.duration || 30
        );

      const duration =
        [30, 60, 90].includes(
          requestedDuration
        )
          ? requestedDuration
          : 30;

      const format =
        req.body.format ||
        "9:16";

      const language =
        req.body.language ||
        "English";

      const style =
        req.body.style ||
        "cinematic";

      const aiVoice =
        String(
          req.body.aiVoice
        ) === "true";

      const subtitles =
        String(
          req.body.subtitles
        ) === "true";

      jobs.set(
        jobId,
        {
          jobId,

          status:
            "queued",

          progress:
            0,

          videoUrl:
            null,

          summary:
            null,

          script:
            null,

          error:
            null,

          createdAt:
            Date.now()
        }
      );

      res.json({
        success:
          true,

        jobId,

        message:
          "AI video recap started."
      });

      /*
        Run in background.
      */

      processRecap({
        jobId,

        inputFile:
          req.file.path,

        mimeType:
          req.file.mimetype,

        duration,

        format,

        language,

        style,

        aiVoice,

        subtitles
      });

    } catch (error) {

      console.error(
        error
      );

      if (req.file?.path) {

        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}
      }

      return res.status(500).json({
        error:
          error?.message ||
          "Failed to start recap."
      });
    }
  }
);

/* =====================================================
   STATUS
===================================================== */

app.get(
  "/api/recap/status/:jobId",
  (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {

      return res.status(404).json({
        error:
          "Job not found."
      });
    }

    res.json({
      success:
        true,

      jobId:
        job.jobId,

      status:
        job.status,

      progress:
        job.progress || 0,

      videoUrl:
        job.videoUrl
          ? `${req.protocol}://${req.get("host")}${job.videoUrl}`
          : null,

      summary:
        job.summary,

      script:
        job.script,

      error:
        job.error
    });
  }
);

/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/",
  (req, res) => {

    res.json({
      ok:
        true,

      service:
        "OneClick Recap AI",

      version:
        "4.0.0-gemini",

      engine:
        "Gemini + FFmpeg",

      openai:
        false,

      json2video:
        false,

      gemini:
        Boolean(
          GEMINI_API_KEY
        )
    });
  }
);

/* =====================================================
   ERROR HANDLER
===================================================== */

app.use(
  (error, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      error
    );

    res.status(500).json({
      error:
        error?.message ||
        "Server error"
    });
  }
);

/* =====================================================
   START
===================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `OneClick Recap 4.0 running on port ${PORT}`
    );

    console.log(
      "Gemini configured:",
      Boolean(GEMINI_API_KEY)
    );

    console.log(
      "OpenAI:",
      false
    );

    console.log(
      "JSON2Video:",
      false
    );
  }
);
