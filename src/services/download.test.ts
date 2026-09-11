import { describe, it, expect } from "vitest";
import { parseNzbContent, formatSabnzbdTimeleft } from "./download";

describe("parseNzbContent", () => {
  it("should parse valid NZB content with filename and URL", () => {
    const nzbContent = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <!-- https://example.com/video.mp4 -->
  <file poster="RundfunkArr" subject='filename="Show.S01E01.720p.WEB.h264-GROUP.nzb"'>
    <segments></segments>
  </file>
</nzb>`;

    const result = parseNzbContent(nzbContent);

    expect(result).not.toBeNull();
    expect(result?.fileName).toBe("Show.S01E01.720p.WEB.h264-GROUP");
    expect(result?.url).toBe("https://example.com/video.mp4");
  });

  it("should parse filename with special characters", () => {
    const nzbContent = `filename="Der.Tatort.S2024E01.German.720p.WEB.h264-MEDiATHEK.nzb"
    <!-- https://example.com/video.mp4 -->`;

    const result = parseNzbContent(nzbContent);

    expect(result).not.toBeNull();
    expect(result?.fileName).toBe("Der.Tatort.S2024E01.German.720p.WEB.h264-MEDiATHEK");
  });

  it("should return null when filename is missing", () => {
    const nzbContent = `<!-- https://example.com/video.mp4 -->`;

    const result = parseNzbContent(nzbContent);

    expect(result).toBeNull();
  });

  it("should return null when URL is missing", () => {
    const nzbContent = `filename="Show.S01E01.nzb"`;

    const result = parseNzbContent(nzbContent);

    expect(result).toBeNull();
  });

  it("should return null for empty content", () => {
    const result = parseNzbContent("");

    expect(result).toBeNull();
  });

  it("should handle HTTP URLs", () => {
    const nzbContent = `filename="Show.nzb"
    <!-- http://example.com/video.mp4 -->`;

    const result = parseNzbContent(nzbContent);

    expect(result).not.toBeNull();
    expect(result?.url).toBe("http://example.com/video.mp4");
  });

  it("should handle URLs with query parameters", () => {
    const nzbContent = `filename="Show.nzb"
    <!-- https://example.com/video.mp4?token=abc123 -->`;

    const result = parseNzbContent(nzbContent);

    expect(result).not.toBeNull();
    // Note: The regex stops at whitespace, so query params with & would be cut off
    expect(result?.url).toBe("https://example.com/video.mp4?token=abc123");
  });
});

describe("formatSabnzbdTimeleft", () => {
  // Regression test: Radarr/Sonarr's SABnzbd client parser rejects any
  // timeleft value that isn't exactly "H:MM:SS" or "D:H:MM:SS". This used
  // to produce "M:SS" for anything under an hour, which made every queue
  // poll fail with "Expected either 0:0:0:0 or 0:0:0 format, but received:
  // 5:20" - so Radarr never saw a download as in-progress even while it
  // was genuinely downloading (confirmed live against a real Radarr log).

  it("always includes the hours component, even when zero", () => {
    expect(formatSabnzbdTimeleft(320)).toBe("0:05:20");
  });

  it("formats multi-hour durations correctly", () => {
    expect(formatSabnzbdTimeleft(3725)).toBe("1:02:05");
  });

  it("formats zero seconds as a valid three-part value", () => {
    expect(formatSabnzbdTimeleft(0)).toBe("0:00:00");
  });

  it("every output matches SABnzbd's expected H:MM:SS shape", () => {
    for (const seconds of [1, 59, 60, 3599, 3600, 86399]) {
      expect(formatSabnzbdTimeleft(seconds)).toMatch(/^\d+:\d{2}:\d{2}$/);
    }
  });
});
