import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import type { FileReference, UploadLimits } from "./types.js";
import { IngestError } from "./types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const USER_AGENT = "pentaho-to-aws/1.0";

export interface DownloadOptions {
  allowlist: string[];
  limits: UploadLimits;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(address: string): number[] | undefined {
  const stripped = address.split("%")[0]?.toLowerCase() ?? "";
  if (stripped === "::") return [0, 0, 0, 0, 0, 0, 0, 0];
  if (stripped === "::1") return [0, 0, 0, 0, 0, 0, 0, 1];
  const halves = stripped.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
  const expand = (groups: string[]): number[] | undefined => {
    const result: number[] = [];
    for (const group of groups) {
      if (group === "") return undefined;
      if (group.includes(".")) {
        const v4 = group.split(".").map(Number);
        if (
          v4.length !== 4 ||
          v4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
        ) {
          return undefined;
        }
        result.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
        result.push(Number.parseInt(group, 16));
      }
    }
    return result;
  };
  const leftGroups = expand(left);
  const rightGroups = expand(right);
  if (!leftGroups || !rightGroups) return undefined;
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (missing < 0) return undefined;
  return [...leftGroups, ...Array.from({ length: missing }, () => 0), ...rightGroups];
}

function isPrivateIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;
  const [first = 0, second = 0] = groups;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible addresses.
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    const embedded = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 255}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 255}`;
    return isPrivateIpv4(embedded);
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function hostAllowed(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

async function resolvePublicAddress(hostname: string): Promise<string> {
  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new IngestError(
      `Could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (addresses.length === 0) throw new IngestError(`Could not resolve ${hostname}.`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new IngestError(
        `Refusing to download from ${hostname}: it resolves to a private or reserved address.`,
      );
    }
  }
  return addresses[0]?.address ?? "";
}

function validateUrl(input: string, allowlist: string[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new IngestError(`"${input}" is not a valid download URL.`);
  }
  if (url.protocol !== "https:") {
    throw new IngestError("Project files must be downloaded over HTTPS.");
  }
  if (url.username || url.password) {
    throw new IngestError("Download URLs must not contain credentials.");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new IngestError("Download URLs must use the default HTTPS port.");
  }
  if (!hostAllowed(url.hostname, allowlist)) {
    throw new IngestError(
      `Refusing to download from ${url.hostname}; it is not in FILE_HOST_ALLOWLIST.`,
    );
  }
  return url;
}

interface ResponseData {
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
}

async function requestOnce(
  url: URL,
  address: string,
  limits: UploadLimits,
  redirectCount: number,
  allowlist: string[],
  deadline: number,
): Promise<ResponseData> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new IngestError(
      `Download timed out after ${Math.round(limits.downloadTimeoutMs / 1000)} seconds.`,
    );
  }
  return await new Promise<ResponseData>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: ResponseData) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const family = isIP(address) === 6 ? 6 : 4;
      if (options.all) {
        callback(null, [{ address, family }]);
        return;
      }
      callback(null, address, family);
    };
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/octet-stream, application/xml, text/xml, text/plain, */*",
          "User-Agent": USER_AGENT,
        },
        lookup,
        servername: url.hostname,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
          response.resume();
          const location = response.headers.location;
          if (typeof location !== "string") {
            finish(new IngestError("Download redirect did not include a Location header."));
            return;
          }
          if (redirectCount >= MAX_REDIRECTS) {
            finish(new IngestError("Download redirected too many times."));
            return;
          }
          let next: URL;
          try {
            next = validateUrl(new URL(location, url).toString(), allowlist);
          } catch (error) {
            finish(
              error instanceof IngestError
                ? error
                : new IngestError("Download redirected to an unsafe URL."),
            );
            return;
          }
          void resolvePublicAddress(next.hostname)
            .then((nextAddress) =>
              requestOnce(next, nextAddress, limits, redirectCount + 1, allowlist, deadline),
            )
            .then(
              (value) => finish(undefined, value),
              (error: unknown) => finish(error as Error),
            );
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish(new IngestError(`Download failed with HTTP ${status}.`));
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > limits.maxDownloadBytes) {
          response.resume();
          finish(
            new IngestError(
              `File is larger than the ${Math.floor(limits.maxDownloadBytes / (1024 * 1024))} MB download limit.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > limits.maxDownloadBytes) {
            response.destroy();
            finish(
              new IngestError(
                `File is larger than the ${Math.floor(limits.maxDownloadBytes / (1024 * 1024))} MB download limit.`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish(undefined, {
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", (error) => finish(error));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(
        new IngestError(
          `Download timed out after ${Math.round(limits.downloadTimeoutMs / 1000)} seconds.`,
        ),
      );
    }, remaining);
    timer.unref();
    req.on("error", (error) => finish(error));
    req.end();
  });
}

export async function downloadProjectFile(
  file: FileReference,
  options: DownloadOptions,
): Promise<{ data: Uint8Array; fileName: string }> {
  const url = validateUrl(file.download_url, options.allowlist);
  const address = await resolvePublicAddress(url.hostname);
  const response = await requestOnce(
    url,
    address,
    options.limits,
    0,
    options.allowlist,
    Date.now() + options.limits.downloadTimeoutMs,
  );
  if (response.body.length > options.limits.maxDownloadBytes) {
    throw new IngestError("Downloaded file exceeded the size limit.");
  }
  const contentType = String(response.headers["content-type"] ?? "");
  const fileName =
    file.file_name?.trim() ||
    decodeURIComponent(url.pathname.split("/").pop() || "uploaded-project") ||
    "uploaded-project";
  if (contentType.includes("text/html")) {
    throw new IngestError("The download URL returned HTML instead of a project file.");
  }
  return { data: new Uint8Array(response.body), fileName };
}
