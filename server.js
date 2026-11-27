import express from "express";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import util from "util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = util.promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT) || 3000;

const OUTPUT_DIR = path.join(process.cwd(), "generated_videos");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use("/videos", express.static(OUTPUT_DIR));

function sanitizeOverlayText(input) {
  return String(input || "TP Video")
    .replace(/[\r\n]+/g, " ")
    .replace(/[':%\\\[\]]/g, "")
    .trim()
    .slice(0, 65) || "TP Video";
}

function getPublicBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : (forwardedProto || req.protocol || "https").split(",")[0].trim();

  const forwardedHost = req.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : (forwardedHost || req.get("host") || `localhost:${PORT}`).split(",")[0].trim();

  return `${protocol}://${host}`;
}

function createMcpServer(publicBaseUrl) {
  const server = new Server(
    {
      name: "TP Videos Tool",
      version: "1.0.1",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "generate_tp_video",
          description:
            "Generates an MP4 video with AI voiceover and text overlay based on a video prompt and voice script.",
          inputSchema: {
            type: "object",
            properties: {
              video_prompt: {
                type: "string",
                description: "Visual description or title shown on the video.",
              },
              voice_script: {
                type: "string",
                description: "Spoken narration script for voiceover.",
              },
              voice_gender: {
                type: "string",
                enum: ["male", "female"],
                description: "Voiceover gender (default: female).",
              },
              duration_seconds: {
                type: "number",
                description: "Video length in seconds between 1 and 60 (default: 10).",
              },
              aspect_ratio: {
                type: "string",
                enum: ["16:9", "9:16", "1:1"],
                description: "Video aspect ratio (default: 16:9).",
              },
            },
            required: ["video_prompt", "voice_script"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "generate_tp_video") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const args = request.params.arguments || {};
    const videoPrompt = String(args.video_prompt || "Default scene");
    const voiceScript = String(args.voice_script || "").trim();
    const voiceGender = args.voice_gender === "male" ? "male" : "female";
    const rawDuration = Number(args.duration_seconds ?? 10);
    const duration = Number.isFinite(rawDuration)
      ? Math.min(Math.max(Math.round(rawDuration), 1), 60)
      : 10;
    const aspectRatio = ["16:9", "9:16", "1:1"].includes(args.aspect_ratio)
      ? args.aspect_ratio
      : "16:9";

    const timestamp = Date.now();
    const videoFileName = `tp_video_${timestamp}.mp4`;
    const audioFileName = `tp_voice_${timestamp}.mp3`;
    const outputVideoPath = path.join(OUTPUT_DIR, videoFileName);
    const outputAudioPath = path.join(OUTPUT_DIR, audioFileName);

    const resolutionMap = {
      "16:9": "1280x720",
      "9:16": "720x1280",
      "1:1": "720x720",
    };
    const resolution = resolutionMap[aspectRatio];

    try {
      let hasAudio = false;

      if (voiceScript.length > 0) {
        const voiceName =
          voiceGender === "male" ? "en-US-GuyNeural" : "en-US-JennyNeural";
        try {
          await execFileAsync(
            "edge-tts",
            [
              "--voice",
              voiceName,
              "--text",
              voiceScript,
              "--write-media",
              outputAudioPath,
            ],
            { timeout: 60000 }
          );
          hasAudio =
            fs.existsSync(outputAudioPath) &&
            fs.statSync(outputAudioPath).size > 0;
        } catch {
          hasAudio = false;
        }
      }

      const cleanText = sanitizeOverlayText(videoPrompt);
      const drawtextFilter = `drawtext=text='${cleanText}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2`;

      const ffmpegArgs = hasAudio
        ? [
            "-y",
            "-f",
            "lavfi",
            "-i",
            `color=c=0x111827:s=${resolution}:d=${duration}`,
            "-i",
            outputAudioPath,
            "-vf",
            drawtextFilter,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            outputVideoPath,
          ]
        : [
            "-y",
            "-f",
            "lavfi",
            "-i",
            `color=c=0x111827:s=${resolution}:d=${duration}`,
            "-vf",
            drawtextFilter,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            outputVideoPath,
          ];

      await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 120000 });

      if (fs.existsSync(outputAudioPath)) {
        fs.unlinkSync(outputAudioPath);
      }

      const downloadUrl = `${publicBaseUrl}/videos/${videoFileName}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                plugin: "TP Videos Tool",
                download_url: downloadUrl,
                details: {
                  video_prompt: videoPrompt,
                  voice_script: voiceScript,
                  voice_gender: voiceGender,
                  aspect_ratio: aspectRatio,
                  duration_seconds: duration,
                  audio_included: hasAudio,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (fs.existsSync(outputAudioPath)) {
        fs.unlinkSync(outputAudioPath);
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `TP Videos Tool Error: ${error.message}`,
          },
        ],
      };
    }
  });

  return server;
}

const transports = new Map();

app.get("/", (_req, res) => {
  res.status(200).json({
    name: "TP Videos Tool",
    status: "running",
    sse_endpoint: "/sse",
    messages_endpoint: "/messages",
  });
});

app.get("/sse", async (req, res) => {
  try {
    const publicBaseUrl = getPublicBaseUrl(req);
    const server = createMcpServer(publicBaseUrl);
    const transport = new SSEServerTransport("/messages", res);

    transports.set(transport.sessionId, transport);

    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.post("/messages", async (req, res) => {
  const sessionId =
    typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(400).statusMessage = "Invalid or expired sessionId";
    res.status(400).send("Invalid or expired sessionId");
    return;
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TP Videos Tool remote MCP server listening on port ${PORT}`);
});