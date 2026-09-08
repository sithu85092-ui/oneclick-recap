// @ts-nocheck

import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

const exec = promisify(execFile);
const app = express();

const PORT = Number(process.env.PORT || 3000);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================================================
   CONFIG
========================================================= */

const VISION_MODEL =
  process.env.VISION_MODEL || "gpt-5.6-luna";

const TTS_MODEL =
  process.env.TTS_MODEL || "gpt-4o-mini-tts";

const TTS_VOICE =
  process.env.TTS_VOICE || "alloy";

const MAX_UPLOAD_SIZE =
  Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024;


/* =========================================================
   FOLDERS
========================================================= */

const ROOT = process.cwd();

const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const WORK_DIR = path.join(ROOT, "work");

for (const dir of [
  UPLOAD_DIR,
  OUTPUT_DIR,
  WORK_DIR
]) {
  fs.mkdirSync(dir, {
    recursive: true
  });
}


/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(cors());

app.use(express.json({
  limit: "10mb"
}));

app.use(
  "/outputs",
  express.static(OUTPUT_DIR)
);


/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({

  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (_req, file, cb) => {

    const ext =
      path.extname(file.originalname) || ".mp4";

    cb(
      null,
      crypto.randomUUID() + ext
    );
  }

});


const upload = multer({

  storage,

  limits: {
    fileSize: MAX_UPLOAD_SIZE
  },

  fileFilter: (_req, file, cb) => {

    if (
      file.mimetype &&
      file.mimetype.startsWith("video/")
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only video files are allowed."
        )
      );
    }

  }

});


/* =========================================================
   JOB STORAGE
========================================================= */

const jobs = new Map();


function createJob() {

  const id =
    crypto.randomUUID();

  jobs.set(id, {

    status: "queued",

    progress: 0,

    message: "Waiting..."

  });

  return id;
}


function updateJob(id, data) {

  const old =
    jobs.get(id) || {};

  jobs.set(id, {

    ...old,

    ...data

  });

}


/* =========================================================
   SAFE NUMBER
========================================================= */

function safeNumber(value, fallback = 0) {

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}


/* =========================================================
   FFMPEG HELPERS
========================================================= */

async function getDuration(file) {

  const { stdout } =
    await exec(
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

  const duration =
    Number(stdout.trim());

  if (!Number.isFinite(duration)) {
    throw new Error(
      "Could not read video duration."
    );
  }

  return duration;
}


/* =========================================================
   EXTRACT AUDIO
========================================================= */

async function extractAudio(
  video,
  output
) {

  await exec(
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
      "mp3",

      output
    ]
  );
}


/* =========================================================
   TRANSCRIPTION
========================================================= */

async function transcribe(audio) {

  const result =
    await openai.audio.transcriptions.create({

      file:
        fs.createReadStream(audio),

      model:
        process.env.TRANSCRIBE_MODEL ||
        "gpt-4o-mini-transcribe"

    });

  return result.text || "";
}


/* =========================================================
   EXTRACT FRAMES
========================================================= */

async function extractFrames(
  video,
  duration,
  workDir
) {

  const count =
    Math.min(
      16,
      Math.max(
        6,
        Math.ceil(duration / 20)
      )
    );

  const interval =
    duration / count;

  const frames = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {

    const time =
      Math.min(
        Math.max(0, duration - 0.2),
        i * interval
      );

    const output =
      path.join(
        workDir,
        `frame-${i}.jpg`
      );

    await exec(
      "ffmpeg",
      [
        "-y",

        "-ss",
        String(time),

        "-i",
        video,

        "-frames:v",
        "1",

        "-vf",
        "scale=640:-1",

        "-q:v",
        "4",

        output
      ]
    );

    frames.push({

      time,

      file: output,

      index: i

    });
  }

  return frames;
}


/* =========================================================
   IMAGE → DATA URL
========================================================= */

function imageToDataURL(file) {

  const data =
    fs.readFileSync(file);

  return (
    "data:image/jpeg;base64," +
    data.toString("base64")
  );
}


/* =========================================================
   LANGUAGE
========================================================= */

function languageName(language) {

  const languages = {

    en: "English",

    english: "English",

    my: "Burmese",

    burmese: "Burmese",

    ja: "Japanese",

    japanese: "Japanese",

    zh: "Chinese",

    chinese: "Chinese",

    ko: "Korean",

    korean: "Korean"

  };

  return (
    languages[
      String(language || "")
        .toLowerCase()
    ] || "English"
  );
}


/* =========================================================
   STYLE
========================================================= */

function styleDescription(style) {

  const styles = {

    cinematic:
      "cinematic, dramatic and emotional",

    documentary:
      "professional documentary style",

    fast:
      "fast-paced, energetic and engaging",

    storytelling:
      "natural storytelling style"

  };

  return (
    styles[style] ||
    styles.cinematic
  );
}


/* =========================================================
   AI VIDEO ANALYSIS
========================================================= */

async function analyzeVideo({

  frames,

  transcript,

  duration,

  target,

  language,

  style

}) {

  const outputLanguage =
    languageName(language);

  const styleText =
    styleDescription(style);

  const content = [];

  content.push({

    type: "input_text",

    text: `

You are an expert short-form video editor.

Analyze the provided video frames and transcript.

Original video duration:
${duration} seconds

Target recap duration:
${target} seconds

Output language:
${outputLanguage}

Style:
${styleText}

Transcript:
${String(transcript || "")
  .slice(0, 30000)}

Choose the most important and interesting moments.

Rules:

- Choose several non-overlapping scenes.
- Every scene must have start and end.
- Timestamps must be inside the original video.
- Prefer visually meaningful moments.
- Avoid empty or repetitive sections.
- Keep the selected scenes close to the target duration.
- The narration must match the selected scenes.
- Write the narration in ${outputLanguage}.
- Keep narration concise enough for the target duration.
- Return valid JSON only.

Required JSON:

{
  "title": "short title",
  "summary": "short summary",
  "narration": "short narration",
  "scenes": [
    {
      "start": 0,
      "end": 5,
      "reason": "why this scene matters"
    }
  ]
}

`

  });


  for (const frame of frames) {

    content.push({

      type: "input_text",

      text:
        `FRAME ${frame.index}
TIMESTAMP ${frame.time.toFixed(2)} seconds`

    });


    content.push({

      type: "input_image",

      image_url:
        imageToDataURL(
          frame.file
        ),

      detail: "low"

    });

  }


  const response =
    await openai.responses.create({

      model:
        VISION_MODEL,

      input: [

        {

          role: "user",

          content

        }

      ],

      text: {

        format: {

          type: "json_object"

        }

      }

    });


  const text =
    response.output_text || "";


  let result;

  try {

    result =
      JSON.parse(text);

  } catch {

    throw new Error(
      "AI returned invalid JSON."
    );

  }


  if (
    !result ||
    !Array.isArray(result.scenes)
  ) {

    throw new Error(
      "AI response does not contain scenes."
    );

  }


  return result;
}


/* =========================================================
   CLEAN / VALIDATE SCENES
========================================================= */

function normalizeScenes(
  scenes,
  sourceDuration,
  targetDuration
) {

  const valid = [];

  for (const scene of scenes || []) {

    let start =
      safeNumber(scene.start);

    let end =
      safeNumber(scene.end);

    start =
      Math.max(
        0,
        Math.min(
          start,
          sourceDuration
        )
      );

    end =
      Math.max(
        start + 0.5,
        Math.min(
          end,
          sourceDuration
        )
      );

    if (
      end > start &&
      start < sourceDuration
    ) {

      valid.push({

        start,

        end,

        reason:
          String(
            scene.reason || ""
          )

      });

    }

  }


  valid.sort(
    (a, b) =>
      a.start - b.start
  );


  const output = [];

  let total = 0;

  for (const scene of valid) {

    if (total >= targetDuration) {
      break;
    }

    const remaining =
      targetDuration - total;

    const sceneDuration =
      scene.end - scene.start;

    const take =
      Math.min(
        sceneDuration,
        remaining
      );

    if (take < 0.5) {
      continue;
    }

    output.push({

      start:
        scene.start,

      end:
        scene.start + take,

      reason:
        scene.reason

    });

    total += take;

  }


  if (!output.length) {

    throw new Error(
      "No valid scenes were returned by AI."
    );

  }


  return output;
}


/* =========================================================
   TTS
========================================================= */

async function createVoice(
  text,
  output,
  language,
  style
) {

  const languageText =
    languageName(language);

  const styleText =
    styleDescription(style);


  const speech =
    await openai.audio.speech.create({

      model:
        TTS_MODEL,

      voice:
        TTS_VOICE,

      input:
        String(text || "")
          .slice(0, 4096),

      instructions:
        `Speak naturally in ${languageText}.
Style: ${styleText}.
Clear, engaging short-form narrator voice.
Do not add extra words.`,

      response_format:
        "mp3"

    });


  const buffer =
    Buffer.from(
      await speech.arrayBuffer()
    );


  fs.writeFileSync(
    output,
    buffer
  );
}


/* =========================================================
   VIDEO FORMAT
========================================================= */

function videoFilter(format) {

  if (format === "16:9") {

    return [
      "scale=1280:720:force_original_aspect_ratio=increase",
      "crop=1280:720"
    ].join(",");

  }


  if (format === "1:1") {

    return [
      "scale=1080:1080:force_original_aspect_ratio=increase",
      "crop=1080:1080"
    ].join(",");

  }


  return [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920"
  ].join(",");
}


/* =========================================================
   CREATE CLIPS
========================================================= */

async function createClips(
  video,
  scenes,
  workDir,
  format
) {

  const clips = [];

  for (
    let i = 0;
    i < scenes.length;
    i++
  ) {

    const scene =
      scenes[i];

    const start =
      Math.max(
        0,
        safeNumber(scene.start)
      );

    const end =
      Math.max(
        start + 0.5,
        safeNumber(scene.end)
      );

    const output =
      path.join(
        workDir,
        `clip-${i}.mp4`
      );


    await exec(
      "ffmpeg",
      [
        "-y",

        "-ss",
        String(start),

        "-i",
        video,

        "-t",
        String(end - start),

        "-vf",
        videoFilter(format),

        "-an",

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "23",

        "-pix_fmt",
        "yuv420p",

        "-r",
        "30",

        output

      ]
    );


    clips.push(output);

  }


  return clips;
}


/* =========================================================
   CONCAT CLIPS
========================================================= */

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
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");


  fs.writeFileSync(
    listFile,
    content
  );


  try {

    await exec(
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

        output
      ]
    );

  } finally {

    try {
      fs.unlinkSync(listFile);
    } catch {}

  }

}


/* =========================================================
   ADD VOICE
========================================================= */

async function addVoice(
  video,
  voice,
  output
) {

  await exec(
    "ffmpeg",
    [
      "-y",

      "-i",
      video,

      "-i",
      voice,

      "-map",
      "0:v:0",

      "-map",
      "1:a:0",

      "-c:v",
      "copy",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-shortest",

      output

    ]
  );
}


/* =========================================================
   AUDIO DURATION
========================================================= */

async function getAudioDuration(file) {

  try {

    return await getDuration(file);

  } catch {

    return 0;

  }

}


/* =========================================================
   SUBTITLE FILE
========================================================= */

function createSRT(
  narration,
  duration,
  output
) {

  const sentences =
    String(narration || "")
      .split(
        /(?<=[.!?။])\s+/
      )
      .map(
        x => x.trim()
      )
      .filter(Boolean);


  if (!sentences.length) {
    return;
  }


  const segment =
    duration /
    sentences.length;


  function timecode(seconds) {

    const ms =
      Math.floor(
        (seconds % 1) * 1000
      );

    const total =
      Math.floor(seconds);

    const s =
      total % 60;

    const m =
      Math.floor(total / 60) % 60;

    const h =
      Math.floor(total / 3600);


    return (

      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0") +
      "," +
      String(ms).padStart(3, "0")

    );

  }


  let srt = "";


  sentences.forEach(
    (sentence, i) => {

      const start =
        i * segment;

      const end =
        Math.min(
          duration,
          (i + 1) * segment
        );


      srt +=
        `${i + 1}\n` +
        `${timecode(start)} --> ${timecode(end)}\n` +
        `${sentence}\n\n`;

    }
  );


  fs.writeFileSync(
    output,
    srt,
    "utf8"
  );

}


/* =========================================================
   ADD SUBTITLES
========================================================= */

async function addSubtitles(
  video,
  srt,
  output
) {

  const escaped =
    srt
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'");


  await exec(
    "ffmpeg",
    [
      "-y",

      "-i",
      video,

      "-vf",

      `subtitles='${escaped}':force_style='FontName=Arial,FontSize=18,Outline=2,Alignment=2,MarginV=80'`,

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "23",

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      output

    ]
  );
}


/* =========================================================
   CLEAN DIRECTORY
========================================================= */

function removeDirectory(dir) {

  try {

    fs.rmSync(
      dir,
      {
        recursive: true,
        force: true
      }
    );

  } catch {}

}


/* =========================================================
   MAIN PROCESS
========================================================= */

async function processRecap({

  jobId,

  video,

  durationTarget,

  format,

  language,

  style,

  subtitles = true,

  aiVoice = true

}) {

  const workDir =
    path.join(
      WORK_DIR,
      jobId
    );


  fs.mkdirSync(
    workDir,
    {
      recursive: true
    }
  );


  try {

    /* ---------------------------------------------
       1. READ VIDEO
    --------------------------------------------- */

    updateJob(
      jobId,
      {
        status: "processing",
        progress: 5,
        message: "Reading video..."
      }
    );


    const duration =
      await getDuration(video);


    if (duration < 1) {

      throw new Error(
        "Video is too short."
      );

    }


    /* ---------------------------------------------
       2. EXTRACT AUDIO
    --------------------------------------------- */

    updateJob(
      jobId,
      {
        progress: 12,
        message: "Extracting audio..."
      }
    );


    const audio =
      path.join(
        workDir,
        "audio.mp3"
      );


    await extractAudio(
      video,
      audio
    );


    /* ---------------------------------------------
       3. TRANSCRIBE
    --------------------------------------------- */

    updateJob(
      jobId,
      {
        progress: 25,
        message: "Transcribing audio..."
      }
    );


    const transcript =
      await transcribe(audio);


    /* ---------------------------------------------
       4. FRAMES
    --------------------------------------------- */

    updateJob(
      jobId,
      {
        progress: 38,
        message: "Extracting video frames..."
      }
    );


    const frames =
      await extractFrames(
        video,
        duration,
        workDir
      );


    /* ---------------------------------------------
       5. AI ANALYSIS
    --------------------------------------------- */

    updateJob(
      jobId,
      {
        progress: 52,
        message:
          "AI is selecting the best scenes..."
      }
    );


    const analysis =
      await analyzeVideo({

        frames,

        transcript,

        duration,

        target:
          Number(durationTarget),

        language,

        style

      });


    const scenes =
      normalizeScenes(
        analysis.scenes,
        duration,
        Number(durationTarget)
      );


    /* ---------------------------------------------
       6. CUT CLIPS
    --------------------------------------------- */

    updateJob(
      jobId,
      {
        progress: 65,
        message:
          "Cutting selected scenes..."
      }
    );


    const clips =
      await createClips(
        video,
        scenes,
        workDir,
        format
      );


    const rawRecap =
      path.join(
        workDir,
        "recap.mp4"
      );


    await concatClips(
      clips,
      rawRecap
    );


    let currentVideo =
      rawRecap;


    /* ---------------------------------------------
       7. AI VOICE
    --------------------------------------------- */

    if (aiVoice) {

      updateJob(
        jobId,
        {
          progress: 75,
          message:
            "Generating AI voice..."
        }
      );


      if (
        analysis.narration &&
        analysis.narration.trim()
      ) {

        const voice =
          path.join(
            workDir,
            "voice.mp3"
          );


        await createVoice(
          analysis.narration,
          voice,
          language,
          style
        );


        const narrated =
          path.join(
            workDir,
            "narrated.mp4"
          );


        await addVoice(
          currentVideo,
          voice,
          narrated
        );


        currentVideo =
          narrated;

      }

    }


    /* ---------------------------------------------
       8. SUBTITLES
    --------------------------------------------- */

    updateJob(
      jobId,
      {
        progress: 88,
        message:
          "Creating final video..."
      }
    );


    let finalFile =
      path.join(
        OUTPUT_DIR,
        `${jobId}.mp4`
      );


    if (
      subtitles &&
      analysis.narration &&
      analysis.narration.trim()
    ) {

      const srt =
        path.join(
          workDir,
          "subtitles.srt"
        );


      const subtitleDuration =
        aiVoice
          ? await getAudioDuration(
              path.join(
                workDir,
                "voice.mp3"
              )
            )
          : Number(durationTarget);


      createSRT(
        analysis.narration,
        Math.max(
          1,
          subtitleDuration ||
            Number(durationTarget)
        ),
        srt
      );


      await addSubtitles(
        currentVideo,
        srt,
        finalFile
      );

    } else {

      fs.copyFileSync(
        currentVideo,
        finalFile
      );

    }


    /* ---------------------------------------------
       9. COMPLETE
    --------------------------------------------- */

    updateJob(
      jobId,
      {

        status:
          "completed",

        progress:
          100,

        message:
          "Completed!",

        videoUrl:
          `/outputs/${jobId}.mp4`,

        script:
          analysis.narration || "",

        title:
          analysis.title || "Video Recap",

        summary:
          analysis.summary || ""

      }
    );


  } catch (error) {

    console.error(
      "JOB ERROR:",
      error
    );


    updateJob(
      jobId,
      {

        status:
          "failed",

        progress:
          0,

        message:
          error?.message ||
          "Failed",

        error:
          error?.message ||
          "Unknown error"

      }
    );


  } finally {

    /* Remove uploaded source */

    try {

      if (
        fs.existsSync(video)
      ) {
        fs.unlinkSync(video);
      }

    } catch {}


    /* Remove work files */

    removeDirectory(
      workDir
    );

  }

}


/* =========================================================
   CREATE RECAP
========================================================= */

app.post(
  "/api/recap",

  upload.single("video"),

  async (req, res) => {

    try {

      if (!req.file) {

        return res
          .status(400)
          .json({

            error:
              "Video is required."

          });

      }


      const duration =
        Number(
          req.body.duration || 60
        );


      const format =
        req.body.format ||
        "9:16";


      const language =
        req.body.language ||
        "en";


      const style =
        req.body.style ||
        "cinematic";


      const subtitles =
        String(
          req.body.subtitles ?? "true"
        ) !== "false";


      const aiVoice =
        String(
          req.body.aiVoice ?? "true"
        ) !== "false";


      if (
        ![30, 60, 90]
          .includes(duration)
      ) {

        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}


        return res
          .status(400)
          .json({

            error:
              "Duration must be 30, 60 or 90 seconds."

          });

      }


      if (
        ![
          "9:16",
          "16:9",
          "1:1"
        ].includes(format)
      ) {

        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}


        return res
          .status(400)
          .json({

            error:
              "Invalid video format."

          });

      }


      const jobId =
        createJob();


      res.json({

        jobId,

        status:
          "queued"

      });


      processRecap({

        jobId,

        video:
          req.file.path,

        durationTarget:
          duration,

        format,

        language,

        style,

        subtitles,

        aiVoice

      });

    } catch (error) {

      console.error(
        "CREATE ERROR:",
        error
      );


      if (req.file) {

        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}

      }


      return res
        .status(500)
        .json({

          error:
            error?.message ||
            "Server error."

        });

    }

  }
);


/* =========================================================
   JOB STATUS
========================================================= */

app.get(
  "/api/recap/status/:jobId",

  (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );


    if (!job) {

      return res
        .status(404)
        .json({

          error:
            "Job not found."

        });

    }


    res.json(job);

  }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/",
  (_req, res) => {

    res.json({

      ok: true,

      service:
        "OneClick Recap AI",

      version:
        "2.0.0",

      models: {

        vision:
          VISION_MODEL,

        transcription:
          process.env.TRANSCRIBE_MODEL ||
          "gpt-4o-mini-transcribe",

        tts:
          TTS_MODEL

      }

    });

  }
);


/* =========================================================
   404
========================================================= */

app.use(
  (_req, res) => {

    res
      .status(404)
      .json({

        error:
          "Route not found."

      });

  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, _req, res, _next) => {

    console.error(
      "SERVER ERROR:",
      error
    );


    let message =
      error?.message ||
      "Server error";


    if (
      error?.code ===
      "LIMIT_FILE_SIZE"
    ) {

      message =
        "Video file is too large. Maximum size is 500MB.";

    }


    res
      .status(500)
      .json({

        error:
          message

      });

  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `OneClick Recap running on port ${PORT}`
    );

    console.log(
      `Vision model: ${VISION_MODEL}`
    );

    console.log(
      `TTS model: ${TTS_MODEL}`
    );

  }
);
