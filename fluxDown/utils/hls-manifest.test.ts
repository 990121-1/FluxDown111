import { describe, expect, test } from "bun:test";
import { parseHlsManifest } from "./hls-manifest";

describe("parseHlsManifest", () => {
  test("parses an HLS master playlist and resolves relative child URLs", () => {
    const parsed = parseHlsManifest(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1352472,AVERAGE-BANDWIDTH=789338,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360
360p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1989416,AVERAGE-BANDWIDTH=1186354,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=854x480
480p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3437016,AVERAGE-BANDWIDTH=2073888,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720
720p/video.m3u8
`, "https://cdn.example.com/video/playlist.m3u8");

    expect(parsed?.kind).toBe("master");
    expect(parsed?.variants.map((variant) => variant.label)).toEqual(["720p", "480p", "360p"]);
    expect(parsed?.variants[0].url).toBe("https://cdn.example.com/video/720p/video.m3u8");
    expect(parsed?.variants[0].codecs).toBe("avc1.64001f,mp4a.40.2");
  });

  test("recognizes a media playlist without pretending it is a master", () => {
    const parsed = parseHlsManifest(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4.0,
video0.jpeg
`, "https://cdn.example.com/video/720p/video.m3u8");

    expect(parsed).toEqual({ kind: "media", variants: [] });
  });
});
