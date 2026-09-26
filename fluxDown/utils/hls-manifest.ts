import type { HlsManifestKind, HlsVariantInfo } from "./resource-types";

export interface ParsedHlsManifest {
  kind: HlsManifestKind;
  variants: HlsVariantInfo[];
}

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  for (const match of raw.matchAll(re)) {
    const key = match[1].toUpperCase();
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attributes.set(key, value);
  }
  return attributes;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function labelForVariant(
  height: number | undefined,
  averageBandwidth: number | undefined,
  bandwidth: number | undefined,
  index: number,
): string {
  if (height) return `${height}p`;
  const bitrate = averageBandwidth || bandwidth;
  if (bitrate) return `${Math.round(bitrate / 1000)}kbps`;
  return `variant ${index + 1}`;
}

/** Parse only the master/media relationship; the native HLS engine owns downloading. */
export function parseHlsManifest(text: string, manifestUrl: string): ParsedHlsManifest | null {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!/^#EXTM3U(?:\r?\n|$)/.test(normalized)) return null;

  const lines = normalized.split(/\r?\n/);
  const variants: HlsVariantInfo[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
    let uri = "";
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith("#")) continue;
      uri = candidate;
      i = j;
      break;
    }
    if (!uri) continue;

    let url: string;
    try {
      url = new URL(uri, manifestUrl).href;
    } catch {
      continue;
    }

    const resolution = attrs.get("RESOLUTION")?.match(/^(\d+)x(\d+)$/i);
    const width = resolution ? positiveInt(resolution[1]) : undefined;
    const height = resolution ? positiveInt(resolution[2]) : undefined;
    const bandwidth = positiveInt(attrs.get("BANDWIDTH"));
    const averageBandwidth = positiveInt(attrs.get("AVERAGE-BANDWIDTH"));

    variants.push({
      url,
      label: labelForVariant(height, averageBandwidth, bandwidth, variants.length),
      bandwidth,
      averageBandwidth,
      width,
      height,
      codecs: attrs.get("CODECS") || undefined,
    });
  }

  if (variants.length > 0) {
    variants.sort((a, b) =>
      (b.height ?? 0) - (a.height ?? 0) ||
      (b.averageBandwidth ?? b.bandwidth ?? 0) - (a.averageBandwidth ?? a.bandwidth ?? 0),
    );
    return { kind: "master", variants };
  }

  if (
    normalized.includes("#EXTINF:") ||
    normalized.includes("#EXT-X-TARGETDURATION:") ||
    normalized.includes("#EXT-X-MEDIA-SEQUENCE:")
  ) {
    return { kind: "media", variants: [] };
  }

  return null;
}
