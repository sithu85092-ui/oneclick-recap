// @ts-nocheck

import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 3000);

const JSON2VIDEO_API =
  "https://api.json2video.com/v2";

const JSON2VIDEO_API_KEY =
  process.env.JSON2VIDEO_API_KEY;

if (!JSON2VIDEO_API_KEY) {
  console.warn("WARNING: JSON2VIDEO_API_KEY is not configured.");
}

const ROOT = process.cwd();

const UPLOAD_DIR = path.join(ROOT, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) {
      return cb(new Error("Only video files are allowed."));
    }

    cb(null, true);
  }
});

const jobs = new Map();

/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */

function makeId() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json2videoHeaders() {
  return {
    "x-api-key": JSON2VIDEO_API_KEY,
    "Content-Type": "application/json"
  };
}

function getResolution(format) {
  switch (format) {
    case "9:16":
      return {
        width: 1080,
        height: 1920
      };

    case "1:1":
      return {
        width: 1080,
        height: 1080
      };

    case "16:9":
    default:
      return {
        width: 1920,
        height: 1080
      };
  }
}

function getResolutionName(format) {
  switch (format) {
    case "9:16":
      return "full-hd";

    case "1:1":
      return "full-hd";

    case "16:9":
    default:
      return "full-hd";
  }
}

/*
  JSON2Video voice names.

  These are examples of Azure voices supported by JSON2Video.
  The language selected by the frontend is mapped here.
*/

function getVoice(language) {
  switch (language) {
    case "Burmese":
      return {
        voice: "my-MM-NilarNeural",
        model: "azure"
      };

    case "Japanese":
      return {
        voice: "ja-JP-NanamiNeural",
        model: "azure"
      };

    case "Chinese":
      return {
        voice: "zh-CN-XiaoxiaoNeural",
        model: "azure"
      };

    case "Korean":
      return {
        voice: "ko-KR-SunHiNeural",
        model: "azure"
      };

    case "English":
    default:
      return {
        voice: "en-US-JennyNeural",
        model: "azure"
      };
  }
}

/*
  Since there is no OpenAI summarizer anymore,
  we generate a simple title/description from the
  user's selected options.

  This is NOT AI summarization.
*/

function createBasicText({
  language,
  style,
  duration
}) {
  const text = {
    English:
      `Video recap — ${duration} seconds — ${style} style.`,

    Burmese:
      `ဗီဒီယို အကျဉ်းချုပ် — ${duration} စက္ကန့် — ${style} ပုံစံ။`,

    Japanese:
      `ビデオリキャップ — ${duration}秒 — ${style}スタイル。`,

    Chinese:
      `视频摘要 — ${duration} 秒 — ${style} 风格。`,

    Korean:
      `영상 요약 — ${duration}초 — ${style} 스타일。`
  };

  return text[language] || text.English;
}

/* -------------------------------------------------------
   JSON2Video media upload
------------------------------------------------------- */

async function uploadToJSON2Video(filePath, originalName, mimeType) {
  const stat = fs.statSync(filePath);

  if (stat.size <= 0) {
    throw new Error("Uploaded video is empty.");
  }

  if (stat.size > 500 * 1024 * 1024) {
    throw new Error("Video is larger than JSON2Video's 500 MB limit.");
  }

  const cleanName =
    String(originalName || "video.mp4")
      .replace(/[^a-zA-Z0-9._-]/g, "_");

  /* Step 1: request presigned upload URL */

  const createResponse = await fetch(
    `${JSON2VIDEO_API}/media/file`,
    {
      method: "POST",
      headers: json2videoHeaders(),
      body: JSON.stringify({
        name: `${Date.now()}_${cleanName}`,
        contentType: mimeType || "video/mp4",
        size: stat.size,
        folder: "temp"
      })
    }
  );

  const createText = await createResponse.text();

  let createData;

  try {
    createData = JSON.parse(createText);
  } catch {
    throw new Error(
      `JSON2Video media response was not JSON: ${createText.slice(0, 500)}`
    );
  }

  if (!createResponse.ok || !createData.uploadUrl) {
    throw new Error(
      createData.message ||
      createData.error ||
      `JSON2Video media upload setup failed (${createResponse.status})`
    );
  }

  /* Step 2: upload actual file to presigned URL */

  const fileBuffer = fs.readFileSync(filePath);

  const uploadResponse = await fetch(
    createData.uploadUrl,
    {
      method: "PUT",
      headers: {
        "Content-Type": mimeType || "video/mp4"
      },
      body: fileBuffer
    }
  );

  if (!uploadResponse.ok) {
    const uploadError = await uploadResponse.text();

    throw new Error(
      `JSON2Video file upload failed (${uploadResponse.status}): ${uploadError.slice(0, 500)}`
    );
  }

  return createData.fileUrl;
}

/* -------------------------------------------------------
   Create JSON2Video movie
------------------------------------------------------- */

async function createMovie({
  sourceUrl,
  duration,
  format,
  language,
  style,
  aiVoice,
  subtitles
}) {
  const resolution = getResolution(format);

  const sceneElements = [];

  /*
    Main source video.
    seek = 0
    duration = requested output duration
  */

  sceneElements.push({
    type: "video",
    src: sourceUrl,
    seek: 0,
    duration: duration,
    position: "center-center",
    resize: "cover",
    volume: 1
  });

  /*
    Optional voice.
    Because OpenAI is removed, this uses
    JSON2Video's voice element.
  */

  if (aiVoice) {
    const voice = getVoice(language);

    sceneElements.push({
      type: "voice",
      voice: voice.voice,
      model: voice.model,
      text: createBasicText({
        language,
        style,
        duration
      }),
      duration: duration,
      volume: 1
    });
  }

  const movie = {
    resolution: "full-hd",

    width: resolution.width,
    height: resolution.height,

    fps: 30,

    cache: false,

    "client-data": {
      source: "oneclick-recap",
      language,
      style,
      duration,
      format
    },

    scenes: [
      {
        duration,
        elements: sceneElements
      }
    ]
  };

  /*
    Automatic subtitles must be movie-level.
    JSON2Video transcribes the movie audio and burns
    subtitles onto the video.
  */

  if (subtitles && aiVoice) {
    movie.elements = [
      {
        type: "subtitles",
        language: "auto",
        model: "default",

        settings: {
          "font-family": "Roboto",
          "font-size": 56,
          "font-weight": "900",
          "max-words-per-line": 5,
          "all-caps": false,
          style: "classic",
          position: "bottom-center",
          "outline-width": 5
        }
      }
    ];
  }

  const response = await fetch(
    `${JSON2VIDEO_API}/movies`,
    {
      method: "POST",
      headers: json2videoHeaders(),
      body: JSON.stringify(movie)
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `JSON2Video movie response was not JSON: ${text.slice(0, 500)}`
    );
  }

  if (!response.ok || !data.project) {
    throw new Error(
      data.message ||
      data.error ||
      `JSON2Video movie creation failed (${response.status})`
    );
  }

  return data.project;
}

/* -------------------------------------------------------
   Poll JSON2Video
------------------------------------------------------- */

async function waitForMovie(projectId, jobId) {
  const maxAttempts = 240;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {

    const response = await fetch(
      `${JSON2VIDEO_API}/movies?project=${encodeURIComponent(projectId)}`,
      {
        method: "GET",
        headers: {
          "x-api-key": JSON2VIDEO_API_KEY
        }
      }
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON2Video status response: ${text.slice(0, 500)}`
      );
    }

    if (!response.ok) {
      throw new Error(
        data.message ||
        data.error ||
        `JSON2Video status request failed (${response.status})`
      );
    }

    const movie = data.movie;

    if (!movie) {
      throw new Error("JSON2Video did not return movie status.");
    }

    const status = movie.status;

    if (jobs.has(jobId)) {
      jobs.get(jobId).status =
        status === "done"
          ? "completed"
          : status === "error" || status === "timeout"
            ? "error"
            : "rendering";
    }

    if (status === "done") {
      return movie;
    }

    if (status === "error") {
      throw new Error(
        movie.message ||
        "JSON2Video rendering failed."
      );
    }

    if (status === "timeout") {
      throw new Error(
        "JSON2Video rendering timed out."
      );
    }

    await sleep(5000);
  }

  throw new Error(
    "JSON2Video rendering took too long."
  );
}

/* -------------------------------------------------------
   Process
------------------------------------------------------- */

async function processRecap({
  jobId,
  filePath,
  originalName,
  mimeType,
  duration,
  format,
  language,
  style,
  aiVoice,
  subtitles
}) {
  try {

    jobs.set(jobId, {
      ...jobs.get(jobId),

      status: "uploading",

      progress: 10
    });

    /* Upload source video to JSON2Video */

    const sourceUrl =
      await uploadToJSON2Video(
        filePath,
        originalName,
        mimeType
      );

    jobs.set(jobId, {
      ...jobs.get(jobId),

      status: "creating",
      progress: 25,

      sourceUrl
    });

    /* Create movie */

    const projectId =
      await createMovie({
        sourceUrl,
        duration,
        format,
        language,
        style,
        aiVoice,
        subtitles
      });

    jobs.set(jobId, {
      ...jobs.get(jobId),

      status: "rendering",
      progress: 35,

      projectId
    });

    /* Wait for render */

    const movie =
      await waitForMovie(
        projectId,
        jobId
      );

    jobs.set(jobId, {
      ...jobs.get(jobId),

      status: "completed",
      progress: 100,

      videoUrl: movie.url,

      summary:
        createBasicText({
          language,
          style,
          duration
        }),

      script:
        aiVoice
          ? createBasicText({
              language,
              style,
              duration
            })
          : "AI voice disabled.",

      projectId,

      json2video: movie
    });

  } catch (error) {

    console.error(
      `[${jobId}]`,
      error
    );

    jobs.set(jobId, {
      ...jobs.get(jobId),

      status: "error",
      progress: 100,

      error:
        error?.message ||
        String(error)
    });

  } finally {

    /*
      Delete temporary upload from Render.
    */

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

/* -------------------------------------------------------
   POST /api/recap
------------------------------------------------------- */

app.post(
  "/api/recap",
  upload.single("video"),
  async (req, res) => {

    try {

      if (!JSON2VIDEO_API_KEY) {
        return res.status(500).json({
          error:
            "JSON2VIDEO_API_KEY is not configured on Render."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "Please upload a video."
        });
      }

      const jobId = makeId();

      const requestedDuration =
        Number(req.body.duration || 30);

      const duration =
        [30, 60, 90].includes(requestedDuration)
          ? requestedDuration
          : 30;

      const format =
        req.body.format || "9:16";

      const language =
        req.body.language || "English";

      const style =
        req.body.style || "cinematic";

      const aiVoice =
        String(req.body.aiVoice) === "true";

      const subtitles =
        String(req.body.subtitles) === "true";

      jobs.set(jobId, {
        jobId,

        status: "queued",

        progress: 0,

        videoUrl: null,

        summary: null,

        script: null,

        error: null,

        createdAt: Date.now()
      });

      res.json({
        success: true,

        jobId,

        message:
          "Video uploaded. JSON2Video rendering started."
      });

      processRecap({
        jobId,

        filePath: req.file.path,

        originalName:
          req.file.originalname,

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

      console.error(error);

      if (req.file?.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }

      res.status(500).json({
        error:
          error?.message ||
          "Failed to create recap."
      });
    }
  }
);

/* -------------------------------------------------------
   GET /api/recap/status/:jobId
------------------------------------------------------- */

app.get(
  "/api/recap/status/:jobId",
  (req, res) => {

    const job =
      jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found."
      });
    }

    res.json({
      success: true,

      jobId: job.jobId,

      status: job.status,

      progress:
        job.progress ?? 0,

      videoUrl:
        job.videoUrl || null,

      summary:
        job.summary || null,

      script:
        job.script || null,

      error:
        job.error || null,

      projectId:
        job.projectId || null
    });
  }
);

/* -------------------------------------------------------
   Health
------------------------------------------------------- */

app.get("/", (req, res) => {

  res.json({
    ok: true,

    service:
      "OneClick Recap AI",

    version:
      "3.0.0-json2video",

    engine:
      "JSON2Video",

    openai:
      false,

    json2video:
      Boolean(JSON2VIDEO_API_KEY)
  });
});

/* -------------------------------------------------------
   404
------------------------------------------------------- */

app.use((req, res) => {

  res.status(404).json({
    error: "Not found"
  });
});

/* -------------------------------------------------------
   Error handler
------------------------------------------------------- */

app.use((error, req, res, next) => {

  console.error(error);

  res.status(500).json({
    error:
      error?.message ||
      "Server error"
  });
});

/* -------------------------------------------------------
   Start
------------------------------------------------------- */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `OneClick Recap JSON2Video server running on port ${PORT}`
    );

    console.log(
      `JSON2Video configured: ${Boolean(JSON2VIDEO_API_KEY)}`
    );
  }
);
