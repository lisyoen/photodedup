export const PHOTODEDUP_GITHUB_PREFIX = "https://github.com/lisyoen/photodedup/";

export function isAllowedExternalUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith(PHOTODEDUP_GITHUB_PREFIX);
}

export async function openAllowedExternalUrl(
  url: unknown,
  openExternal: (url: string) => Promise<unknown>
): Promise<void> {
  if (!isAllowedExternalUrl(url)) {
    return;
  }
  await openExternal(url);
}
