import { prisma } from "@/lib/db";
import { randomUUID } from "crypto";
import * as path from "path";

/**
 * Format seconds remaining as SABnzbd's strict "H:MM:SS" timeleft format.
 * Radarr/Sonarr's SABnzbd client parser rejects anything else (including
 * "M:SS" for under an hour, or a free-text placeholder) with
 * "Expected either 0:0:0:0 or 0:0:0 format, but received: ..." - which
 * makes every queue poll fail, so they never see an in-progress download
 * even while it's genuinely downloading. Always emit the full form.
 */
export function formatSabnzbdTimeleft(secondsLeft: number): string {
  const hours = Math.floor(secondsLeft / 3600);
  const minutes = Math.floor((secondsLeft % 3600) / 60);
  const seconds = secondsLeft % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export interface QueueItem {
  nzo_id: string;
  filename: string;
  status: string;
  percentage: string;
  timeleft: string;
  cat: string;
  mb: string;
  mbleft: string;
  speed: string;
}

export interface HistoryItem {
  nzo_id: string;
  name: string;
  status: string;
  completed: number;
  category: string;
  storage: string;
  bytes: number;
  fail_message: string;
}

export interface SabnzbdQueue {
  slots: QueueItem[];
}

export interface SabnzbdHistory {
  slots: HistoryItem[];
}

// Extract filename and URL from NZB content
const FILE_NAME_REGEX = /filename="([^"]+)\.nzb"/;
// The URL used to be embedded raw inside an XML comment
// (<!-- https://... -->), which broke for any source URL containing "--"
// (illegal inside an XML comment - confirmed live against a real ORF CDN
// URL, ".../BOesterreich--6_...", which Sonarr's own XML validation
// rejected outright before the file ever reached this parser). The
// generator (app/api/newznab/fake_nzb_download/route.ts) now embeds the
// still-base64-encoded value instead, so this decodes each comment and
// picks whichever one is actually a URL - order-independent, and matches
// the older single-comment format from before a title comment was added
// too (fileName still comes from the multipart upload's own filename, not
// from a comment).
const COMMENT_REGEX = /<!--\s*([A-Za-z0-9+/=]+)\s*-->/g;

export function parseNzbContent(nzbContent: string): { fileName: string; url: string } | null {
  const filenameMatch = nzbContent.match(FILE_NAME_REGEX);
  if (!filenameMatch) {
    return null;
  }

  let url: string | null = null;
  for (const match of nzbContent.matchAll(COMMENT_REGEX)) {
    let decoded: string;
    try {
      decoded = Buffer.from(match[1], "base64").toString("utf-8");
    } catch {
      continue;
    }
    if (/^https?:\/\//.test(decoded)) {
      url = decoded;
      break;
    }
  }

  if (!url) {
    return null;
  }

  return {
    fileName: filenameMatch[1],
    url,
  };
}

export async function addToQueue(
  url: string,
  title: string,
  category: string
): Promise<{ id: string }> {
  const download = await prisma.download.create({
    data: {
      id: randomUUID(),
      title,
      url,
      category,
      status: "queued",
      progress: 0,
    },
  });

  // Trigger download processing asynchronously
  // Import dynamically to avoid circular dependencies and ensure server-side only
  triggerDownloadProcessing();

  return { id: download.id };
}

// Trigger download processing without blocking
function triggerDownloadProcessing(): void {
  // Use dynamic import to load the download manager only on server-side
  import("@/server/download-manager")
    .then(({ startDownloadProcessing }) => {
      startDownloadProcessing().catch(console.error);
    })
    .catch((err) => {
      console.error("Failed to load download manager:", err);
    });
}

export async function getQueue(): Promise<SabnzbdQueue> {
  const downloads = await prisma.download.findMany({
    where: {
      status: { in: ["queued", "downloading", "converting"] },
    },
    orderBy: { createdAt: "asc" },
  });

  const slots: QueueItem[] = downloads.map((d) => {
    let statusText = "Queued";
    if (d.status === "downloading") statusText = "Downloading";
    else if (d.status === "converting") statusText = "Extracting";

    // Convert BigInt to Number for arithmetic operations
    const totalSizeNum = Number(d.totalSize);
    const downloadedBytesNum = Number(d.downloadedBytes);
    const speedNum = Number(d.speed);

    const totalMb = (totalSizeNum / 1024 / 1024).toFixed(1);
    const remainingBytes = totalSizeNum - downloadedBytesNum;
    const speedMbps = (speedNum / 1024 / 1024).toFixed(1);

    const timeleft =
      d.status === "downloading" && speedNum > 0
        ? formatSabnzbdTimeleft(Math.round(remainingBytes / speedNum))
        : "0:00:00";

    return {
      nzo_id: d.id,
      filename: d.title,
      status: statusText,
      percentage: d.progress.toString(),
      timeleft,
      cat: d.category,
      mb: totalMb,
      mbleft: (remainingBytes / 1024 / 1024).toFixed(1),
      speed: d.status === "downloading" ? `${speedMbps} MB/s` : "",
    };
  });

  return { slots };
}

export async function getHistory(): Promise<SabnzbdHistory> {
  const downloads = await prisma.download.findMany({
    where: {
      status: { in: ["completed", "failed"] },
    },
    orderBy: { completedAt: "desc" },
  });

  const slots: HistoryItem[] = downloads.map((d) => {
    // SABnzbd returns the folder path, not the file path
    // Sonarr scans this folder for video files
    let storagePath = "";
    if (d.filePath) {
      storagePath = path.dirname(d.filePath);
    }

    return {
      nzo_id: d.id,
      name: d.title,
      status: d.status === "completed" ? "Completed" : "Failed",
      completed: d.completedAt ? Math.floor(d.completedAt.getTime() / 1000) : 0,
      category: d.category,
      storage: storagePath,
      bytes: Number(d.size),
      fail_message: d.error || "",
    };
  });

  return { slots };
}

export async function deleteHistoryItem(nzoId: string, delFiles: boolean): Promise<boolean> {
  const download = await prisma.download.findUnique({
    where: { id: nzoId },
  });

  if (!download) {
    return false;
  }

  // Delete the file if requested
  if (delFiles && download.filePath) {
    try {
      const fs = await import("fs/promises");
      await fs.unlink(download.filePath);
    } catch {
      // File might not exist, ignore error
    }
  }

  await prisma.download.delete({
    where: { id: nzoId },
  });

  return true;
}

export async function retryDownload(nzoId: string): Promise<{ id: string } | null> {
  const download = await prisma.download.findUnique({
    where: { id: nzoId },
  });

  if (!download) {
    return null;
  }

  // Delete the old entry
  await prisma.download.delete({
    where: { id: nzoId },
  });

  // Re-add to queue
  return addToQueue(download.url, download.title, download.category);
}

export async function getConfigResponse(): Promise<object> {
  const { getSetting } = await import("@/lib/settings");
  const downloadPath =
    (await getSetting("download.path")) || process.env.DOWNLOAD_FOLDER_PATH || "/downloads";

  return {
    config: {
      misc: {
        complete_dir: downloadPath,
        enable_tv_sorting: false,
        enable_movie_sorting: false,
        pre_check: false,
        history_retention: "-1",
        history_retention_option: "all",
      },
      categories: [
        { name: "sonarr", pp: "", script: "Default", dir: "", priority: -100 },
        { name: "tv", pp: "", script: "Default", dir: "", priority: -100 },
        { name: "radarr", pp: "", script: "Default", dir: "", priority: -100 },
        { name: "movies", pp: "", script: "Default", dir: "", priority: -100 },
        { name: "sonarr_blackhole", pp: "", script: "Default", dir: "", priority: -100 },
        { name: "radarr_blackhole", pp: "", script: "Default", dir: "", priority: -100 },
      ],
      sorters: [],
    },
  };
}
